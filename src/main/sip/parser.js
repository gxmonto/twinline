'use strict';
/**
 * SIP message parsing and serialisation (RFC 3261 §7, §20, §25).
 *
 * Messages are represented as:
 *   { method, uri, version, headers, body }          for requests
 *   { version, status, reason, headers, body }       for responses
 *
 * `headers` is a plain object keyed by the lower-case long-form header name.
 * Each value is an array of raw header value strings, in the order received.
 * Multiple comma-separated values of a list header are split into separate
 * entries so that e.g. `Via` stacks behave predictably.
 */

const COMPACT = {
  a: 'accept-contact',
  b: 'referred-by',
  c: 'content-type',
  d: 'request-disposition',
  e: 'content-encoding',
  f: 'from',
  i: 'call-id',
  j: 'reject-contact',
  k: 'supported',
  l: 'content-length',
  m: 'contact',
  n: 'identity-info',
  o: 'event',
  r: 'refer-to',
  s: 'subject',
  t: 'to',
  u: 'allow-events',
  v: 'via',
  x: 'session-expires',
  y: 'identity',
};

// Headers whose values must never be comma-split (they may contain commas
// inside quoted strings or are simply opaque).
const NO_SPLIT = new Set([
  'call-id', 'subject', 'to', 'from', 'cseq', 'max-forwards', 'expires',
  'content-length', 'content-type', 'content-disposition', 'user-agent',
  'server', 'organization', 'reason', 'date', 'retry-after', 'priority',
  'session-expires', 'min-se', 'rseq', 'timestamp', 'mime-version',
  'authorization', 'proxy-authorization', 'www-authenticate',
  'proxy-authenticate', 'authentication-info', 'refer-to', 'referred-by',
  'p-asserted-identity', 'remote-party-id', 'p-preferred-identity',
]);

const CANONICAL = {
  'call-id': 'Call-ID',
  'cseq': 'CSeq',
  'www-authenticate': 'WWW-Authenticate',
  'mime-version': 'MIME-Version',
  'min-se': 'Min-SE',
  'rseq': 'RSeq',
  'rack': 'RAck',
  'sip-etag': 'SIP-ETag',
  'sip-if-match': 'SIP-If-Match',
};

/** Title-case a lower-case header name for the wire. */
function canonicalName(lower) {
  if (CANONICAL[lower]) return CANONICAL[lower];
  return lower.replace(/(^|-)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * Split `s` on `sep`, ignoring separators that appear inside double quotes,
 * angle brackets, parentheses or square brackets (IPv6 references).
 */
function safeSplit(s, sep) {
  const out = [];
  let depthAngle = 0, depthParen = 0, depthBracket = 0;
  let inQuote = false, escaped = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (inQuote) {
      if (c === '\\') escaped = true;
      else if (c === '"') inQuote = false;
      continue;
    }
    switch (c) {
      case '"': inQuote = true; break;
      case '<': depthAngle++; break;
      case '>': if (depthAngle > 0) depthAngle--; break;
      case '(': depthParen++; break;
      case ')': if (depthParen > 0) depthParen--; break;
      case '[': depthBracket++; break;
      case ']': if (depthBracket > 0) depthBracket--; break;
      default:
        if (c === sep && !depthAngle && !depthParen && !depthBracket) {
          out.push(s.slice(start, i));
          start = i + 1;
        }
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Parse `;a=b;c` parameter lists into an object. Valueless params map to null. */
function parseParams(s) {
  const params = {};
  if (!s) return params;
  for (const part of safeSplit(s, ';')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq === -1) {
      params[piece.toLowerCase()] = null;
    } else {
      const name = piece.slice(0, eq).trim().toLowerCase();
      let value = piece.slice(eq + 1).trim();
      if (value.length > 1 && value[0] === '"' && value[value.length - 1] === '"') {
        value = value.slice(1, -1).replace(/\\(.)/g, '$1');
      }
      params[name] = value;
    }
  }
  return params;
}

function stringifyParams(params) {
  let out = '';
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined) continue;
    out += v === null ? `;${k}` : `;${k}=${v}`;
  }
  return out;
}

/**
 * Parse a SIP or TEL URI.
 * Returns { scheme, user, password, host, port, params, headers }.
 */
function parseUri(str) {
  const s = String(str || '').trim();
  const colon = s.indexOf(':');
  if (colon === -1) return { scheme: 'sip', user: null, host: s, port: null, params: {}, headers: {} };

  const scheme = s.slice(0, colon).toLowerCase();
  let rest = s.slice(colon + 1);

  let headers = {};
  const q = rest.indexOf('?');
  if (q !== -1) {
    for (const pair of rest.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      headers[decodeURIComponent(pair.slice(0, eq)).toLowerCase()] = decodeURIComponent(pair.slice(eq + 1));
    }
    rest = rest.slice(0, q);
  }

  let paramStr = '';
  const semi = rest.indexOf(';');
  if (semi !== -1) { paramStr = rest.slice(semi + 1); rest = rest.slice(0, semi); }

  let user = null, password = null;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const userinfo = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const pc = userinfo.indexOf(':');
    if (pc === -1) user = decodeURIComponent(userinfo);
    else { user = decodeURIComponent(userinfo.slice(0, pc)); password = userinfo.slice(pc + 1); }
  }

  let host = rest, port = null;
  if (host.startsWith('[')) {                       // IPv6 reference
    const close = host.indexOf(']');
    if (close !== -1) {
      const after = host.slice(close + 1);
      host = host.slice(0, close + 1);
      if (after.startsWith(':')) port = parseInt(after.slice(1), 10);
    }
  } else {
    const pc = host.lastIndexOf(':');
    if (pc !== -1) { port = parseInt(host.slice(pc + 1), 10); host = host.slice(0, pc); }
  }
  if (Number.isNaN(port)) port = null;

  return { scheme, user, password, host, port, params: parseParams(paramStr), headers };
}

