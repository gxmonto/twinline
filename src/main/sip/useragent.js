'use strict';
/**
 * One SIP account: transport, registration, and inbound request routing.
 *
 * Each configured line owns a UserAgent with its own local port, so two
 * accounts on the same provider never collide.
 */

const { EventEmitter } = require('events');
const P = require('./parser');
const { TransactionLayer, newBranch } = require('./transaction');
const { createTransport, resolveTarget, localAddressFor, DEFAULT_PORTS } = require('./transport');
const { DigestStore } = require('./digest');
const { Call, newCallId } = require('./call');
const log = require('../log');

const ALLOWED_METHODS = 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, NOTIFY, REFER, UPDATE, PRACK, MESSAGE';

const DEFAULTS = {
  enabled: true,
  displayName: '',
  username: '',
  authUsername: '',
  password: '',
  domain: '',
  outboundProxy: '',
  transport: 'UDP',
  localPort: 0,
  register: true,
  registerExpires: 300,
  keepAliveSeconds: 30,
  codecs: ['PCMU', 'PCMA'],
  dtmfMode: 'rfc2833',          // rfc2833 | info
  holdDirection: 'sendonly',    // sendonly | inactive
  publicAddress: '',            // manual NAT override
  mediaPortRange: [16384, 32766],
};

class UserAgent extends EventEmitter {
  /**
   * @param {object} config  account settings
   * @param {object} audio   shared AudioEngine
   */
  constructor(config, audio) {
    super();
    this.config = { ...DEFAULTS, ...config };
    this.id = this.config.id;
    this.audio = audio;
    this.log = log.child(`ua:${this.id}`);
    this._recoveryTimer = null;
    this.userAgentString = this.config.userAgentString || 'TwinLine/1.0';

    this.transport = null;
    this.transactions = null;
    this.target = null;              // resolved next hop { address, port }
    this.targets = [];
    this.transportType = String(this.config.transport || 'UDP').toUpperCase();

    this.localAddress = null;
    this.localPort = null;
    this.publicAddress = null;       // learned from Via received
    this.publicPort = null;

    this.auth = new DigestStore(
      this.config.authUsername || this.config.username,
      this.config.password,
    );

    this.registration = {
      state: 'unregistered',         // unregistered | registering | registered | failed
      expires: 0,
      reason: null,
      retries: 0,
    };
    this.registerCallId = null;
    this.registerSeq = Math.floor(Math.random() * 1000) + 1;
    this._registerTimer = null;
    this._keepAliveTimer = null;

    /** @type {Map<string, Call>} dialog key -> call */
    this.dialogs = new Map();
    /** @type {Map<string, Set<Call>>} */
    this.byCallId = new Map();

    this.stopped = false;
  }

  // ---- addressing ---------------------------------------------------------

  get viaHost() {
    return this.publicAddress || this.localAddress || '0.0.0.0';
  }

  get viaPort() {
    return this.publicPort || this.localPort;
  }

  /** Address the RTP sockets bind to. */
  get mediaAddress() {
    return this.localAddress || '0.0.0.0';
  }

  /** Address advertised in SDP. */
  get mediaAdvertisedAddress() {
    return this.config.publicAddress || this.publicAddress || this.localAddress || '127.0.0.1';
  }

  addressOfRecord() {
    return { scheme: this.secure ? 'sips' : 'sip', user: this.config.username, host: this.config.domain, params: {}, headers: {} };
  }

  get secure() {
    return this.transportType === 'TLS';
  }

  contactHeader() {
    const params = {};
    if (this.transportType !== 'UDP') params.transport = this.transportType.toLowerCase();
    const uri = {
      scheme: this.secure ? 'sips' : 'sip',
      user: this.config.username,
      host: this.viaHost,
      port: this.viaPort,
      params,
      headers: {},
    };
    return `<${P.stringifyUri(uri)}>`;
  }

  allowHeader() {
    return ALLOWED_METHODS;
  }

  get outboundRoute() {
    if (!this.config.outboundProxy) return null;
    const uri = P.parseUri(this.config.outboundProxy.includes(':') && !this.config.outboundProxy.startsWith('sip')
      ? `sip:${this.config.outboundProxy}`
      : this.config.outboundProxy.startsWith('sip') ? this.config.outboundProxy : `sip:${this.config.outboundProxy}`);
    uri.params.lr = null;
    return `<${P.stringifyUri(uri)}>`;
  }

