'use strict';
/**
 * SIP transaction layer (RFC 3261 §17).
 *
 * Implements INVITE and non-INVITE client and server transactions with the
 * standard timers. Retransmission is disabled on reliable transports (TCP/TLS)
 * as §17.1.1.2 requires.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('./parser');

const T1 = 500;        // RTT estimate
const T2 = 4000;       // maximum retransmit interval for non-INVITE
const T4 = 5000;       // maximum duration a message stays in the network
const MAGIC = 'z9hG4bK';

function newBranch() {
  return MAGIC + crypto.randomBytes(9).toString('hex');
}

function topVia(msg) {
  const raw = P.getHeader(msg, 'via');
  return raw ? P.parseVia(raw) : null;
}

/** Transaction id per §17.1.3 / §17.2.3: top Via branch plus CSeq method. */
function transactionId(msg, methodOverride) {
  const via = topVia(msg);
  const branch = via && via.params.branch ? via.params.branch : '';
  const cseq = P.parseCSeq(P.getHeader(msg, 'cseq') || '');
  // ACK and CANCEL are matched against the INVITE they relate to.
  const method = methodOverride || (cseq.method === 'ACK' ? 'INVITE' : cseq.method);
  const sentBy = via ? `${via.host}:${via.port || ''}` : '';
  return `${branch}|${sentBy}|${method}`;
}

class ClientTransaction extends EventEmitter {
  /**
   * @param {object} layer
   * @param {object} request parsed request object
   * @param {object} target  { address, port }
   */
  constructor(layer, request, target) {
    super();
    this.layer = layer;
    this.request = request;
    this.target = target;
    this.method = request.method;
    this.isInvite = request.method === 'INVITE';
    this.id = transactionId(request);
    this.state = 'trying';            // trying | proceeding | completed | terminated
    this.reliable = layer.transport.type !== 'UDP';
    this.timers = {};
    this.interval = T1;
    this.lastResponse = null;
  }

  start() {
    this.layer.clientTransactions.set(this.id, this);
    this._transmit();

    if (!this.reliable) {
      // Timer A (INVITE) / Timer E (non-INVITE): retransmission.
      this.timers.retransmit = setTimeout(() => this._onRetransmitTimer(), this.interval);
    }
    // Timer B (INVITE) / Timer F (non-INVITE): overall timeout.
    this.timers.timeout = setTimeout(() => this._onTimeout(), 64 * T1);
    return this;
  }

  _transmit() {
    this.layer.send(this.request, this.target).catch((err) => {
      this.emit('transportError', err);
      this._terminate();
    });
  }

  _onRetransmitTimer() {
    if (this.state === 'trying' || (!this.isInvite && this.state === 'proceeding')) {
      // INVITE stops retransmitting once provisional; non-INVITE keeps going at T2.
      this._transmit();
      this.interval = this.isInvite ? this.interval * 2 : Math.min(this.interval * 2, T2);
      this.timers.retransmit = setTimeout(() => this._onRetransmitTimer(), this.interval);
    }
  }

  _onTimeout() {
    if (this.state === 'completed' || this.state === 'terminated') return;
    this.emit('timeout');
    this._terminate();
  }

  /** Feed a response in from the transport layer. */
  receiveResponse(response) {
    const status = response.status;

    if (status < 200) {
      if (this.state === 'trying' || this.state === 'proceeding') {
        this.state = 'proceeding';
        clearTimeout(this.timers.retransmit);   // Timer A stops on provisional
        this.emit('provisional', response);
      }
      return;
    }

    if (this.state === 'completed' || this.state === 'terminated') {
      // Retransmitted final response to an INVITE: re-send the ACK.
      if (this.isInvite && status >= 300 && this.ackRequest) {
        this.layer.send(this.ackRequest, this.target).catch(() => {});
      }
      return;
    }

    clearTimeout(this.timers.retransmit);
    clearTimeout(this.timers.timeout);
    this.lastResponse = response;

    if (this.isInvite && status >= 300) {
      // The transaction ACKs non-2xx itself (§17.1.1.3).
      this.ackRequest = buildAck(this.request, response);
      this.layer.send(this.ackRequest, this.target).catch(() => {});
      this.state = 'completed';
      this.emit('final', response);
      // Timer D: absorb retransmissions of the final response.
      this.timers.d = setTimeout(() => this._terminate(), this.reliable ? 0 : 32000);
      return;
    }

    this.state = 'completed';
    this.emit('final', response);

    if (this.isInvite) {
      // 2xx: the TU sends the ACK and the transaction ends immediately.
      this._terminate();
    } else {
      // Timer K.
      this.timers.k = setTimeout(() => this._terminate(), this.reliable ? 0 : T4);
    }
  }

