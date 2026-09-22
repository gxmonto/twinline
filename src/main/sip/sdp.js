'use strict';
/**
 * Minimal SDP handling (RFC 4566) for audio-only offer/answer (RFC 3264).
 */

const DIRECTIONS = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];

/**
 * Parse an SDP blob into { origin, connection, media: [...] , ... }.
 * Unknown lines are preserved per-section in `lines` so nothing is silently lost.
 */
function parse(text) {
  const session = {
    version: 0,
    origin: null,
    name: '-',
    connection: null,
    bandwidth: [],
    attributes: [],
    media: [],
  };
  let current = session;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[1] !== '=') continue;
    const type = line[0];
    const value = line.slice(2);

    switch (type) {
      case 'v':
        session.version = parseInt(value, 10) || 0;
        break;
      case 'o': {
        const p = value.split(/\s+/);
        session.origin = {
          username: p[0], sessionId: p[1], sessionVersion: p[2],
          netType: p[3], addrType: p[4], address: p[5],
        };
        break;
      }
      case 's':
        session.name = value;
        break;
      case 'c': {
        const p = value.split(/\s+/);
        current.connection = { netType: p[0], addrType: p[1], address: (p[2] || '').split('/')[0] };
        break;
      }
      case 'b':
        current.bandwidth.push(value);
        break;
      case 't':
        session.time = value;
        break;
      case 'm': {
        const p = value.split(/\s+/);
        current = {
          type: p[0],
          port: parseInt(p[1], 10),
          proto: p[2],
          formats: p.slice(3),
          connection: null,
          bandwidth: [],
          attributes: [],
        };
        session.media.push(current);
        break;
      }
      case 'a': {
        const colon = value.indexOf(':');
        const attr = colon === -1
          ? { name: value.toLowerCase(), value: null }
          : { name: value.slice(0, colon).toLowerCase(), value: value.slice(colon + 1) };
        current.attributes.push(attr);
        break;
      }
      default:
        break;
    }
  }

  for (const m of session.media) indexMedia(m);
  return session;
}

/** Derive rtpmap/fmtp/direction lookups for a media section. */
function indexMedia(m) {
  m.rtpmap = {};
  m.fmtp = {};
  m.direction = null;
  m.ptime = null;

  for (const a of m.attributes) {
    if (a.name === 'rtpmap' && a.value) {
      const sp = a.value.indexOf(' ');
      const pt = parseInt(a.value.slice(0, sp), 10);
      const parts = a.value.slice(sp + 1).split('/');
      m.rtpmap[pt] = {
        name: parts[0],
        rate: parseInt(parts[1], 10) || 8000,
        channels: parts[2] ? parseInt(parts[2], 10) : 1,
      };
    } else if (a.name === 'fmtp' && a.value) {
      const sp = a.value.indexOf(' ');
      m.fmtp[parseInt(a.value.slice(0, sp), 10)] = a.value.slice(sp + 1);
    } else if (DIRECTIONS.includes(a.name)) {
      m.direction = a.name;
    } else if (a.name === 'ptime' && a.value) {
      m.ptime = parseInt(a.value, 10);
    }
  }
  if (!m.direction) m.direction = 'sendrecv';
  return m;
}

/** The first audio section of a parsed SDP, or null. */
function audioMedia(sdp) {
  return sdp.media.find((m) => m.type === 'audio') || null;
}

/** Remote media address: media-level c= wins over session-level. */
function mediaAddress(sdp, media) {
  const c = (media && media.connection) || sdp.connection;
  return c ? c.address : null;
}

/**
 * The effective direction of the remote's stream from our point of view.
 * Returns { remoteSends, remoteReceives }.
 */
function directionFlags(direction) {
  switch (direction) {
    case 'sendonly': return { remoteSends: true, remoteReceives: false };
    case 'recvonly': return { remoteSends: false, remoteReceives: true };
    case 'inactive': return { remoteSends: false, remoteReceives: false };
    default: return { remoteSends: true, remoteReceives: true };
  }
}

/** The direction we must signal so the peer sees `direction`. */
function reverseDirection(direction) {
  if (direction === 'sendonly') return 'recvonly';
  if (direction === 'recvonly') return 'sendonly';
  return direction;
}

let sessionCounter = Math.floor(Date.now() / 1000);

/**
 * Build an audio-only SDP body.
 *
 * @param {object} opts
 * @param {string} opts.address     local media IP advertised to the peer
 * @param {number} opts.port        local RTP port
 * @param {Array}  opts.codecs      [{ pt, name, rate, channels, fmtp }]
 * @param {string} [opts.direction] sendrecv | sendonly | recvonly | inactive
 * @param {number} [opts.ptime]
 * @param {string} [opts.sessionId]
 * @param {number} [opts.sessionVersion]
 */
function build(opts) {
  const {
    address, port, codecs,
    direction = 'sendrecv',
    ptime = 20,
    sessionId = String(sessionCounter++),
    sessionVersion = 0,
    telephoneEvent = null,
  } = opts;

  const addrType = address.includes(':') ? 'IP6' : 'IP4';
  const formats = codecs.map((c) => c.pt);
  if (telephoneEvent != null) formats.push(telephoneEvent.pt);

  const lines = [
    'v=0',
    `o=- ${sessionId} ${sessionVersion} IN ${addrType} ${address}`,
    's=TwinLine',
    `c=IN ${addrType} ${address}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${formats.join(' ')}`,
  ];

  for (const c of codecs) {
    lines.push(`a=rtpmap:${c.pt} ${c.name}/${c.rate}${c.channels > 1 ? '/' + c.channels : ''}`);
    if (c.fmtp) lines.push(`a=fmtp:${c.pt} ${c.fmtp}`);
  }
  if (telephoneEvent != null) {
    lines.push(`a=rtpmap:${telephoneEvent.pt} telephone-event/${telephoneEvent.rate || 8000}`);
    lines.push(`a=fmtp:${telephoneEvent.pt} 0-16`);
  }

  lines.push(`a=ptime:${ptime}`);
  lines.push(`a=${direction}`);
  lines.push('a=rtcp-mux');

  return lines.join('\r\n') + '\r\n';
}

/**
 * Pick the payload type to send with, given our preference order and the
 * peer's media section.
 *
 * @param {object} media       parsed remote audio media section
 * @param {Array}  preferences codec descriptors in our preference order
 * @returns {{pt: number, codec: object}|null}
 */
function negotiate(media, preferences) {
  if (!media) return null;
  for (const pref of preferences) {
    for (const fmt of media.formats) {
      const pt = parseInt(fmt, 10);
      if (Number.isNaN(pt)) continue;
      const entry = media.rtpmap[pt];
      if (entry) {
        if (entry.name.toLowerCase() === pref.name.toLowerCase() && entry.rate === pref.rate) {
          return { pt, codec: pref };
        }
      } else if (pref.staticPt === pt) {
        // Static payload type with no rtpmap (RFC 3551).
        return { pt, codec: pref };
      }
    }
  }
  return null;
}

/** Find the peer's telephone-event payload type, if offered. */
function findTelephoneEvent(media) {
  if (!media) return null;
  for (const [pt, entry] of Object.entries(media.rtpmap)) {
    if (entry.name.toLowerCase() === 'telephone-event') {
      return { pt: parseInt(pt, 10), rate: entry.rate };
    }
  }
  return null;
}

module.exports = {
  parse,
  build,
  audioMedia,
  mediaAddress,
  directionFlags,
  reverseDirection,
  negotiate,
  findTelephoneEvent,
  DIRECTIONS,
};