  /** Turn a dialled string into a SIP URI in this account's domain. */
  normalizeTarget(target) {
    const raw = String(target || '').trim();
    if (!raw) throw new Error('empty dial target');
    if (/^sips?:/i.test(raw)) return P.parseUri(raw);
    if (/^tel:/i.test(raw)) {
      return { scheme: 'sip', user: raw.slice(4).replace(/[^\d+*#]/g, ''), host: this.config.domain, params: {}, headers: {} };
    }
    if (raw.includes('@')) return P.parseUri(`sip:${raw}`);
    // A bare number or extension: strip dial formatting, keep + * #.
    const user = raw.replace(/[\s()\-.]/g, '');
    return { scheme: 'sip', user, host: this.config.domain, params: {}, headers: {} };
  }

  // ---- lifecycle ----------------------------------------------------------

  /** A line with no server or user cannot be brought up yet. */
  get configured() {
    return !!(String(this.config.domain || '').trim() && String(this.config.username || '').trim());
  }

  async start() {
    this.stopped = false;
    if (!this.configured) {
      this._setRegistration('unconfigured', { reason: 'Set a SIP server and username', expires: 0 });
      return;
    }
    await this._openTransport();
    if (this.config.register) await this.register();
    else this._setRegistration('registered', { expires: 0, reason: 'Registration disabled' });
    this._startKeepAlive();
  }

  /** Resolve the server and work out which local address reaches it. */
  async _resolve() {
    const proxy = this.config.outboundProxy || this.config.domain;
    const parsed = /^sips?:/i.test(proxy) ? P.parseUri(proxy) : P.parseUri(`sip:${proxy}`);

    const targets = await resolveTarget(parsed.host, parsed.port, this.transportType);
    if (!targets.length) throw new Error(`cannot resolve ${parsed.host}`);
    this.targets = targets;
    this.target = targets[0];
    this.localAddress = await localAddressFor(this.target.address);
    this.log.info('resolved server', { target: this.target, localAddress: this.localAddress });
  }

  async _openTransport() {
    await this._resolve();

    // The SIP socket binds to the wildcard address on purpose: a socket bound
    // to one specific IP dies with EADDRNOTAVAIL the moment that IP goes away
    // (DHCP renewal, Wi-Fi roam, VPN up/down, sleep). Wildcard sockets ride
    // through address changes; we then just re-register.
    this.transport = createTransport(this.transportType, {
      localPort: this.config.localPort || 0,
      localAddress: '0.0.0.0',
    });
    await this.transport.open();
    this.localPort = this.transport.localPort;

    this.transactions = new TransactionLayer(this.transport, { userAgent: this.userAgentString });
    this.transactions.on('request', (request, txn, rinfo) => this._onRequest(request, txn, rinfo));
    this.transactions.on('ack', (request) => this._onAck(request));
    this.transactions.on('response', (response) => this._onStrayResponse(response));
    this.transactions.on('error', (err) => this._onTransportError(err));
    this.transport.on('error', (err) => this._onTransportError(err));
    this.transactions.on('sent', (text, target) => this.log.sip('->', text, target));
    this.transactions.on('received', (text, rinfo) => this.log.sip('<-', text, rinfo));
    this.transactions.on('malformed', (err, text, rinfo) =>
      this.log.warn('malformed SIP message', { from: rinfo, error: err.message, head: String(text).slice(0, 120) }));

    this.log.info('transport open', { type: this.transportType, localPort: this.localPort });
    this.emit('transport', { localAddress: this.localAddress, localPort: this.localPort, target: this.target });
  }

  /**
   * A socket error almost always means the network underneath us changed.
   * Report it once, then recover: re-resolve, relearn addresses, re-register.
   */
  _onTransportError(err) {
    this.log.error('transport error', err);
    this.emit('error', err);
    if (this._recoveryTimer || this.stopped) return;
    this._recoveryTimer = setTimeout(() => {
      this._recoveryTimer = null;
      this.refreshNetwork('transport error').catch(() => {});
    }, 2000);
  }

  /**
   * Re-resolve the server, relearn our local and public addresses and
   * re-register. Called after sleep/resume, on network change, and after a
   * transport error. Established calls are left alone — their RTP sockets are
   * wildcard-bound, and the far end latches onto our new source address.
   */
  async refreshNetwork(reason = 'network change') {
    if (this.stopped || !this.configured || !this.transport) return;
    this.log.warn(`refreshing network: ${reason}`);
    const previous = { target: this.target, localAddress: this.localAddress, publicAddress: this.publicAddress };

    try {
      await this._resolve();
    } catch (err) {
      this.log.error('re-resolve failed, keeping previous server address', err);
    }
    // Whatever the registrar told us about our public address is stale now.
    this.publicAddress = null;
    this.publicPort = null;
    this._natReregistered = false;
    this.emit('natDiscovered', { address: null, port: null });

    if (this.config.register) {
      clearTimeout(this._registerTimer);
      this._setRegistration('registering', { reason: `Re-registering (${reason})` });
      await this.register();
    }
    this.log.info('network refresh done', { before: previous, after: { target: this.target, localAddress: this.localAddress } });
  }

  /** Periodic check: did the route to the server change under us? */
  async _checkNetwork() {
    if (!this.target || this.stopped || !this.transport) return;
    let address;
    try { address = await localAddressFor(this.target.address); } catch { return; }
    if (address && this.localAddress && address !== this.localAddress) {
      this.log.warn('local address changed', { from: this.localAddress, to: address });
      await this.refreshNetwork(`local address ${this.localAddress} -> ${address}`);
    }
  }

  async stop({ unregister = true } = {}) {
    this.stopped = true;
    clearTimeout(this._registerTimer);
    clearInterval(this._keepAliveTimer);
    clearTimeout(this._recoveryTimer);
    this._recoveryTimer = null;
    this.log.info('stopping', { unregister });

    for (const call of this.calls()) {
      try { await call.hangup('Account stopped'); } catch { /* best effort */ }
    }
    if (unregister && this.config.register && this.registration.state === 'registered') {
      try { await this._sendRegister(0); } catch { /* best effort */ }
    }
    this._setRegistration('unregistered', { reason: 'Stopped' });
    if (this.transactions) this.transactions.close();
    else if (this.transport) this.transport.close();
    this.transport = null;
    this.transactions = null;
  }

  // ---- registration -------------------------------------------------------

  async register() {
    if (!this.config.register || this.stopped) return;
    // A periodic refresh of a live binding is not a state change: the old
    // registration is still valid until it expires. Only show "registering"
    // when we are not currently registered.
    if (this.registration.state !== 'registered') this._setRegistration('registering', {});
    try {
      await this._sendRegister(this.config.registerExpires);
    } catch (err) {
      this._onRegisterFailure(err.message || 'Registration failed');
    }
  }

  async _sendRegister(expires) {
    if (!this.registerCallId) this.registerCallId = newCallId(this.localAddress || 'twinline');

    const build = () => {
      this.registerSeq += 1;
      const request = {
        method: 'REGISTER',
        uri: P.stringifyUri({ scheme: this.secure ? 'sips' : 'sip', host: this.config.domain, params: {}, headers: {} }),
        version: 'SIP/2.0',
        headers: {},
        body: '',
      };
      if (this.outboundRoute) request.headers.route = [this.outboundRoute];
      request.headers.via = [P.stringifyVia({
        transport: this.transportType,
        host: this.viaHost,
        port: this.viaPort,
        params: { branch: newBranch(), rport: null },
      })];
      request.headers['max-forwards'] = ['70'];
      const aor = this.addressOfRecord();
      request.headers.from = [P.stringifyNameAddr({
        name: this.config.displayName || null, uri: aor, params: { tag: newBranch().slice(7, 19) },
      })];
      request.headers.to = [P.stringifyNameAddr({ uri: aor, params: {} })];
      request.headers['call-id'] = [this.registerCallId];
      request.headers.cseq = [`${this.registerSeq} REGISTER`];
      request.headers.contact = [`${this.contactHeader()};expires=${expires}`];
      request.headers.expires = [String(expires)];
      request.headers.allow = [this.allowHeader()];
      request.headers.supported = ['path, outbound'];
      request.headers['user-agent'] = [this.userAgentString];
      return request;
    };

    const response = await this.sendRequestWithAuth(build(), this.target, { rebuild: build });

    if (expires === 0) {
      this._setRegistration('unregistered', { reason: 'Unregistered' });
      return response;
    }

    if (response.status === 423) {
      // Interval too brief: adopt the server's minimum and retry once.
      const min = parseInt(P.getHeader(response, 'min-expires') || '60', 10);
      this.config.registerExpires = Math.max(min, 60);
      return this._sendRegister(this.config.registerExpires);
    }

    if (response.status >= 200 && response.status < 300) {
      this._learnPublicAddress(response);
      const granted = this._grantedExpires(response, expires);
      this.registration.retries = 0;
      this._setRegistration('registered', { expires: granted, reason: null });

      // Refresh a little early so a lost packet does not drop the binding.
      const refreshIn = Math.max(10, Math.floor(granted * 0.9)) * 1000;
      clearTimeout(this._registerTimer);
      this._registerTimer = setTimeout(() => this.register(), refreshIn);
      return response;
    }

    this._onRegisterFailure(`${response.status} ${response.reason || ''}`.trim(), response.status);
    return response;
  }

  /** Read the expiry the registrar actually granted us. */
  _grantedExpires(response, requested) {
    for (const raw of P.getHeaders(response, 'contact')) {
      const contact = P.parseNameAddr(raw);
      if (contact.params.expires != null) {
        const value = parseInt(contact.params.expires, 10);
        if (!Number.isNaN(value) && value > 0) return value;
      }
    }
    const header = parseInt(P.getHeader(response, 'expires') || '', 10);
    return Number.isNaN(header) || header <= 0 ? requested : header;
  }

  /**
   * Discover our public address from the Via the registrar echoed back
   * (RFC 3581 rport). Re-register once when it changes so the binding points
   * at the address the provider can actually reach.
   */
  _learnPublicAddress(response) {
    const raw = P.getHeader(response, 'via');
    if (!raw) return;
    const via = P.parseVia(raw);
    const received = via.params.received;
    const rport = via.params.rport ? parseInt(via.params.rport, 10) : null;

    const newAddress = received || this.publicAddress;
    const newPort = rport || this.publicPort;
    const changed = (newAddress && newAddress !== this.publicAddress) || (newPort && newPort !== this.publicPort);

    if (!changed) return;
    this.publicAddress = newAddress;
    this.publicPort = newPort;
    this.emit('natDiscovered', { address: this.publicAddress, port: this.publicPort });

    if (!this._natReregistered) {
      this._natReregistered = true;
      setTimeout(() => this.register(), 50);
    }
  }

  _onRegisterFailure(reason, status) {
    if (status === 403 || status === 401 || status === 407) this.auth.clear();
    this.registration.retries += 1;
    const backoff = Math.min(300, 5 * Math.pow(2, Math.min(this.registration.retries, 6)));
    this._setRegistration('failed', { reason, expires: 0 });
    clearTimeout(this._registerTimer);
    if (!this.stopped) this._registerTimer = setTimeout(() => this.register(), backoff * 1000);
  }

  _setRegistration(state, patch) {
    const before = this.registration.state;
    this.registration = { ...this.registration, state, ...patch };
    if (before !== state || state === 'failed') {
      const entry = { from: before, to: state, reason: this.registration.reason, expires: this.registration.expires };
      if (state === 'failed') this.log.warn('registration', entry);
      else this.log.info('registration', entry);
    }
    this.emit('registration', { ...this.registration });
  }

  _startKeepAlive() {
    clearInterval(this._keepAliveTimer);
    // Even with keep-alives off, watch for network changes every 30 s.
    const seconds = this.config.keepAliveSeconds || 30;
    const ping = !!this.config.keepAliveSeconds;
    this._keepAliveTimer = setInterval(() => {
      if (ping && this.transport && this.target) this.transport.ping(this.target);
      this._checkNetwork().catch((err) => this.log.error('network check failed', err));
    }, seconds * 1000);
    this._keepAliveTimer.unref?.();
  }

  // ---- request sending with digest auth ----------------------------------

  /**
   * Send a non-INVITE request, retrying once with credentials on 401/407.
   * Resolves with the final response.
   */
  sendRequestWithAuth(request, target, { rebuild = null, dialog = null } = {}) {
    return new Promise((resolve, reject) => {
      const attempt = (req, tries) => {
        // Pre-authorise when we already hold a challenge for this account.
        if (tries === 0 && this.auth.hasChallenges) {
          this.auth.authorize(req, { method: req.method, uri: req.uri, body: req.body });
        }
        const txn = this.transactions.request(req, target);
        txn.on('final', (response) => {
          if ((response.status === 401 || response.status === 407) && tries < 2 && this.auth.addChallenges(response)) {
            let retry;
            if (rebuild) {
              retry = rebuild();
            } else {
              retry = { ...req, headers: { ...req.headers } };
              retry.headers.via = [P.stringifyVia({
                transport: this.transportType, host: this.viaHost, port: this.viaPort,
                params: { branch: newBranch(), rport: null },
              })];
              const cseq = P.parseCSeq(P.getHeader(req, 'cseq'));
              const nextSeq = dialog ? (dialog.localSeq += 1) : cseq.seq + 1;
              retry.headers.cseq = [`${nextSeq} ${cseq.method}`];
            }
            this.auth.authorize(retry, { method: retry.method, uri: retry.uri, body: retry.body });
            attempt(retry, tries + 1);
            return;
          }
          resolve(response);
        });
        txn.on('timeout', () => reject(new Error('request timed out')));
        txn.on('transportError', (err) => reject(err));
      };
      attempt(request, 0);
    });
  }

  /** Same, for in-dialog INVITEs (re-INVITE), which need provisional handling. */
  sendInviteWithAuth(request, target, dialog) {
    return new Promise((resolve, reject) => {
      const attempt = (req, tries) => {
        if (tries === 0 && this.auth.hasChallenges) {
          this.auth.authorize(req, { method: 'INVITE', uri: req.uri, body: req.body });
        }
        const txn = this.transactions.request(req, target);
        dialog.inviteTxn = txn;
        dialog.currentInvite = req;
        txn.on('final', (response) => {
          if ((response.status === 401 || response.status === 407) && tries < 2 && this.auth.addChallenges(response)) {
            const retry = { ...req, headers: { ...req.headers } };
            retry.headers.via = [P.stringifyVia({
              transport: this.transportType, host: this.viaHost, port: this.viaPort,
              params: { branch: newBranch(), rport: null },
            })];
            dialog.localSeq += 1;
            retry.headers.cseq = [`${dialog.localSeq} INVITE`];
            this.auth.authorize(retry, { method: 'INVITE', uri: retry.uri, body: retry.body });
            attempt(retry, tries + 1);
            return;
          }
          resolve(response);
        });
        txn.on('timeout', () => reject(new Error('re-INVITE timed out')));
        txn.on('transportError', (err) => reject(err));
      };
      attempt(request, 0);
    });
  }

  // ---- dialog registry ----------------------------------------------------

  registerDialog(call) {
    this.dialogs.set(call.dialogKey, call);
    if (!this.byCallId.has(call.callId)) this.byCallId.set(call.callId, new Set());
    this.byCallId.get(call.callId).add(call);
  }

  unregisterDialog(call) {
    for (const [key, value] of this.dialogs) if (value === call) this.dialogs.delete(key);
    const set = this.byCallId.get(call.callId);
    if (set) { set.delete(call); if (!set.size) this.byCallId.delete(call.callId); }
  }

  calls() {
    const seen = new Set();
    for (const set of this.byCallId.values()) for (const call of set) seen.add(call);
    return [...seen];
  }

  /** Find the dialog a request belongs to. */
  _findDialog(request) {
    const callId = P.getHeader(request, 'call-id');
    const to = P.parseNameAddr(P.getHeader(request, 'to') || '');
    const from = P.parseNameAddr(P.getHeader(request, 'from') || '');
    const direct = this.dialogs.get(`${callId}|${to.params.tag || ''}|${from.params.tag || ''}`);
    if (direct) return direct;

    // CANCEL and early-dialog requests may not carry both tags yet.
    const candidates = this.byCallId.get(callId);
    if (!candidates) return null;
    for (const call of candidates) {
      if (call.remoteTag && from.params.tag && call.remoteTag !== from.params.tag) continue;
      return call;
    }
    return null;
  }

  // ---- inbound ------------------------------------------------------------

  _onRequest(request, txn, rinfo) {
    this.transactions.stampVia(request, rinfo);
    const method = request.method;

    if (method === 'OPTIONS' && !P.parseNameAddr(P.getHeader(request, 'to') || '').params.tag) {
      const response = this.transactions.makeResponse(request, 200);
      response.headers.allow = [this.allowHeader()];
      response.headers.accept = ['application/sdp'];
      response.headers.contact = [this.contactHeader()];
      txn.respond(response);
      return;
    }

    const existing = this._findDialog(request);
    if (existing) { existing.handleRequest(request, txn); return; }

    if (method === 'INVITE') {
      const to = P.parseNameAddr(P.getHeader(request, 'to') || '');
      if (to.params.tag) {
        // In-dialog INVITE for a dialog we do not have.
        txn.respond(this.transactions.makeResponse(request, 481));
        return;
      }
      this._onIncomingInvite(request, txn);
      return;
    }

    if (method === 'MESSAGE') {
      txn.respond(this.transactions.makeResponse(request, 200));
      this.emit('message', {
        from: P.getHeader(request, 'from'),
        body: request.body,
        contentType: P.getHeader(request, 'content-type'),
      });
      return;
    }

    if (method === 'NOTIFY') {
      txn.respond(this.transactions.makeResponse(request, 200));
      this.emit('notify', request);
      return;
    }

    txn.respond(this.transactions.makeResponse(request, method === 'CANCEL' ? 481 : 405));
  }

  _onIncomingInvite(request, txn) {
    const gate = { allowed: true, reason: null };
    this.emit('beforeIncoming', gate);
    if (!gate.allowed) {
      txn.respond(this.transactions.makeResponse(request, 486, gate.reason || 'Busy Here'));
      return;
    }

    const call = new Call(this, { direction: 'in' });
    this.log.info('incoming INVITE', { from: P.getHeader(request, 'from'), callId: P.getHeader(request, 'call-id') });
    this.emit('call', call);
    call.handleInitialInvite(request, txn).catch((err) => {
      this.emit('error', err);
      try { txn.respond(this.transactions.makeResponse(request, 500)); } catch { /* noop */ }
    });
  }

  _onAck(request) {
    const call = this._findDialog(request);
    if (call) call.handleAck(request);
  }

  _onStrayResponse(response) {
    const cseq = P.parseCSeq(P.getHeader(response, 'cseq') || '');
    if (cseq.method !== 'INVITE' || response.status < 200 || response.status >= 300) return;
    // A retransmitted 2xx: our ACK was lost.
    const callId = P.getHeader(response, 'call-id');
    const to = P.parseNameAddr(P.getHeader(response, 'to') || '');
    const from = P.parseNameAddr(P.getHeader(response, 'from') || '');
    const call = this.dialogs.get(`${callId}|${from.params.tag || ''}|${to.params.tag || ''}`);
    if (call) call.onRetransmitted2xx();
  }

  /** Build a response inside `call`'s dialog, with our tag and Contact. */
  makeDialogResponse(request, status, call, reason) {
    const response = this.transactions.makeResponse(request, status, reason);
    const to = P.parseNameAddr(P.getHeader(request, 'to'));
    if (!to.params.tag && call) {
      to.params.tag = call.localTag;
      response.headers.to = [P.stringifyNameAddr(to)];
    }
    if (status >= 200 && status < 300) response.headers.contact = [this.contactHeader()];
    return response;
  }

  responseTargetFor(request) {
    return this.transactions.responseTarget(request, { address: this.target.address, port: this.target.port, transport: this.transportType });
  }

  // ---- outgoing -----------------------------------------------------------

  async dial(target, options) {
    if (!this.configured) throw new Error(`${this.config.label || this.id}: set a SIP server and username in Settings first`);
    if (!this.transactions) throw new Error(`${this.config.label || this.id} is not connected`);
    const call = new Call(this, { direction: 'out' });
    this.emit('call', call);
    await call.dial(target, options);
    return call;
  }

  /** Apply changed settings, restarting the transport when it must move. */
  async reconfigure(config) {
    const needsRestart =
      config.domain !== this.config.domain ||
      config.outboundProxy !== this.config.outboundProxy ||
      String(config.transport).toUpperCase() !== this.transportType ||
      Number(config.localPort || 0) !== Number(this.config.localPort || 0);

    const wasRegistered = this.registration.state === 'registered';
    this.config = { ...DEFAULTS, ...config };
    this.transportType = String(this.config.transport || 'UDP').toUpperCase();
    this.auth.setCredentials(this.config.authUsername || this.config.username, this.config.password);

    // A line that was never brought up (missing server/username) starts now
    // that it has been filled in.
    if (needsRestart || (!this.transport && this.configured)) {
      await this.stop({ unregister: wasRegistered });
      if (this.config.enabled) await this.start();
      return;
    }
    if (!this.configured) {
      this._setRegistration('unconfigured', { reason: 'Set a SIP server and username', expires: 0 });
      return;
    }
    if (this.config.register) await this.register();
  }

  status() {
    return {
      id: this.id,
      enabled: this.config.enabled,
      label: this.config.label || this.config.username || `Line ${this.id}`,
      username: this.config.username,
      domain: this.config.domain,
      transport: this.transportType,
      registration: { ...this.registration },
      localAddress: this.localAddress,
      localPort: this.localPort,
      publicAddress: this.publicAddress,
      target: this.target,
    };
  }
}

module.exports = { UserAgent, DEFAULTS, DEFAULT_PORTS };
