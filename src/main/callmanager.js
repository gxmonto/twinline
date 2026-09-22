'use strict';
/**
 * Orchestrates accounts and calls: which call has the user's ear, what is on
 * hold, and who is in the conference.
 *
 * The conference is explicit state — a set of call ids — rather than "whatever
 * happens to be bridged right now". That distinction matters for hold: a
 * member put on hold stays a member, and resuming them (or the conference)
 * brings them straight back into the bridge instead of dissolving it.
 *
 * Invariants:
 *   - At most one non-conference call is audible at a time.
 *   - The conference, as a whole, behaves like one line: answering or dialling
 *     something else holds every member; resuming any member resumes them all.
 *   - A member's mixer mode is derived (see Call._applyMediaFlow): 'conference'
 *     while connected and not held, 'idle' otherwise.
 *   - Dropping one member leaves the others exactly as they were.
 */

const { EventEmitter } = require('events');
const { UserAgent } = require('./sip/useragent');
const log = require('./log').child('calls');

const MAX_HISTORY = 300;

class CallManager extends EventEmitter {
  constructor({ audio, maxCalls = 4, contacts = null, transcription = null }) {
    super();
    this.audio = audio;
    this.maxCalls = maxCalls;
    this.contacts = contacts;                 // optional ContactStore for name lookup
    this.transcription = transcription;       // optional TranscriptionService
    if (transcription) {
      transcription.on('finished', (t) => {
        // Attach the saved transcript to the matching history entry.
        const entry = this.history.find((h) => h.id === t.callId);
        if (entry) { entry.transcript = t.file; entry.transcriptLines = t.lines.length; this.emit('history', this.history.slice(0, 50)); }
        this._emitCalls();
      });
      transcription.on('started', () => this._emitCalls());
    }
    /** @type {Map<string, UserAgent>} */
    this.accounts = new Map();
    /** @type {Map<string, import('./sip/call').Call>} */
    this.calls = new Map();
    /** @type {Set<string>} */
    this.conferenceIds = new Set();
    this.history = [];
    this.muted = false;

    this.audio.on('dtmf', (callId, digit) => this.emit('dtmf', { callId, digit }));
    this.audio.on('levels', (levels) => this.emit('levels', levels));
    this.audio.on('error', (err, callId) => log.error('media error', { callId, error: err }));
  }

  /**
   * The network changed under us (resume from sleep, VPN, Wi-Fi roam, an
   * interface came back): every line re-resolves and re-registers.
   */
  async refreshNetwork(reason = 'network change') {
    log.warn(`network refresh requested: ${reason}`);
    await Promise.all([...this.accounts.values()].map((ua) =>
      ua.refreshNetwork(reason).catch((err) => log.error('refresh failed', { account: ua.id, error: err }))));
    this._emitAccounts();
    return { ok: true };
  }

  // ---- accounts -----------------------------------------------------------

  async applyAccounts(configs) {
    const seen = new Set();

    for (const config of configs) {
      seen.add(config.id);
      const existing = this.accounts.get(config.id);

      if (!existing) {
        if (!config.enabled) continue;
        await this._startAccount(config);
        continue;
      }
      if (!config.enabled) {
        await existing.stop();
        this.accounts.delete(config.id);
        this._emitAccounts();
        continue;
      }
      try {
        await existing.reconfigure(config);
      } catch (err) {
        this.emit('accountError', { id: config.id, message: err.message });
      }
      this._emitAccounts();
    }

    for (const [id, ua] of [...this.accounts]) {
      if (!seen.has(id)) { await ua.stop(); this.accounts.delete(id); }
    }
    this._emitAccounts();
  }

  async _startAccount(config) {
    const ua = new UserAgent(config, this.audio);
    this.accounts.set(config.id, ua);

    ua.on('registration', () => this._emitAccounts());
    ua.on('natDiscovered', () => this._emitAccounts());
    ua.on('transport', () => this._emitAccounts());
    ua.on('error', (err) => this.emit('accountError', { id: config.id, message: err.message, code: err.code }));
    ua.on('message', (msg) => this.emit('message', { accountId: config.id, ...msg }));
    ua.on('beforeIncoming', (gate) => {
      if (this.activeCalls().length >= this.maxCalls) {
        gate.allowed = false;
        gate.reason = 'Busy Here';
      }
    });
    ua.on('call', (call) => this._trackCall(call));

    try {
      await ua.start();
    } catch (err) {
      this.emit('accountError', { id: config.id, message: err.message });
    }
    this._emitAccounts();
  }

