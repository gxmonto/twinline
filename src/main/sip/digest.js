'use strict';
/**
 * HTTP Digest authentication for SIP (RFC 3261 §22, RFC 2617, RFC 8760).
 *
 * Supports MD5, MD5-sess, SHA-256 and SHA-256-sess with and without
 * `qop=auth`. `qop=auth-int` is accepted and computed over the body.
 */

const crypto = require('crypto');
const { parseAuthHeader, stringifyAuthHeader } = require('./parser');

const ALGORITHMS = {
  'md5': 'md5',
  'md5-sess': 'md5',
  'sha-256': 'sha256',
  'sha-256-sess': 'sha256',
  'sha-512-256': 'sha512-256',
  'sha-512-256-sess': 'sha512-256',
};

function hash(algorithm, data) {
  const nodeAlg = ALGORITHMS[algorithm] || 'md5';
  // Node exposes SHA-512/256 as 'sha512-256' on OpenSSL 3; fall back if absent.
  try {
    return crypto.createHash(nodeAlg).update(data, 'binary').digest('hex');
  } catch {
    return crypto.createHash('md5').update(data, 'binary').digest('hex');
  }
}

function isSession(algorithm) {
  return algorithm.endsWith('-sess');
}

/**
 * Choose the strongest challenge we understand when a server sends several.
 */
function selectChallenge(challenges) {
  const rank = { 'sha-512-256': 3, 'sha-512-256-sess': 3, 'sha-256': 2, 'sha-256-sess': 2, 'md5': 1, 'md5-sess': 1 };
  let best = null, bestRank = -1;
  for (const c of challenges) {
    if (String(c.scheme).toLowerCase() !== 'digest') continue;
    const alg = String(c.params.algorithm || 'MD5').toLowerCase();
    if (!(alg in ALGORITHMS)) continue;
    const r = rank[alg] ?? 0;
    if (r > bestRank) { best = c; bestRank = r; }
  }
  return best;
}

/**
 * Build the credential parameters for a challenge.
 *
 * @param {object} opts
 * @param {object} opts.challenge  parsed { scheme, params } challenge
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string} opts.method     SIP method of the request being authorised
 * @param {string} opts.uri        the Request-URI, as a string
 * @param {string} [opts.body]     message body (only used for auth-int)
 * @param {number} [opts.nc]       nonce count, defaults to 1
 * @param {string} [opts.cnonce]   client nonce, generated when omitted
 */
function createCredential(opts) {
  const { challenge, username, password, method, uri, body = '' } = opts;
  const p = challenge.params;
  const algorithm = String(p.algorithm || 'MD5').toLowerCase();
  const realm = p.realm || '';
  const nonce = p.nonce || '';
  const cnonce = opts.cnonce || crypto.randomBytes(8).toString('hex');
  const nc = String(opts.nc == null ? 1 : opts.nc).padStart(8, '0');

  // Pick a qop we support, preferring plain `auth`.
  let qop = null;
  if (p.qop != null) {
    const offered = String(p.qop).split(',').map((s) => s.trim().toLowerCase());
    if (offered.includes('auth')) qop = 'auth';
    else if (offered.includes('auth-int')) qop = 'auth-int';
  }

  let ha1 = hash(algorithm, `${username}:${realm}:${password}`);
  if (isSession(algorithm)) ha1 = hash(algorithm, `${ha1}:${nonce}:${cnonce}`);

  let ha2;
  if (qop === 'auth-int') {
    ha2 = hash(algorithm, `${method}:${uri}:${hash(algorithm, body)}`);
  } else {
    ha2 = hash(algorithm, `${method}:${uri}`);
  }

  const response = qop
    ? hash(algorithm, `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(algorithm, `${ha1}:${nonce}:${ha2}`);

  const params = {
    username,
    realm,
    nonce,
    uri,
    response,
    algorithm: p.algorithm || 'MD5',
  };
  if (qop) { params.qop = qop; params.nc = nc; params.cnonce = cnonce; }
  if (p.opaque != null) params.opaque = p.opaque;

  return { scheme: 'Digest', params, qopQuoted: false };
}

/**
 * Tracks credentials and nonce counts for one account so that repeated
 * challenges from the same realm reuse the nonce with an incrementing nc,
 * and so that requests can be pre-authorised after the first success.
 */
class DigestStore {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    /** @type {Map<string, {challenge: object, nc: number, cnonce: string, proxy: boolean}>} */
    this.realms = new Map();
  }

  setCredentials(username, password) {
    if (username !== this.username || password !== this.password) {
      this.username = username;
      this.password = password;
      this.realms.clear();
    }
  }

  /**
   * Absorb the challenges from a 401/407 response.
   * @returns {boolean} true when at least one usable challenge was stored
   */
  addChallenges(response) {
    const entries = [
      ...(response.headers['www-authenticate'] || []).map((h) => ({ raw: h, proxy: false })),
      ...(response.headers['proxy-authenticate'] || []).map((h) => ({ raw: h, proxy: true })),
    ];
    const byProxy = { true: [], false: [] };
    for (const e of entries) {
      const parsed = parseAuthHeader(e.raw);
      parsed.proxy = e.proxy;
      byProxy[String(e.proxy)].push(parsed);
    }

    let stored = false;
    for (const proxy of [false, true]) {
      const chosen = selectChallenge(byProxy[String(proxy)]);
      if (!chosen) continue;
      const key = `${proxy ? 'proxy' : 'ua'}:${chosen.params.realm || ''}`;
      const existing = this.realms.get(key);
      if (existing && existing.challenge.params.nonce === chosen.params.nonce) {
        existing.nc += 1;                     // stale replay against same nonce
      } else {
        this.realms.set(key, {
          challenge: chosen,
          nc: 1,
          cnonce: crypto.randomBytes(8).toString('hex'),
          proxy,
        });
      }
      stored = true;
    }
    return stored;
  }

  /** True when we hold a challenge that has not yet been consumed. */
  get hasChallenges() {
    return this.realms.size > 0;
  }

  /**
   * Apply stored credentials to an outgoing request, replacing any that are
   * already present. Increments the nonce count for each realm used.
   */
  authorize(request, { method, uri, body = '' }) {
    if (!this.realms.size) return false;
    delete request.headers.authorization;
    delete request.headers['proxy-authorization'];

    for (const entry of this.realms.values()) {
      const credential = createCredential({
        challenge: entry.challenge,
        username: this.username,
        password: this.password,
        method,
        uri,
        body,
        nc: entry.nc,
        cnonce: entry.cnonce,
      });
      const header = entry.proxy ? 'proxy-authorization' : 'authorization';
      if (!request.headers[header]) request.headers[header] = [];
      request.headers[header].push(stringifyAuthHeader(credential));
      entry.nc += 1;
    }
    return true;
  }

  /** Forget everything (e.g. after credentials change or a 403). */
  clear() {
    this.realms.clear();
  }
}

module.exports = { createCredential, selectChallenge, DigestStore, hash };