function stringifyUri(uri) {
  if (typeof uri === 'string') return uri;
  let out = `${uri.scheme || 'sip'}:`;
  if (uri.user) {
    out += encodeURIComponent(uri.user).replace(/%2B/gi, '+');
    if (uri.password) out += `:${uri.password}`;
    out += '@';
  }
  out += uri.host;
  if (uri.port) out += `:${uri.port}`;
  out += stringifyParams(uri.params);
  const hk = Object.keys(uri.headers || {});
  if (hk.length) {
    out += '?' + hk.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(uri.headers[k])}`).join('&');
  }
  return out;
}

/**
 * Parse a name-addr / addr-spec with trailing header parameters, e.g.
 *   "Bob" <sip:bob@example.com;transport=tcp>;tag=9fxced76sl
 * Returns { name, uri, params } where `uri` is a parsed URI object.
 */
function parseNameAddr(str) {
  let s = String(str || '').trim();
  let name = null;

  if (s.startsWith('"')) {
    let i = 1, buf = '';
    while (i < s.length) {
      if (s[i] === '\\') { buf += s[i + 1] ?? ''; i += 2; continue; }
      if (s[i] === '"') break;
      buf += s[i++];
    }
    name = buf;
    s = s.slice(i + 1).trim();
  }

  const lt = s.indexOf('<');
  if (lt !== -1) {
    if (name === null) {
      const bare = s.slice(0, lt).trim();
      if (bare) name = bare;
    }
    const gt = s.indexOf('>', lt);
    const uriStr = s.slice(lt + 1, gt === -1 ? undefined : gt);
    const paramStr = gt === -1 ? '' : s.slice(gt + 1).trim().replace(/^;/, '');
    return { name, uri: parseUri(uriStr), params: parseParams(paramStr) };
  }

  // addr-spec form: parameters after the first ';' belong to the header,
  // not to the URI (RFC 3261 §20 note on ambiguity).
  const semi = s.indexOf(';');
  if (semi === -1) return { name, uri: parseUri(s), params: {} };
  return { name, uri: parseUri(s.slice(0, semi)), params: parseParams(s.slice(semi + 1)) };
}

function stringifyNameAddr(na) {
  let out = '';
  if (na.name) out += `"${String(na.name).replace(/(["\\])/g, '\\$1')}" `;
  out += `<${stringifyUri(na.uri)}>`;
  out += stringifyParams(na.params);
  return out;
}

/** Parse one Via value: SIP/2.0/UDP host:port;branch=... */
function parseVia(str) {
  const s = String(str).trim();
  const sp = s.search(/\s/);
  const proto = s.slice(0, sp);
  let rest = s.slice(sp).trim();
  let paramStr = '';
  const semi = rest.indexOf(';');
  if (semi !== -1) { paramStr = rest.slice(semi + 1); rest = rest.slice(0, semi).trim(); }

  let host = rest, port = null;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    const after = host.slice(close + 1);
    host = host.slice(0, close + 1);
    if (after.startsWith(':')) port = parseInt(after.slice(1), 10);
  } else {
    const pc = host.lastIndexOf(':');
    if (pc !== -1) { port = parseInt(host.slice(pc + 1), 10); host = host.slice(0, pc); }
  }
  const parts = proto.split('/');
  return {
    protocol: parts[0] || 'SIP',
    version: parts[1] || '2.0',
    transport: (parts[2] || 'UDP').toUpperCase(),
    host,
    port: Number.isNaN(port) ? null : port,
    params: parseParams(paramStr),
  };
}