  _terminate() {
    if (this.state === 'terminated') return;
    this.state = 'terminated';
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
    if (this.layer.clientTransactions.get(this.id) === this) {
      this.layer.clientTransactions.delete(this.id);
    }
    this.emit('terminated');
  }

  cancel() {
    this._terminate();
  }
}

class ServerTransaction extends EventEmitter {
  constructor(layer, request, rinfo) {
    super();
    this.layer = layer;
    this.request = request;
    this.rinfo = rinfo;
    this.method = request.method;
    this.isInvite = request.method === 'INVITE';
    this.id = transactionId(request);
    this.state = 'proceeding';       // proceeding | completed | confirmed | terminated
    this.reliable = rinfo.transport !== 'UDP';
    this.timers = {};
    this.interval = T1;
    this.lastResponse = null;
    this.target = layer.responseTarget(request, rinfo);
  }

  start() {
    this.layer.serverTransactions.set(this.id, this);
    if (this.isInvite) {
      // Send 100 Trying promptly so the caller stops retransmitting.
      this.respond(this.layer.makeResponse(this.request, 100));
    }
    return this;
  }

  /** A retransmission of the original request arrived. */
  receiveRequest() {
    if (this.lastResponse) this._transmit(this.lastResponse);
  }

  /** The ACK for a non-2xx final response arrived. */
  receiveAck() {
    if (this.state !== 'completed') return;
    this.state = 'confirmed';
    clearTimeout(this.timers.g);
    clearTimeout(this.timers.h);
    // Timer I.
    this.timers.i = setTimeout(() => this._terminate(), this.reliable ? 0 : T4);
  }

  respond(response) {
    if (this.state === 'terminated') return;
    this.lastResponse = response;
    this._transmit(response);

    const status = response.status;
    if (status < 200) return;

    clearTimeout(this.timers.g);
    clearTimeout(this.timers.h);
    clearTimeout(this.timers.j);

    if (this.isInvite) {
      if (status >= 300) {
        this.state = 'completed';
        if (!this.reliable) {
          // Timer G: retransmit the final response until the ACK arrives.
          const retransmit = () => {
            if (this.state !== 'completed') return;
            this._transmit(this.lastResponse);
            this.interval = Math.min(this.interval * 2, T2);
            this.timers.g = setTimeout(retransmit, this.interval);
          };
          this.timers.g = setTimeout(retransmit, this.interval);
        }
        // Timer H.
        this.timers.h = setTimeout(() => this._terminate(), 64 * T1);
      } else {
        // 2xx retransmission is the UA core's job (§13.3.1.4); the dialog
        // layer drives it, so the transaction terminates here.
        this._terminate();
      }
    } else {
      this.state = 'completed';
      // Timer J.
      this.timers.j = setTimeout(() => this._terminate(), this.reliable ? 0 : 64 * T1);
    }
  }

  _transmit(response) {
    this.layer.send(response, this.target).catch((err) => this.emit('transportError', err));
  }

  _terminate() {
    if (this.state === 'terminated') return;
    this.state = 'terminated';
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
    if (this.layer.serverTransactions.get(this.id) === this) {
      this.layer.serverTransactions.delete(this.id);
    }
    this.emit('terminated');
  }
}

/**
 * Build the ACK for a non-2xx final response (RFC 3261 §17.1.1.3):
 * same Request-URI, Call-ID, From, To (with the response's tag),
 * top Via and CSeq number, method ACK.
 */
function buildAck(request, response) {
  const ack = {
    method: 'ACK',
    uri: request.uri,
    version: 'SIP/2.0',
    headers: {},
    body: '',
  };
  ack.headers.via = [P.getHeader(request, 'via')];
  ack.headers.from = [P.getHeader(request, 'from')];
  ack.headers.to = [P.getHeader(response, 'to')];
  ack.headers['call-id'] = [P.getHeader(request, 'call-id')];
  ack.headers['max-forwards'] = ['70'];
  const cseq = P.parseCSeq(P.getHeader(request, 'cseq'));
  ack.headers.cseq = [`${cseq.seq} ACK`];
  const route = P.getHeaders(request, 'route');
  if (route.length) ack.headers.route = route.slice();
  return ack;
}

