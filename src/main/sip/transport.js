'use strict';
/**
 * SIP transports: UDP, TCP and TLS, plus RFC 3263 target resolution.
 *
 * A Transport emits:
 *   'message' (rawText, { address, port, transport })
 *   'error'   (err)
 *   'closed'  ()
 */

const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { EventEmitter } = require('events');
const os = require('os');

const DEFAULT_PORTS = { UDP: 5060, TCP: 5060, TLS: 5061 };
const MAX_MESSAGE = 65535;

/**
 * Resolve a SIP target to concrete address/port pairs.
 * Explicit ports skip SRV, as required by RFC 3263.
 */
async function resolveTarget(host, port, transport) {
  const proto = String(transport || 'UDP').toUpperCase();
  const bare = host.replace(/^\[|\]$/g, '');

  if (net.isIP(bare)) {
    return [{ address: bare, port: port || DEFAULT_PORTS[proto] || 5060 }];
  }

  if (!port) {
    const service = proto === 'TLS' ? '_sips._tcp' : proto === 'TCP' ? '_sip._tcp' : '_sip._udp';
    try {
      const records = await dns.promises.resolveSrv(`${service}.${host}`);
      if (records.length) {
        records.sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
        const out = [];
        for (const r of records.slice(0, 4)) {
          try {
            const addrs = await dns.promises.lookup(r.name, { all: true });
            for (const a of addrs) out.push({ address: a.address, port: r.port });
          } catch { /* try the next SRV target */ }
        }
        if (out.length) return out;
      }
    } catch { /* no SRV; fall through to A/AAAA */ }
  }

  const addrs = await dns.promises.lookup(host, { all: true });
  return addrs.map((a) => ({ address: a.address, port: port || DEFAULT_PORTS[proto] || 5060 }));
}

/** Best-guess local address used to reach `remoteAddress`. */
function localAddressFor(remoteAddress) {
  return new Promise((resolve) => {
    const probe = dgram.createSocket(net.isIPv6(remoteAddress) ? 'udp6' : 'udp4');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { probe.close(); } catch { /* already closed */ }
      resolve(value);
    };
    probe.once('error', () => finish(firstNonLoopback()));
    try {
      // Connecting a UDP socket performs no I/O but selects a source address.
      probe.connect(9, remoteAddress, () => {
        try { finish(probe.address().address); } catch { finish(firstNonLoopback()); }
      });
    } catch {
      finish(firstNonLoopback());
    }
    setTimeout(() => finish(firstNonLoopback()), 500).unref?.();
  });
}

function firstNonLoopback() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