  account(id) {
    const ua = this.accounts.get(id);
    if (!ua) throw new Error(`no such account: ${id}`);
    return ua;
  }

  /** The account to use when the caller did not name one. */
  defaultAccount() {
    for (const ua of this.accounts.values()) {
      if (ua.registration.state === 'registered') return ua;
    }
    const first = this.accounts.values().next();
    if (first.done) throw new Error('no accounts configured');
    return first.value;
  }

  // ---- call tracking ------------------------------------------------------

  _trackCall(call) {
    if (this.calls.has(call.id)) return;
    this.calls.set(call.id, call);

    call.on('update', () => this._emitCalls());
    call.on('state', (state) => {
      this.emit('callState', { callId: call.id, state });
      if (state === 'incoming') this.emit('incoming', this._describe(call));
      if (state === 'connected' && this.transcription && this.transcription.settings.autoStart) {
        this.startTranscription(call.id).catch((err) => this.emit('warning', { callId: call.id, message: err.message }));
      }
    });
    call.on('dtmf', (digit) => this.emit('dtmf', { callId: call.id, digit }));
    call.on('warning', (message) => this.emit('warning', { callId: call.id, message }));
    call.on('referred', (target) => this.emit('referred', { callId: call.id, target }));
    call.on('terminated', (info) => {
      this._recordHistory(call, info);
      this.calls.delete(call.id);
      this._onMemberGone(call.id);
      if (this.transcription && this.transcription.isActive(call.id)) {
        this.transcription.stop(call.id, { reason: 'call ended' }).catch((err) => log.error('transcript stop failed', err));
      }
      this._emitCalls();
      this.emit('callEnded', { callId: call.id, remoteNumber: call.remoteNumber, ...info });
    });

    this._emitCalls();
  }

  _recordHistory(call, info) {
    this.history.unshift({
      id: call.id,
      accountId: call.accountId,
      direction: call.direction,
      remoteNumber: call.remoteNumber,
      remoteName: call.remoteDisplayName || null,
      contactName: this._contactName(call.remoteNumber),
      startedAt: call.createdAt,
      answeredAt: call.answeredAt,
      endedAt: call.endedAt,
      durationMs: call.answeredAt ? (call.endedAt - call.answeredAt) : 0,
      missed: call.direction === 'in' && !call.answeredAt,
      reason: info.reason,
      status: info.status,
    });
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
    this.emit('history', this.history.slice(0, 50));
  }

  _contactName(number) {
    if (!this.contacts || !number) return null;
    const match = this.contacts.findByNumber(number);
    return match ? match.name : null;
  }

  /** Call snapshot plus everything the manager knows about it. */
  _describe(call) {
    return {
      ...call.toJSON(),
      inConference: this.conferenceIds.has(call.id),
      contactName: this._contactName(call.remoteNumber),
      audible: this.audio.mixer.getLegMode(call.id) !== 'idle',
      transcribing: !!(this.transcription && this.transcription.isActive(call.id)),
    };
  }

  // ---- transcription ------------------------------------------------------

  async startTranscription(callId) {
    if (!this.transcription) throw new Error('transcription is not available');
    const call = this.call(callId);
    if (call.state !== 'connected') throw new Error('the call must be connected first');
    await this.transcription.start({
      callId: call.id,
      accountId: call.accountId,
      remoteNumber: call.remoteNumber,
      remoteName: call.remoteDisplayName,
      contactName: this._contactName(call.remoteNumber),
      answeredAt: call.answeredAt,
    });
    this._emitCalls();
    return this._describe(call);
  }

  async stopTranscription(callId) {
    if (!this.transcription) throw new Error('transcription is not available');
    const result = await this.transcription.stop(callId, { reason: 'stopped by user' });
    this._emitCalls();
    return result;
  }