function stringifyVia(via) {
  let out = `${via.protocol || 'SIP'}/${via.version || '2.0'}/${via.transport} ${via.host}`;
  if (via.port) out += `:${via.port}`;
  return out + stringifyParams(via.params);
}

function parseCSeq(str) {
  const m = /^\s*(\d+)\s+(\S+)/.exec(String(str));
  return m ? { seq: parseInt(m[1], 10), method: m[2].toUpperCase() } : { seq: 0, method: '' };
}

/**
 * Parse an Authorization / WWW-Authenticate style header into
 * { scheme, params }.
 */
function parseAuthHeader(str) {
  const s = String(str).trim();
  const sp = s.search(/\s/);
  if (sp === -1) return { scheme: s, params: {} };
  const scheme = s.slice(0, sp);
  const params = {};
  for (const part of safeSplit(s.slice(sp + 1), ',')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq === -1) { params[piece.toLowerCase()] = null; continue; }
    const name = piece.slice(0, eq).trim().toLowerCase();
    let value = piece.slice(eq + 1).trim();
    if (value.length > 1 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    params[name] = value;
  }
  return { scheme, params };
}

const QUOTED_AUTH_PARAMS = new Set([
  'username', 'realm', 'nonce', 'uri', 'response', 'cnonce', 'opaque', 'domain', 'qop-options',
]);

function stringifyAuthHeader(auth) {
  const parts = [];
  for (const [k, v] of Object.entries(auth.params)) {
    if (v === null || v === undefined) continue;
    // `qop` is quoted in a challenge but bare in a credential; the caller
    // controls that by passing `qopQuoted`.
    const quote = QUOTED_AUTH_PARAMS.has(k) || (k === 'qop' && auth.qopQuoted);
    parts.push(quote ? `${k}="${v}"` : `${k}=${v}`);
  }
  return `${auth.scheme} ${parts.join(', ')}`;
}

/** Normalise a header name to its lower-case long form. */
function normalizeName(name) {
  const lower = String(name).trim().toLowerCase();
  if (lower.length === 1 && COMPACT[lower]) return COMPACT[lower];
  return lower;
}

/**
 * Parse a full SIP message. Accepts a string or Buffer.
 * Throws on a malformed start line.
 */
function parse(input) {
  const text = Buffer.isBuffer(input) ? input.toString('binary') : String(input);
  const headerEnd = findHeaderEnd(text);
  const headText = headerEnd.index === -1 ? text : text.slice(0, headerEnd.index);
  const body = headerEnd.index === -1 ? '' : text.slice(headerEnd.index + headerEnd.length);

  // Unfold continuation lines (a line starting with SP/HTAB continues the previous).
  const rawLines = headText.split(/\r?\n/);
  const lines = [];
  for (const line of rawLines) {
    if (line === '') continue;
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += ' ' + line.trim();
    else lines.push(line);
  }
  if (!lines.length) throw new Error('empty SIP message');

  const msg = { headers: {}, body };
  const start = lines[0];

  if (/^SIP\/\d\.\d\s/i.test(start)) {
    const m = /^(SIP\/\d\.\d)\s+(\d{3})\s*(.*)$/i.exec(start);
    if (!m) throw new Error(`malformed status line: ${start}`);
    msg.version = m[1];
    msg.status = parseInt(m[2], 10);
    msg.reason = m[3];
  } else {
    const m = /^([A-Za-z]+)\s+(\S+)\s+(SIP\/\d\.\d)$/.exec(start);
    if (!m) throw new Error(`malformed request line: ${start}`);
    msg.method = m[1].toUpperCase();
    msg.uri = m[2];
    msg.version = m[3];
  }

  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    const name = normalizeName(lines[i].slice(0, colon));
    const value = lines[i].slice(colon + 1).trim();
    const values = NO_SPLIT.has(name)
      ? [value]
      : safeSplit(value, ',').map((v) => v.trim()).filter((v) => v !== '');
    if (!msg.headers[name]) msg.headers[name] = [];
    msg.headers[name].push(...values);
  }

  return msg;
}