/**
 * Routes messages between a transport and transactions.
 *
 * Emits:
 *   'request' (request, serverTransaction, rinfo)  for new server transactions
 *   'ack'     (request, rinfo)                     ACK for a 2xx, no transaction
 *   'response'(response)                           stray response, no transaction
 */
class TransactionLayer extends EventEmitter {
  constructor(transport, { userAgent = 'TwinLine' } = {}) {
    super();
    this.transport = transport;
    this.userAgent = userAgent;
    this.clientTransactions = new Map();
    this.serverTransactions = new Map();
    this.viaHost = null;      // set by the UA once the local address is known
    this.viaPort = null;

    transport.on('message', (text, rinfo) => this._onMessage(text, rinfo));
  }

  send(message, target) {
    const text = P.stringify(message);
    this.emit('sent', text, target);
    return this.transport.send(text, target);
  }

  _onMessage(text, rinfo) {
    this.emit('received', text, rinfo);
    let msg;
    try {
      msg = P.parse(text);
    } catch (err) {
      this.emit('malformed', err, text, rinfo);
      return;
    }
    this.emit('raw', msg, rinfo, false);

    if (msg.status !== undefined) this._onResponse(msg, rinfo);
    else this._onRequest(msg, rinfo);
  }

  _onResponse(response, rinfo) {
    const id = transactionId(response);
    const txn = this.clientTransactions.get(id);
    if (txn) { txn.receiveResponse(response); return; }
    this.emit('response', response, rinfo);
  }

  _onRequest(request, rinfo) {
    const method = request.method;

    if (method === 'ACK') {
      // An ACK for a non-2xx belongs to the INVITE server transaction.
      const txn = this.serverTransactions.get(transactionId(request, 'INVITE'));
      if (txn && txn.state === 'completed') { txn.receiveAck(); return; }
      this.emit('ack', request, rinfo);
      return;
    }

    const existing = this.serverTransactions.get(transactionId(request));
    if (existing) { existing.receiveRequest(); return; }

    const txn = new ServerTransaction(this, request, rinfo).start();
    this.emit('request', request, txn, rinfo);
  }

  /** Create a client transaction for `request` and start it. */
  request(request, target) {
    return new ClientTransaction(this, request, target).start();
  }

  /**
   * Where to send a response: honour Via received/rport, else the sender.
   * (RFC 3581 symmetric response routing.)
   */
  responseTarget(request, rinfo) {
    const via = topVia(request);
    if (!via) return { address: rinfo.address, port: rinfo.port };
    if (via.params.rport !== undefined) {
      // We inserted received/rport when receiving; reply where it came from.
      return { address: rinfo.address, port: rinfo.port };
    }
    const address = via.params.received || via.host;
    const port = via.port || rinfo.port || 5060;
    return { address, port };
  }

  /** Build a response skeleton for `request` (RFC 3261 §8.2.6). */
  makeResponse(request, status, reason) {
    const response = {
      version: 'SIP/2.0',
      status,
      reason: reason || P.reasonPhrase(status),
      headers: {},
      body: '',
    };
    for (const name of ['via', 'from', 'call-id', 'cseq', 'to', 'record-route']) {
      const values = P.getHeaders(request, name);
      if (values.length) response.headers[name] = values.slice();
    }
    response.headers['user-agent'] = [this.userAgent];
    return response;
  }

  /**
   * Stamp `received` and `rport` into the top Via of an inbound request so
   * responses find their way back through NAT.
   */
  stampVia(request, rinfo) {
    const raw = P.getHeader(request, 'via');
    if (!raw) return request;
    const via = P.parseVia(raw);
    if (via.host !== rinfo.address) via.params.received = rinfo.address;
    if ('rport' in via.params) via.params.rport = String(rinfo.port);
    request.headers.via[0] = P.stringifyVia(via);
    return request;
  }

  close() {
    for (const t of [...this.clientTransactions.values()]) t._terminate();
    for (const t of [...this.serverTransactions.values()]) t._terminate();
    this.transport.close();
  }
}

module.exports = {
  TransactionLayer,
  ClientTransaction,
  ServerTransaction,
  newBranch,
  transactionId,
  buildAck,
  topVia,
  T1, T2, T4,
};