  call(callId) {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`no such call: ${callId}`);
    return call;
  }

  activeCalls() {
    return [...this.calls.values()].filter((c) => c.state !== 'terminated');
  }

  /** Connected calls the user can currently hear. */
  _audibleCalls() {
    return this.activeCalls().filter((c) =>
      c.state === 'connected' && this.audio.mixer.getLegMode(c.id) !== 'idle');
  }

  get conferenceRunning() {
    return this.conferenceIds.size >= 2;
  }

  // ---- conference bookkeeping ---------------------------------------------

  /** Push membership into each call so it derives the right mixer mode. */
  _syncConference() {
    for (const id of [...this.conferenceIds]) {
      if (!this.calls.has(id)) this.conferenceIds.delete(id);
    }
    // A conference needs two other people. With fewer, the survivor is just
    // an ordinary call again.
    if (this.conferenceIds.size < 2) this.conferenceIds.clear();

    for (const call of this.activeCalls()) {
      const member = this.conferenceIds.has(call.id);
      if (call.conferenceMember !== member) {
        call.conferenceMember = member;
        call.applyMediaFlow();
      }
    }
  }

  _onMemberGone(callId) {
    if (!this.conferenceIds.has(callId)) return;
    this.conferenceIds.delete(callId);
    this._syncConference();
    this.emit('conference', { members: [...this.conferenceIds] });
  }

  /**
   * Put every audible call on hold except `except`. When `except` is a
   * conference member, its fellow members are spared too — the conference
   * moves as one unit.
   */
  async _holdEverythingAudible({ except = null } = {}) {
    const spare = new Set([except]);
    if (except && this.conferenceIds.has(except)) {
      for (const id of this.conferenceIds) spare.add(id);
    }
    const targets = this._audibleCalls().filter((c) => !spare.has(c.id));
    await Promise.all(targets.map((c) => c.hold().catch(() => {})));
  }

  // ---- call control -------------------------------------------------------

  async dial(target, { accountId } = {}) {
    if (this.activeCalls().length >= this.maxCalls) {
      throw new Error(`maximum of ${this.maxCalls} simultaneous calls reached`);
    }
    const ua = accountId ? this.account(accountId) : this.defaultAccount();
    await this._holdEverythingAudible();
    const call = await ua.dial(target);
    return this._describe(call);
  }

  async answer(callId) {
    const call = this.call(callId);
    await this._holdEverythingAudible({ except: callId });
    await call.accept();
    this._emitCalls();
    return this._describe(call);
  }

  reject(callId, status = 486) {
    this.call(callId).reject(status);
    return { ok: true };
  }

  async hangup(callId) {
    await this.call(callId).hangup();
    return { ok: true };
  }

  async hangupAll() {
    await Promise.all(this.activeCalls().map((c) => c.hangup().catch(() => {})));
    return { ok: true };
  }

  /** Hold one call. A conference member stays a member while held. */
  async hold(callId) {
    const call = this.call(callId);
    await call.hold();
    this._emitCalls();
    return this._describe(call);
  }

  /**
   * Resume a call. For a conference member this resumes the whole
   * conference; for anything else it takes the ear away from whatever had it.
   */
  async unhold(callId) {
    const call = this.call(callId);
    await this._holdEverythingAudible({ except: callId });

    if (this.conferenceIds.has(callId)) {
      const members = [...this.conferenceIds].map((id) => this.calls.get(id)).filter(Boolean);
      await Promise.all(members.map((c) => (c.localHold ? c.unhold().catch(() => {}) : null)));
    } else {
      await call.unhold();
    }
    this._syncConference();
    this._emitCalls();
    return this._describe(call);
  }

  /** Swap which call (or conference) the user is talking to. */
  async setActive(callId) {
    const call = this.call(callId);
    if (call.state === 'incoming') return this.answer(callId);
    return this.unhold(callId);
  }

  // ---- conference ---------------------------------------------------------

  /**
   * Bridge the given calls (default: every connected call) into one
   * conference. Mixing happens locally, so each leg stays an independent
   * dialog that can be held or dropped on its own.
   */
  async conference(callIds = null) {
    const ids = callIds && callIds.length
      ? callIds
      : this.activeCalls().filter((c) => c.state === 'connected').map((c) => c.id);

    const calls = ids.map((id) => this.call(id)).filter((c) => c.state === 'connected');
    if (calls.length < 2) throw new Error('need at least two connected calls to conference');

    this.conferenceIds = new Set(calls.map((c) => c.id));
    this._syncConference();

    // Non-members lose the ear; members all come off hold.
    await this._holdEverythingAudible({ except: calls[0].id });
    await Promise.all(calls.map((c) => (c.localHold ? c.unhold().catch(() => {}) : null)));

    this._syncConference();
    this._emitCalls();
    this.emit('conference', { members: [...this.conferenceIds] });
    return this.snapshot();
  }

  /** Add one more connected call to the running conference. */
  async addToConference(callId) {
    if (!this.conferenceRunning) throw new Error('no conference is running');
    return this.conference([...this.conferenceIds, callId]);
  }

  /**
   * Hold one party without removing them from the conference. Everyone else
   * keeps talking; Resume brings the held party back into the bridge.
   */
  async holdConferenceParty(callId) {
    if (!this.conferenceIds.has(callId)) throw new Error('that call is not in the conference');
    const call = this.call(callId);
    await call.hold();
    this._emitCalls();
    this.emit('conference', { members: [...this.conferenceIds] });
    return this.snapshot();
  }

  /** Bring a held conference party back into the bridge. */
  async resumeConferenceParty(callId) {
    if (!this.conferenceIds.has(callId)) throw new Error('that call is not in the conference');
    const call = this.call(callId);
    await call.unhold();
    this._syncConference();
    this._emitCalls();
    return this.snapshot();
  }

  /**
   * Take a party out of the conference entirely, leaving them on hold as an
   * ordinary call. Resuming them later does not rejoin the conference.
   */
  async removeFromConference(callId) {
    if (!this.conferenceIds.has(callId)) throw new Error('that call is not in the conference');
    const call = this.call(callId);
    this.conferenceIds.delete(callId);
    await call.hold();
    this._syncConference();
    this._emitCalls();
    this.emit('conference', { members: [...this.conferenceIds] });
    return this.snapshot();
  }

  /**
   * Hang up on one conference party only. The rest of the conference — or the
   * one remaining call — carries on untouched.
   */
  async hangupConferenceParty(callId) {
    if (!this.conferenceIds.has(callId)) throw new Error('that call is not in the conference');
    await this.call(callId).hangup('Removed from conference');
    // The 'terminated' handler prunes membership and re-syncs.
    this._emitCalls();
    return this.snapshot();
  }

  /**
   * End the conference but keep everyone on the line: one party stays active
   * (the first, unless told otherwise) and the others go on hold.
   */
  async splitConference(keepActiveId = null) {
    if (!this.conferenceIds.size) throw new Error('no conference is running');
    const members = [...this.conferenceIds];
    const keep = keepActiveId && members.includes(keepActiveId) ? keepActiveId : members[0];

    this.conferenceIds.clear();
    this._syncConference();

    await Promise.all(members.map((id) => {
      const call = this.calls.get(id);
      if (!call || call.state !== 'connected') return null;
      return id === keep
        ? (call.localHold ? call.unhold().catch(() => {}) : null)
        : (call.localHold ? null : call.hold().catch(() => {}));
    }));

    this._emitCalls();
    this.emit('conference', { members: [] });
    return this.snapshot();
  }

  /** Hang up on every conference party at once. */
  async endConference() {
    const members = [...this.conferenceIds];
    await Promise.all(members.map((id) => this.calls.get(id)?.hangup('Conference ended').catch(() => {})));
    this.conferenceIds.clear();
    this._emitCalls();
    this.emit('conference', { members: [] });
    return this.snapshot();
  }

  // ---- misc ---------------------------------------------------------------

  dtmf(callId, digit) {
    this.call(callId).sendDtmf(digit);
    return { ok: true };
  }

  setMuted(muted) {
    this.muted = !!muted;
    this.audio.setMicMuted(this.muted);
    this._emitCalls();
    return { muted: this.muted };
  }

  setSpeakerGain(gain) {
    this.audio.setSpeakerGain(gain);
    return { ok: true };
  }

  setMicGain(gain) {
    this.audio.setMicGain(gain);
    return { ok: true };
  }

  async transferBlind(callId, target) {
    await this.call(callId).transferBlind(target);
    return { ok: true };
  }

  async transferAttended(callId, otherCallId) {
    await this.call(callId).transferAttended(this.call(otherCallId));
    return { ok: true };
  }

  snapshot() {
    return {
      calls: this.activeCalls().map((c) => this._describe(c)),
      conference: [...this.conferenceIds],
      conferenceRunning: this.conferenceRunning,
      muted: this.muted,
      accounts: [...this.accounts.values()].map((ua) => ua.status()),
      transcription: this.transcription ? this.transcription.status() : null,
    };
  }

  _emitCalls() {
    this.emit('calls', this.snapshot());
  }

  _emitAccounts() {
    this.emit('accounts', [...this.accounts.values()].map((ua) => ua.status()));
    this._emitCalls();
  }

  async shutdown() {
    await this.hangupAll().catch(() => {});
    if (this.transcription) await this.transcription.shutdown().catch(() => {});
    for (const ua of this.accounts.values()) await ua.stop().catch(() => {});
    this.accounts.clear();
    this.audio.closeAll();
  }
}

module.exports = { CallManager };