/** Locate the CRLFCRLF (or LFLF) that terminates the header section. */
function findHeaderEnd(text) {
  const crlf = text.indexOf('\r\n\r\n');
  const lflf = text.indexOf('\n\n');
  if (crlf !== -1 && (lflf === -1 || crlf < lflf)) return { index: crlf, length: 4 };
  if (lflf !== -1) return { index: lflf, length: 2 };
  return { index: -1, length: 0 };
}

// Headers emitted first, in this order, for readability and proxy friendliness.
const HEADER_ORDER = [
  'via', 'max-forwards', 'from', 'to', 'call-id', 'cseq', 'contact',
  'route', 'record-route',
];

function stringify(msg) {
  let out;
  if (msg.status !== undefined) {
    out = `${msg.version || 'SIP/2.0'} ${msg.status} ${msg.reason || reasonPhrase(msg.status)}\r\n`;
  } else {
    const uri = (typeof msg.uri === 'string' ? msg.uri : stringifyUri(msg.uri)).replace(/[\s]+/g, '');
    out = `${msg.method} ${uri} ${msg.version || 'SIP/2.0'}\r\n`;
  }

  const body = msg.body || '';
  const headers = { ...msg.headers };
  headers['content-length'] = [String(Buffer.byteLength(body, 'binary'))];

  const emitted = new Set();
  const emit = (name) => {
    const values = headers[name];
    if (!values || emitted.has(name)) return;
    emitted.add(name);
    const label = canonicalName(name);
    // A CR or LF inside a value (a display name, a dialled string) would end
    // the header early and let the rest be read as further headers. Fold them
    // into spaces so no value can inject headers into the message.
    for (const v of values) out += `${label}: ${String(v).replace(/[\r\n]+/g, ' ')}\r\n`;
  };

  for (const name of HEADER_ORDER) emit(name);
  for (const name of Object.keys(headers)) if (name !== 'content-length') emit(name);
  emit('content-length');

  return out + '\r\n' + body;
}

const REASONS = {
  100: 'Trying', 180: 'Ringing', 181: 'Call Is Being Forwarded', 182: 'Queued',
  183: 'Session Progress', 200: 'OK', 202: 'Accepted',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Moved Temporarily',
  305: 'Use Proxy', 380: 'Alternative Service',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required',
  403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  406: 'Not Acceptable', 407: 'Proxy Authentication Required',
  408: 'Request Timeout', 410: 'Gone', 413: 'Request Entity Too Large',
  414: 'Request-URI Too Long', 415: 'Unsupported Media Type',
  416: 'Unsupported URI Scheme', 420: 'Bad Extension', 421: 'Extension Required',
  422: 'Session Interval Too Small', 423: 'Interval Too Brief',
  480: 'Temporarily Unavailable', 481: 'Call/Transaction Does Not Exist',
  482: 'Loop Detected', 483: 'Too Many Hops', 484: 'Address Incomplete',
  485: 'Ambiguous', 486: 'Busy Here', 487: 'Request Terminated',
  488: 'Not Acceptable Here', 489: 'Bad Event', 491: 'Request Pending',
  493: 'Undecipherable',
  500: 'Server Internal Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Server Time-out',
  505: 'Version Not Supported', 513: 'Message Too Large',
  600: 'Busy Everywhere', 603: 'Decline', 604: 'Does Not Exist Anywhere',
  606: 'Not Acceptable',
};

function reasonPhrase(status) {
  return REASONS[status] || (status < 200 ? 'Provisional' : 'Unknown');
}

// ---- convenience accessors -------------------------------------------------

function getHeader(msg, name) {
  const v = msg.headers[normalizeName(name)];
  return v && v.length ? v[0] : undefined;
}

function getHeaders(msg, name) {
  return msg.headers[normalizeName(name)] || [];
}

function setHeader(msg, name, value) {
  msg.headers[normalizeName(name)] = Array.isArray(value) ? value.slice() : [String(value)];
  return msg;
}

function addHeader(msg, name, value) {
  const key = normalizeName(name);
  if (!msg.headers[key]) msg.headers[key] = [];
  msg.headers[key].push(String(value));
  return msg;
}

function removeHeader(msg, name) {
  delete msg.headers[normalizeName(name)];
  return msg;
}

module.exports = {
  parse,
  stringify,
  parseUri,
  stringifyUri,
  parseNameAddr,
  stringifyNameAddr,
  parseVia,
  stringifyVia,
  parseCSeq,
  parseParams,
  stringifyParams,
  parseAuthHeader,
  stringifyAuthHeader,
  reasonPhrase,
  safeSplit,
  normalizeName,
  getHeader,
  getHeaders,
  setHeader,
  addHeader,
  removeHeader,
};