class UdpTransport extends EventEmitter {
  constructor({ localPort = 0, localAddress = '0.0.0.0' } = {}) {
    super();
    this.type = 'UDP';
    this.localPort = localPort;
    this.localAddress = localAddress;
    this.socket = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: net.isIPv6(this.localAddress) ? 'udp6' : 'udp4', reuseAddr: true });
      socket.on('error', (err) => {
        if (!this.socket) reject(err);
        else this.emit('error', err);
      });
      socket.on('message', (buf, rinfo) => {
        const text = buf.toString('binary');
        if (text.replace(/[\r\n]/g, '') === '') return;   // CRLF keep-alive ping
        this.emit('message', text, { address: rinfo.address, port: rinfo.port, transport: 'UDP' });
      });
      socket.bind(this.localPort, this.localAddress === '0.0.0.0' ? undefined : this.localAddress, () => {
        this.socket = socket;
        this.localPort = socket.address().port;
        resolve(this);
      });
    });
  }

  send(text, target) {
    if (!this.socket) return Promise.reject(new Error('transport closed'));
    const buf = Buffer.from(text, 'binary');
    if (buf.length > MAX_MESSAGE) return Promise.reject(new Error('message too large for UDP'));
    return new Promise((resolve, reject) => {
      this.socket.send(buf, target.port, target.address, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** NAT keep-alive: a double CRLF ping (RFC 5626 §3.5.1). */
  ping(target) {
    return this.send('\r\n\r\n', target).catch(() => {});
  }

  close() {
    if (this.socket) { try { this.socket.close(); } catch { /* noop */ } this.socket = null; }
    this.emit('closed');
  }
}

/**
 * Connection-oriented transport. Keeps one outbound connection per
 * "address:port" target and reuses it for responses, which is what NAT and
 * most providers expect.
 */
class StreamTransport extends EventEmitter {
  constructor({ secure = false, localPort = 0, localAddress = '0.0.0.0', tlsOptions = {} } = {}) {
    super();
    this.type = secure ? 'TLS' : 'TCP';
    this.secure = secure;
    this.localPort = localPort;
    this.localAddress = localAddress;
    this.tlsOptions = tlsOptions;
    this.connections = new Map();
    this.server = null;
  }

  async open() {
    // A listening socket is optional; providers normally reuse our outbound
    // connection. We bind one anyway so that direct inbound calls work.
    return new Promise((resolve) => {
      const handler = (socket) => this._attach(socket, `${socket.remoteAddress}:${socket.remotePort}`);
      this.server = this.secure ? tls.createServer(this.tlsOptions, handler) : net.createServer(handler);
      this.server.on('error', (err) => this.emit('error', err));
      this.server.listen(this.localPort, () => {
        this.localPort = this.server.address().port;
        resolve(this);
      });
      // Do not hold the process open for the listener alone.
      this.server.unref?.();
    });
  }

  _attach(socket, key) {
    socket.setKeepAlive(true, 30000);
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const framed = takeMessage(buffer);
        if (!framed) break;
        buffer = framed.rest;
        if (framed.text.replace(/[\r\n]/g, '') === '') continue;
        this.emit('message', framed.text, {
          address: socket.remoteAddress, port: socket.remotePort, transport: this.type,
        });
      }
      if (buffer.length > MAX_MESSAGE * 4) { buffer = Buffer.alloc(0); socket.destroy(); }
    });

    const drop = () => {
      if (this.connections.get(key) === socket) this.connections.delete(key);
    };
    socket.on('error', drop);
    socket.on('close', drop);
    this.connections.set(key, socket);
    return socket;
  }

  _connect(target) {
    const key = `${target.address}:${target.port}`;
    const existing = this.connections.get(key);
    if (existing && !existing.destroyed) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const opts = { host: target.address, port: target.port };
      const socket = this.secure
        ? tls.connect({ ...opts, servername: target.serverName || undefined, ...this.tlsOptions })
        : net.connect(opts);
      const onReady = () => { socket.removeListener('error', onError); resolve(this._attach(socket, key)); };
      const onError = (err) => { socket.destroy(); reject(err); };
      socket.once(this.secure ? 'secureConnect' : 'connect', onReady);
      socket.once('error', onError);
      socket.setTimeout(10000, () => onError(new Error('connect timeout')));
    });
  }

  async send(text, target) {
    const socket = await this._connect(target);
    return new Promise((resolve, reject) => {
      socket.write(Buffer.from(text, 'binary'), (err) => (err ? reject(err) : resolve()));
    });
  }

  ping(target) {
    return this.send('\r\n\r\n', target).catch(() => {});
  }

  close() {
    for (const socket of this.connections.values()) { try { socket.destroy(); } catch { /* noop */ } }
    this.connections.clear();
    if (this.server) { try { this.server.close(); } catch { /* noop */ } this.server = null; }
    this.emit('closed');
  }
}

/**
 * Split one complete SIP message off the front of a stream buffer.
 * Returns { text, rest } or null when more data is needed.
 */
function takeMessage(buffer) {
  const text = buffer.toString('binary');
  let headerEnd = text.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (headerEnd === -1) {
    headerEnd = text.indexOf('\n\n');
    sepLen = 2;
    if (headerEnd === -1) return null;
  }
  const head = text.slice(0, headerEnd);
  const m = /^(?:content-length|l)[ \t]*:[ \t]*(\d+)/im.exec(head);
  const length = m ? parseInt(m[1], 10) : 0;
  const total = headerEnd + sepLen + length;
  if (buffer.length < total) return null;
  return { text: buffer.toString('binary', 0, total), rest: buffer.subarray(total) };
}

function createTransport(kind, options) {
  switch (String(kind).toUpperCase()) {
    case 'TCP': return new StreamTransport({ ...options, secure: false });
    case 'TLS': return new StreamTransport({ ...options, secure: true });
    default: return new UdpTransport(options);
  }
}

module.exports = {
  UdpTransport,
  StreamTransport,
  createTransport,
  resolveTarget,
  localAddressFor,
  firstNonLoopback,
  takeMessage,
  DEFAULT_PORTS,
};
