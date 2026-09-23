'use strict';
/**
 * Rules for which URLs the app is willing to fetch on its own.
 *
 * Both the updater (manifests) and the model store (speech models) download
 * over HTTP and follow redirects. The starting URL is always checked, but a
 * redirect chain must obey the same rule at every hop: an https server that
 * answers "see http://…" would otherwise move the download onto a cleartext
 * channel that anyone on the path can rewrite (a protocol downgrade). This
 * module is dependency-free so the transcription worker and tests can use it.
 */

/** Loopback or RFC 1918 / link-local — places an attacker on the internet cannot sit. */
function isLocalNetwork(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/**
 * Resolve a redirect's Location against the URL that produced it and refuse
 * it when it would leave HTTPS for plain HTTP (unless the destination is on
 * the local network, where the rehearsal update server lives).
 * @returns {string} the absolute URL to follow
 * @throws when the redirect is not acceptable
 */
function followRedirect(fromUrl, location) {
  const from = new URL(fromUrl);
  let to;
  try { to = new URL(location, from); } catch { throw new Error(`redirect to an invalid URL from ${from.host}`); }
  if (to.protocol !== 'http:' && to.protocol !== 'https:') {
    throw new Error(`redirect to a non-http(s) URL (${to.protocol}) refused`);
  }
  if (from.protocol === 'https:' && to.protocol === 'http:' && !isLocalNetwork(to.hostname)) {
    throw new Error(`redirect from https://${from.host} to plain http://${to.host} refused (protocol downgrade)`);
  }
  return to.toString();
}

module.exports = { isLocalNetwork, followRedirect };
