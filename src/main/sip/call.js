'use strict';
/**
 * A SIP dialog plus its media: one call leg.
 *
 * States: init -> calling -> ringing -> connected -> terminated  (outgoing)
 *         init -> incoming -> connected -> terminated            (incoming)
 *
 * Hold is tracked as two independent flags, because either side can hold:
 *   localHold   we put them on hold   (we offer sendonly / inactive)
 *   remoteHold  they put us on hold   (they offered sendonly / inactive)
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('./parser');
const SDP = require('./sdp');
const { newBranch, buildAck } = require('./transaction');
const { CODECS, preferenceList } = require('../rtp/codecs');

const TELEPHONE_EVENT_PT = 101;

function newTag() {
  return crypto.randomBytes(6).toString('hex');
}

function newCallId(host) {
  return `${crypto.randomBytes(12).toString('hex')}@${host}`;
}

class Call extends EventEmitter {
  /**
   * @param {object} ua    owning UserAgent
   * @param {object} opts
   */
  constructor(ua, { direction, id = crypto.randomUUID() }) {
    super();
    this.ua = ua;
    this.id = id;
    this.accountId = ua.id;
    this.direction = direction;            // 'out' | 'in'
    this.state = 'init';
    this.endReason = null;
    this.endStatus = null;

    // Dialog
    this.callId = null;
    this.localTag = newTag();
    this.remoteTag = null;
    this.localSeq = Math.floor(Math.random() * 10000) + 1;
    this.remoteSeq = 0;
    this.localUri = null;
    this.remoteUri = null;
    this.remoteTarget = null;
    this.routeSet = [];
    this.remoteDisplayName = null;

    // Media
    this.rtp = null;
    this.localHold = false;
    this.remoteHold = false;
    this.localSdpVersion = 0;
    this.localSdpSessionId = String(Math.floor(Date.now() / 1000));
    this.negotiated = null;
    this.conferenceMember = false;        // set by the CallManager

    // Transactions
    this.inviteTxn = null;
    this.serverTxn = null;
    this.pendingServerInvite = null;
    this.lastOkResponse = null;
    this._okRetransmit = null;
    this._okTimer = null;
    this._reinviteRetry = null;
    this._cancelRequested = false;
    this._terminating = false;

    this.createdAt = Date.now();
    this.answeredAt = null;
    this.endedAt = null;
  }

  // ---- identity -----------------------------------------------------------

  get remoteNumber() {
    if (!this.remoteUri) return '';
    const uri = typeof this.remoteUri === 'string' ? P.parseUri(this.remoteUri) : this.remoteUri;
    return uri.user || uri.host || '';
  }

  get dialogKey() {
    return `${this.callId}|${this.localTag}|${this.remoteTag || ''}`;
  }

  get isEstablished() {
    return this.state === 'connected';
  }

  get onHold() {
    return this.localHold;
  }

  /** Snapshot for the renderer. */
  toJSON() {
    return {
      id: this.id,
      accountId: this.accountId,
      direction: this.direction,
      state: this.state,
      remoteNumber: this.remoteNumber,
      remoteName: this.remoteDisplayName || null,
      localHold: this.localHold,
      remoteHold: this.remoteHold,
      inConference: this.conferenceMember,
      muted: this.ua.audio.mixer.micMuted,
      createdAt: this.createdAt,
      answeredAt: this.answeredAt,
      endedAt: this.endedAt,
      endReason: this.endReason,
      endStatus: this.endStatus,
      codec: this.negotiated ? this.negotiated.codec.name : null,
    };
  }

  _setState(state) {
    if (this.state === state) return;
    this.ua.log.info(`call ${state}`, {
      call: this.id.slice(0, 8), direction: this.direction, remote: this.remoteNumber,
      ...(state === 'terminated' ? { reason: this.endReason, status: this.endStatus, text: this.endText } : {}),
    });
    this.state = state;
    this.emit('state', state);
  }

  // ---- media --------------------------------------------------------------

  async _ensureMedia() {
    if (this.rtp) return this.rtp;
    // Bind media to the wildcard address, not the interface IP we happen to
    // have right now: a socket pinned to a specific IP fails every send with
    // EADDRNOTAVAIL once that IP changes (DHCP, VPN, Wi-Fi roam, resume). The
    // address we *advertise* in SDP is a separate matter (mediaAdvertisedAddress).
    const wildcard = String(this.ua.mediaAddress).includes(':') ? '::' : '0.0.0.0';
    this.rtp = await this.ua.audio.createLeg(this.id, { localAddress: wildcard });
    return this.rtp;
  }

  /** The direction we advertise, given who is holding whom. */
  _localDirection() {
    if (this.localHold && this.remoteHold) return 'inactive';
    if (this.localHold) return this.ua.config.holdDirection || 'sendonly';
    if (this.remoteHold) return 'recvonly';
    return 'sendrecv';
  }

  _buildSdp(direction = this._localDirection()) {
    const codecList = this.negotiated
      ? [{ pt: this.negotiated.pt, name: this.negotiated.codec.name, rate: this.negotiated.codec.rate, channels: 1 }]
      : preferenceList(this.ua.config.codecs).map((c) => ({ pt: c.staticPt, name: c.name, rate: c.rate, channels: 1 }));

    return SDP.build({
      address: this.ua.mediaAdvertisedAddress,
      port: this.rtp.localPort,
      codecs: codecList,
      direction,
      ptime: 20,
      sessionId: this.localSdpSessionId,
      sessionVersion: this.localSdpVersion,
      telephoneEvent: this.ua.config.dtmfMode === 'info' ? null : { pt: TELEPHONE_EVENT_PT, rate: 8000 },
    });
  }

  /** Apply a remote SDP (offer or answer) to the RTP session. */
  _applyRemoteSdp(body) {
    if (!body) return false;
    const sdp = SDP.parse(body);
    const media = SDP.audioMedia(sdp);
    if (!media || !media.port) return false;

    const address = SDP.mediaAddress(sdp, media);
    // `c=IN IP4 0.0.0.0` is the RFC 2543-era hold: "send me nothing". Many
    // PBXs still use it when bridging or parking. It is not a destination —
    // keep the last real address for when they resume.
    const unspecified = !address || address === '0.0.0.0' || address === '::';
    const chosen = SDP.negotiate(media, preferenceList(this.ua.config.codecs));
    if (!chosen) {
      this.emit('mediaError', new Error('no common codec'));
      return false;
    }
    this.negotiated = chosen;

    const remoteTe = SDP.findTelephoneEvent(media);
    const receiveMap = {};
    for (const c of Object.values(CODECS)) receiveMap[c.staticPt] = c;
    for (const [pt, entry] of Object.entries(media.rtpmap)) {
      const match = Object.values(CODECS).find((c) => c.name.toLowerCase() === entry.name.toLowerCase());
      if (match) receiveMap[parseInt(pt, 10)] = match;
    }

    this.rtp.configure({
      remoteAddress: unspecified ? undefined : address,
      remotePort: unspecified ? undefined : media.port,
      sendCodec: chosen.codec,
      sendPayloadType: chosen.pt,
      telephoneEventPt: remoteTe ? remoteTe.pt : null,
      remoteTelephoneEventPt: remoteTe ? remoteTe.pt : null,
      receiveMap,
    });

    if (media.port === 0) {
      this.remoteDirection = 'inactive';
    } else if (unspecified) {
      // A zero address means the peer will not receive; whether it still
      // sends (music on hold) depends on the direction attribute it kept.
      this.remoteDirection = (media.direction === 'recvonly' || media.direction === 'inactive')
        ? 'inactive' : 'sendonly';
    } else {
      this.remoteDirection = media.direction;
    }

    // Decide whether the *peer* is holding us.
    //
    // Hold is signalled by the peer no longer wanting to *receive* — a held
    // party is told `a=sendonly`, because the holder may still send music on
    // hold. So `sendonly` from them means we are held, even though they are
    // still transmitting.
    //
    // While we hold them, the correct answer to our `a=sendonly` is
    // `a=recvonly`: that is them complying, not them holding us. Only
    // `a=inactive` in that situation means both sides are on hold.
    const wasRemoteHold = this.remoteHold;
    this.remoteHold = this.localHold
      ? this.remoteDirection === 'inactive'
      : this.remoteDirection !== 'sendrecv';
    if (wasRemoteHold !== this.remoteHold) this.emit('remoteHold', this.remoteHold);

    this._applyMediaFlow();
    return true;
  }

  /**
   * Push the negotiated direction into the RTP session and the mixer.
   *
   * RTP keeps flowing while we hold someone (we advertised `a=sendonly`, so
   * the peer expects a stream, and it keeps the NAT binding alive) — the
   * mixer just feeds that leg silence instead of the microphone. The held
   * party, told `sendonly`, correctly stops sending to us.
   */
  _applyMediaFlow() {
    if (!this.rtp) return;
    const direction = this.remoteDirection || 'sendrecv';
    const peerSends = direction === 'sendrecv' || direction === 'sendonly';
    const peerReceives = direction === 'sendrecv' || direction === 'recvonly';

    this.rtp.setDirection({
      sending: peerReceives || this.localHold,
      receiving: peerSends && !this.localHold,
    });

    // The mixer mode follows from two facts: is this leg audible right now,
    // and did the CallManager put it in the conference. Deriving it here, in
    // one place, means a re-INVITE from the PBX can never knock a member out
    // of the bridge.
    const idle = this.localHold || this.state !== 'connected';
    this.ua.audio.setLegMode(this.id, idle ? 'idle' : (this.conferenceMember ? 'conference' : 'active'));
  }

  /** Re-derive the mixer mode after the CallManager changes conference membership. */
  applyMediaFlow() {
    this._applyMediaFlow();
  }

  // ---- request construction ----------------------------------------------

  /** Build an in-dialog request (RFC 3261 §12.2.1). */
  _buildInDialogRequest(method, { body = null, contentType = 'application/sdp', extraHeaders = {} } = {}) {
    const request = {
      method,
      uri: P.stringifyUri(this.remoteTarget),
      version: 'SIP/2.0',
      headers: {},
      body: body || '',
    };

    const routeSet = this.routeSet.slice();
    if (routeSet.length) {
      const first = P.parseNameAddr(routeSet[0]);
      if (first.uri.params.lr === undefined && first.uri.params.lr !== null) {
        // Strict router: put its URI in the Request-URI and move ours to the end.
        request.uri = P.stringifyUri(first.uri);
        routeSet.shift();
        routeSet.push(`<${P.stringifyUri(this.remoteTarget)}>`);
      }
      request.headers.route = routeSet;
    }

    this.localSeq += 1;
    request.headers.via = [P.stringifyVia({
      transport: this.ua.transportType,
      host: this.ua.viaHost,
      port: this.ua.viaPort,
      params: { branch: newBranch(), rport: null },
    })];
    request.headers['max-forwards'] = ['70'];
    request.headers.from = [P.stringifyNameAddr({
      name: this.ua.config.displayName || null,
      uri: this.localUri,
      params: { tag: this.localTag },
    })];
    request.headers.to = [P.stringifyNameAddr({
      name: this.remoteDisplayName || null,
      uri: this.remoteUri,
      params: this.remoteTag ? { tag: this.remoteTag } : {},
    })];
    request.headers['call-id'] = [this.callId];
    request.headers.cseq = [`${this.localSeq} ${method}`];
    request.headers.contact = [this.ua.contactHeader()];
    request.headers['user-agent'] = [this.ua.userAgentString];
    if (body) request.headers['content-type'] = [contentType];

    for (const [name, value] of Object.entries(extraHeaders)) {
      request.headers[P.normalizeName(name)] = Array.isArray(value) ? value : [value];
    }
    return request;
  }

  /** Learn the dialog's remote target and route set from a message. */
  _absorbDialogState(message, isResponse) {
    const contact = P.getHeader(message, 'contact');
    if (contact && contact !== '*') {
      this.remoteTarget = P.parseNameAddr(contact).uri;
    }
    const recordRoute = P.getHeaders(message, 'record-route');
    if (recordRoute.length) {
      // UAC reverses the Record-Route order; UAS keeps it (§12.1).
      this.routeSet = isResponse ? recordRoute.slice().reverse() : recordRoute.slice();
    }
    if (this.ua.outboundRoute) {
      // An outbound proxy is always the first hop.
      if (!this.routeSet.length || this.routeSet[0] !== this.ua.outboundRoute) {
        this.routeSet.unshift(this.ua.outboundRoute);
      }
    }
  }

  // ---- outgoing call ------------------------------------------------------

  async dial(target, { extraHeaders = {} } = {}) {
    const targetUri = this.ua.normalizeTarget(target);
    this.remoteUri = targetUri;
    this.localUri = this.ua.addressOfRecord();
    this.callId = newCallId(this.ua.viaHost);
    this.direction = 'out';

    await this._ensureMedia();
    this._setState('calling');
    this.emit('update');

    const body = this._buildSdp('sendrecv');
    const request = {
      method: 'INVITE',
      uri: P.stringifyUri(targetUri),
      version: 'SIP/2.0',
      headers: {},
      body,
    };
    if (this.ua.outboundRoute) request.headers.route = [this.ua.outboundRoute];
    request.headers['max-forwards'] = ['70'];
    request.headers.from = [P.stringifyNameAddr({
      name: this.ua.config.displayName || null,
      uri: this.localUri,
      params: { tag: this.localTag },
    })];
    request.headers.to = [P.stringifyNameAddr({ uri: targetUri, params: {} })];
    request.headers['call-id'] = [this.callId];
    request.headers.cseq = [`${this.localSeq} INVITE`];
    request.headers.contact = [this.ua.contactHeader()];
    request.headers.allow = [this.ua.allowHeader()];
    request.headers.supported = ['replaces, timer, 100rel'];
    request.headers['content-type'] = ['application/sdp'];
    request.headers['user-agent'] = [this.ua.userAgentString];
    for (const [name, value] of Object.entries(extraHeaders)) {
      request.headers[P.normalizeName(name)] = Array.isArray(value) ? value : [value];
    }

    this.ua.registerDialog(this);
    this._sendInvite(request, 0);
  }

  _sendInvite(request, authAttempt) {
    request.headers.via = [P.stringifyVia({
      transport: this.ua.transportType,
      host: this.ua.viaHost,
      port: this.ua.viaPort,
      params: { branch: newBranch(), rport: null },
    })];

    const txn = this.ua.transactions.request(request, this.ua.target);
    this.inviteTxn = txn;
    this.currentInvite = request;

    txn.on('provisional', (response) => this._onInviteProvisional(response));
    txn.on('final', (response) => this._onInviteFinal(response, request, authAttempt));
    txn.on('timeout', () => this._finish('timeout', 408, 'No response from server'));
    txn.on('transportError', (err) => this._finish('transport', 503, err.message));

    if (this._cancelRequested) this._doCancel();
  }

  _onInviteProvisional(response) {
    if (this.state === 'terminated') return;
    this._absorbTo(response);
    this._absorbDialogState(response, true);

    if (response.status === 180 || response.status === 183) {
      this._setState('ringing');
    }
    // Early media: a provisional carrying SDP means audio before answer.
    if (response.body && P.getHeader(response, 'content-type') === 'application/sdp') {
      if (this._applyRemoteSdp(response.body)) {
        this.ua.audio.setLegMode(this.id, 'active');
        this.emit('earlyMedia');
      }
    }
    this._maybePrack(response);
    this.emit('update');

    if (this._cancelRequested) this._doCancel();
  }

  /** Acknowledge a reliable provisional response (RFC 3262). */
  _maybePrack(response) {
    const requires = P.getHeaders(response, 'require').join(',').toLowerCase();
    if (!requires.includes('100rel')) return;
    const rseq = P.getHeader(response, 'rseq');
    if (!rseq) return;
    const cseq = P.parseCSeq(P.getHeader(response, 'cseq'));
    const prack = this._buildInDialogRequest('PRACK', {
      extraHeaders: { rack: `${rseq} ${cseq.seq} ${cseq.method}` },
    });
    this.ua.sendRequestWithAuth(prack, this.ua.target).catch(() => {});
  }

  _onInviteFinal(response, request, authAttempt) {
    if (this.state === 'terminated') return;
    const status = response.status;

    if ((status === 401 || status === 407) && authAttempt < 2) {
      if (this.ua.auth.addChallenges(response)) {
        const retry = { ...request, headers: { ...request.headers }, body: request.body };
        delete retry.headers.via;
        this.localSeq += 1;
        retry.headers.cseq = [`${this.localSeq} INVITE`];
        this.ua.auth.authorize(retry, { method: 'INVITE', uri: retry.uri, body: retry.body });
        this._sendInvite(retry, authAttempt + 1);
        return;
      }
    }

    if (status >= 200 && status < 300) {
      this._absorbTo(response);
      this._absorbDialogState(response, true);
      this.ua.registerDialog(this);

      if (response.body) this._applyRemoteSdp(response.body);

      // ACK the 2xx ourselves (§13.2.2.4) and keep it for retransmissions.
      this.lastAck = this._buildAckFor2xx(response);
      this.ua.transactions.send(this.lastAck, this.ua.target).catch(() => {});

      this.answeredAt = Date.now();
      this._setState('connected');
      this._applyMediaFlow();
      this.emit('update');
      return;
    }

    if (status === 487) { this._finish('cancelled', status, 'Cancelled'); return; }
    if (status === 486 || status === 600) { this._finish('busy', status, 'Busy'); return; }
    if (status === 603) { this._finish('declined', status, 'Declined'); return; }
    if (status === 404 || status === 604) { this._finish('notfound', status, 'Not found'); return; }
    this._finish('rejected', status, response.reason || P.reasonPhrase(status));
  }

  _absorbTo(response) {
    const to = P.parseNameAddr(P.getHeader(response, 'to'));
    if (to.params.tag) this.remoteTag = to.params.tag;
    if (to.name && !this.remoteDisplayName) this.remoteDisplayName = to.name;
  }

  /**
   * The ACK for a 2xx is a new transaction sharing the INVITE's CSeq number
   * and routed by the dialog (§13.2.2.4).
   */
  _buildAckFor2xx(response) {
    const cseq = P.parseCSeq(P.getHeader(this.currentInvite, 'cseq'));
    const ack = {
      method: 'ACK',
      uri: P.stringifyUri(this.remoteTarget),
      version: 'SIP/2.0',
      headers: {},
      body: '',
    };
    if (this.routeSet.length) ack.headers.route = this.routeSet.slice();
    ack.headers.via = [P.stringifyVia({
      transport: this.ua.transportType,
      host: this.ua.viaHost,
      port: this.ua.viaPort,
      params: { branch: newBranch(), rport: null },
    })];
    ack.headers['max-forwards'] = ['70'];
    ack.headers.from = [P.getHeader(this.currentInvite, 'from')];
    ack.headers.to = [P.getHeader(response, 'to')];
    ack.headers['call-id'] = [this.callId];
    ack.headers.cseq = [`${cseq.seq} ACK`];
    ack.headers['user-agent'] = [this.ua.userAgentString];
    // Carry the answer here when the INVITE had no offer.
    if (this._pendingAckSdp) {
      ack.body = this._pendingAckSdp;
      ack.headers['content-type'] = ['application/sdp'];
      this._pendingAckSdp = null;
    }
    // Credentials are per-request; reuse whatever the INVITE needed.
    if (this.ua.auth.hasChallenges) {
      this.ua.auth.authorize(ack, { method: 'ACK', uri: ack.uri });
    }
    return ack;
  }

  /** A retransmitted 2xx means our ACK was lost. */
  onRetransmitted2xx() {
    if (this.lastAck) this.ua.transactions.send(this.lastAck, this.ua.target).catch(() => {});
  }

  // ---- incoming call ------------------------------------------------------

  async handleInitialInvite(request, txn) {
    this.direction = 'in';
    this.callId = P.getHeader(request, 'call-id');
    const from = P.parseNameAddr(P.getHeader(request, 'from'));
    const to = P.parseNameAddr(P.getHeader(request, 'to'));
    this.remoteUri = from.uri;
    this.remoteTag = from.params.tag;
    this.remoteDisplayName = from.name;
    this.localUri = to.uri;
    this.remoteSeq = P.parseCSeq(P.getHeader(request, 'cseq')).seq;
    this._absorbDialogState(request, false);
    this.serverTxn = txn;
    this.pendingServerInvite = request;

    await this._ensureMedia();

    const contentType = (P.getHeader(request, 'content-type') || '').toLowerCase();
    if (request.body && contentType.includes('application/sdp')) {
      if (!this._applyRemoteSdp(request.body)) {
        txn.respond(this.ua.makeDialogResponse(request, 488, this));
        this._finish('incompatible', 488, 'No common codec');
        return;
      }
      this.hasRemoteOffer = true;
    }

    this.ua.registerDialog(this);
    this._setState('incoming');
    this.emit('update');

    // 180 Ringing, with our tag so the dialog is established early.
    txn.respond(this.ua.makeDialogResponse(request, 180, this));
  }

  /** Answer an incoming call. */
  async accept() {
    if (this.state !== 'incoming') return;
    const request = this.pendingServerInvite;
    await this._ensureMedia();

    const response = this.ua.makeDialogResponse(request, 200, this);
    response.body = this._buildSdp(this.remoteHold ? 'recvonly' : 'sendrecv');
    response.headers['content-type'] = ['application/sdp'];
    response.headers.allow = [this.ua.allowHeader()];
    response.headers.supported = ['replaces, timer'];

    this.lastOkResponse = response;
    this.answeredAt = Date.now();
    this._setState('connected');
    this._applyMediaFlow();

    this.serverTxn.respond(response);
    this._startOkRetransmit(response);
    this.emit('update');
  }

  /**
   * A 2xx is retransmitted by the UA core until the ACK arrives (§13.3.1.4);
   * if none comes within 64*T1 the call is torn down.
   */
  _startOkRetransmit(response) {
    let interval = 500;
    let elapsed = 0;
    const tick = () => {
      if (this.state === 'terminated' || this.ackReceived) return;
      // Reply to where the INVITE actually came from, not the registrar.
      const target = this.serverTxn ? this.serverTxn.target : this.ua.target;
      this.ua.transactions.send(response, target).catch(() => {});
      elapsed += interval;
      interval = Math.min(interval * 2, 4000);
      if (elapsed >= 32000) {
        this.hangup('No ACK received');
        return;
      }
      this._okRetransmit = setTimeout(tick, interval);
    };
    this._okRetransmit = setTimeout(tick, interval);
  }

  _stopOkRetransmit() {
    if (this._okRetransmit) { clearTimeout(this._okRetransmit); this._okRetransmit = null; }
  }

  /** Reject an incoming call. */
  reject(status = 486, reason) {
    if (this.state !== 'incoming') return;
    this.serverTxn.respond(this.ua.makeDialogResponse(this.pendingServerInvite, status, this, reason));
    this._finish('rejected-local', status, reason || 'Rejected');
  }

  // ---- in-dialog requests -------------------------------------------------

  handleRequest(request, txn) {
    const method = request.method;
    const cseq = P.parseCSeq(P.getHeader(request, 'cseq'));
    if (cseq.seq > this.remoteSeq) this.remoteSeq = cseq.seq;

    switch (method) {
      case 'INVITE': return this._handleReInvite(request, txn);
      case 'BYE': {
        txn.respond(this.ua.makeDialogResponse(request, 200, this));
        this._finish('remote', 200, 'Remote hung up');
        return;
      }
      case 'CANCEL': {
        txn.respond(this.ua.makeDialogResponse(request, 200, this));
        if (this.state === 'incoming') {
          this.serverTxn.respond(this.ua.makeDialogResponse(this.pendingServerInvite, 487, this));
          this._finish('cancelled', 487, 'Caller hung up');
        }
        return;
      }
      case 'INFO': {
        txn.respond(this.ua.makeDialogResponse(request, 200, this));
        this._handleInfo(request);
        return;
      }
      case 'NOTIFY': {
        txn.respond(this.ua.makeDialogResponse(request, 200, this));
        this.emit('notify', request);
        return;
      }
      case 'REFER': {
        // We do not act as a transfer target by default.
        txn.respond(this.ua.makeDialogResponse(request, 202, this));
        this.emit('referred', P.getHeader(request, 'refer-to'));
        return;
      }
      case 'UPDATE': {
        const response = this.ua.makeDialogResponse(request, 200, this);
        if (request.body) this._applyRemoteSdp(request.body);
        response.body = this._buildSdp();
        response.headers['content-type'] = ['application/sdp'];
        txn.respond(response);
        this.emit('update');
        return;
      }
      case 'OPTIONS': {
        const response = this.ua.makeDialogResponse(request, 200, this);
        response.headers.allow = [this.ua.allowHeader()];
        txn.respond(response);
        return;
      }
      case 'ACK':
        return;
      default:
        txn.respond(this.ua.makeDialogResponse(request, 405, this));
    }
  }

  /** The ACK for our 200 OK arrived. */
  handleAck(request) {
    this.ackReceived = true;
    this._stopOkRetransmit();
    // An INVITE with no offer carries the answer in the ACK.
    if (request.body && !this.hasRemoteOffer) this._applyRemoteSdp(request.body);
    if (this._pendingReinviteAnswer) {
      this._applyRemoteSdp(this._pendingReinviteAnswer);
      this._pendingReinviteAnswer = null;
    }
  }

  _handleReInvite(request, txn) {
    if (this.state === 'incoming') {
      // Retransmitted initial INVITE, not a re-INVITE.
      return;
    }
    this._absorbDialogState(request, false);

    if (request.body) {
      const before = this.remoteHold;
      this._applyRemoteSdp(request.body);
      if (before !== this.remoteHold) this.emit('update');
    }

    const response = this.ua.makeDialogResponse(request, 200, this);
    this.localSdpVersion += 1;
    response.body = this._buildSdp();
    response.headers['content-type'] = ['application/sdp'];
    response.headers.contact = [this.ua.contactHeader()];
    txn.respond(response);
    this.emit('update');
  }

  _handleInfo(request) {
    const type = (P.getHeader(request, 'content-type') || '').toLowerCase();
    if (!type.includes('dtmf')) return;
    const m = /Signal\s*=\s*([0-9A-D*#])/i.exec(request.body || '');
    if (m) this.emit('dtmf', m[1]);
  }

  // ---- hold ---------------------------------------------------------------

  async hold() {
    if (this.state !== 'connected' || this.localHold) return;
    this.localHold = true;
    this._applyMediaFlow();
    this.emit('update');
    await this._reinvite();
  }

  async unhold() {
    if (this.state !== 'connected' || !this.localHold) return;
    this.localHold = false;
    this._applyMediaFlow();
    this.emit('update');
    await this._reinvite();
  }

  /** Send a re-INVITE carrying the current local SDP. */
  async _reinvite() {
    if (this.state !== 'connected') return;
    this.localSdpVersion += 1;
    const request = this._buildInDialogRequest('INVITE', { body: this._buildSdp() });
    request.headers.allow = [this.ua.allowHeader()];

    try {
      const response = await this.ua.sendInviteWithAuth(request, this.ua.target, this);
      if (response.status === 491) {
        // Glare: both sides re-INVITEd. Back off and retry (§14.1).
        const delay = 2100 + Math.random() * 1900;
        this._reinviteRetry = setTimeout(() => this._reinvite(), delay);
        return;
      }
      if (response.status >= 200 && response.status < 300) {
        this._absorbDialogState(response, true);
        if (response.body) this._applyRemoteSdp(response.body);
        this.lastAck = this._buildAckFor2xx(response);
        this.ua.transactions.send(this.lastAck, this.ua.target).catch(() => {});
        this._applyMediaFlow();
        this.emit('update');
      } else if (response.status >= 400) {
        this.emit('warning', `Hold failed for ${this.remoteNumber}: ${response.status} ${response.reason}`);
      }
    } catch (err) {
      this.emit('warning', `Hold failed for ${this.remoteNumber}: ${err.message}`);
    }
  }

  // ---- DTMF ---------------------------------------------------------------

  sendDtmf(digit) {
    const mode = this.ua.config.dtmfMode || 'rfc2833';
    if (mode !== 'info' && this.rtp && this.rtp.sendDtmf(digit)) return true;
    if (mode === 'rfc2833' && !this.rtp?.telephoneEventPt) {
      // Peer did not negotiate telephone-event; fall back to INFO.
    }
    const body = `Signal=${digit}\r\nDuration=160\r\n`;
    const request = this._buildInDialogRequest('INFO', { body, contentType: 'application/dtmf-relay' });
    this.ua.sendRequestWithAuth(request, this.ua.target).catch(() => {});
    return true;
  }

  // ---- transfer -----------------------------------------------------------

  /** Blind transfer: ask the peer to call `target` instead of us. */
  async transferBlind(target) {
    if (this.state !== 'connected') throw new Error('call is not connected');
    const uri = this.ua.normalizeTarget(target);
    const request = this._buildInDialogRequest('REFER', {
      extraHeaders: {
        'refer-to': `<${P.stringifyUri(uri)}>`,
        'referred-by': `<${P.stringifyUri(this.localUri)}>`,
      },
    });
    const response = await this.ua.sendRequestWithAuth(request, this.ua.target);
    if (response.status >= 300) throw new Error(`Transfer refused: ${response.status} ${response.reason}`);
    this.emit('transferring', P.stringifyUri(uri));
    return response;
  }

  /**
   * Attended transfer: hand this call's peer over to `otherCall`'s peer using
   * a REFER with Replaces (RFC 3891).
   */
  async transferAttended(otherCall) {
    if (this.state !== 'connected' || otherCall.state !== 'connected') {
      throw new Error('both calls must be connected');
    }
    const replaces = `${otherCall.callId};to-tag=${otherCall.remoteTag};from-tag=${otherCall.localTag}`;
    const referTo = `<${P.stringifyUri(otherCall.remoteTarget)}?Replaces=${encodeURIComponent(replaces)}>`;
    const request = this._buildInDialogRequest('REFER', {
      extraHeaders: {
        'refer-to': referTo,
        'referred-by': `<${P.stringifyUri(this.localUri)}>`,
      },
    });
    const response = await this.ua.sendRequestWithAuth(request, this.ua.target);
    if (response.status >= 300) throw new Error(`Transfer refused: ${response.status} ${response.reason}`);
    this.emit('transferring', otherCall.remoteNumber);
    return response;
  }

  // ---- teardown -----------------------------------------------------------

  async hangup(reason = 'Local hangup') {
    if (this._terminating || this.state === 'terminated') return;
    this._terminating = true;

    try {
      if (this.state === 'incoming') {
        this._terminating = false;
        this.reject(486, 'Busy Here');
        return;
      }
      if (this.state === 'calling' || this.state === 'ringing') {
        this._cancelRequested = true;
        this._doCancel();
        // The 487 for the INVITE finishes the call; guard against silence.
        setTimeout(() => this._finish('local', 487, reason), 4000);
        return;
      }
      if (this.state === 'connected') {
        this._stopOkRetransmit();
        const bye = this._buildInDialogRequest('BYE');
        this._finish('local', 200, reason);
        await this.ua.sendRequestWithAuth(bye, this.ua.target).catch(() => {});
        return;
      }
    } finally {
      this._terminating = false;
    }
    this._finish('local', 0, reason);
  }

  _doCancel() {
    if (!this.inviteTxn || this.cancelSent) return;
    // CANCEL is only meaningful once a provisional response has arrived.
    if (this.inviteTxn.state === 'trying') return;
    this.cancelSent = true;

    const invite = this.currentInvite;
    const cancel = {
      method: 'CANCEL',
      uri: invite.uri,
      version: 'SIP/2.0',
      headers: {},
      body: '',
    };
    cancel.headers.via = [P.getHeader(invite, 'via')];     // same branch as the INVITE
    if (invite.headers.route) cancel.headers.route = invite.headers.route.slice();
    cancel.headers['max-forwards'] = ['70'];
    cancel.headers.from = [P.getHeader(invite, 'from')];
    cancel.headers.to = [P.getHeader(invite, 'to')];
    cancel.headers['call-id'] = [this.callId];
    const cseq = P.parseCSeq(P.getHeader(invite, 'cseq'));
    cancel.headers.cseq = [`${cseq.seq} CANCEL`];
    cancel.headers['user-agent'] = [this.ua.userAgentString];

    this.ua.transactions.request(cancel, this.ua.target);
  }

  _finish(reason, status, text) {
    if (this.state === 'terminated') return;
    this.endReason = reason;
    this.endStatus = status;
    this.endText = text;
    this.endedAt = Date.now();
    this._stopOkRetransmit();
    if (this._reinviteRetry) clearTimeout(this._reinviteRetry);
    if (this.inviteTxn) this.inviteTxn.removeAllListeners();

    this._setState('terminated');
    this.ua.audio.releaseLeg(this.id);
    this.rtp = null;
    this.ua.unregisterDialog(this);
    this.emit('update');
    this.emit('terminated', { reason, status, text });
  }
}

module.exports = { Call, newTag, newCallId, TELEPHONE_EVENT_PT };
