'use strict';
/**
 * Bluetooth headset profiles on Linux.
 *
 * A Bluetooth headset has two faces: A2DP (stereo music, no microphone) and
 * HSP/HFP ("headset", mono, with a microphone). Windows flips between them
 * by itself when a communications app opens the microphone and flips back
 * afterwards. PipeWire/PulseAudio only do that when a capture stream is
 * aimed at the headset itself, and a browser engine asks for "the default
 * microphone", which under A2DP is not the headset — so the far end heard
 * nothing (Mike, Fedora, 2026-10-06). Do what Windows does: when a call
 * starts, put every Bluetooth card that is in A2DP into its headset profile;
 * when the last call ends, put it back. `pactl` talks to both PulseAudio and
 * pipewire-pulse, so one code path covers every mainstream desktop.
 */

const { execFile } = require('child_process');
const log = require('./log').child('bluetooth');

/** Headset profiles in order of preference (mSBC is the better-sounding HFP codec). */
const HEADSET_PREFERENCE = [
  /^headset-head-unit-msbc$/, /^headset_head_unit_msbc$/,
  /^headset-head-unit$/, /^headset_head_unit$/,
  /^headset-head-unit-/, /^headset_head_unit_/,
  /^handsfree_head_unit/, /^handsfree-head-unit/, /^hfp_hf/, /^hsp_hs/,
];

/**
 * Parse `pactl list cards` into Bluetooth cards with their profiles.
 * @returns {Array<{name: string, active: string, profiles: Array<{name: string, available: boolean}>}>}
 */
function parseCards(text) {
  const cards = [];
  let card = null;
  let inProfiles = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^Card #/.test(line)) { card = { name: '', active: '', profiles: [] }; cards.push(card); inProfiles = false; continue; }
    if (!card) continue;
    const m = /^\s+(\S[^:]*):\s*(.*)$/.exec(line);
    const indent = line.length - line.trimStart().length;
    if (indent === 1 && m) {
      // A top-level field of the card ("\tName: …", "\tProfiles:", "\tActive Profile: …").
      inProfiles = m[1] === 'Profiles';
      if (m[1] === 'Name') card.name = m[2].trim();
      if (m[1] === 'Active Profile') card.active = m[2].trim();
      continue;
    }
    if (inProfiles && indent >= 2) {
      const p = /^\s+([^:\s]+):\s.*available:\s*(yes|no|unknown)\)?\s*$/.exec(line);
      if (p) card.profiles.push({ name: p[1], available: p[2] !== 'no' });
    }
  }
  return cards.filter((c) => /^bluez_card\./.test(c.name));
}

/** The profile to switch a card to for a call, or null if it has none / is already there. */
function headsetProfileFor(card) {
  if (!/^a2dp/.test(card.active)) return null;
  for (const re of HEADSET_PREFERENCE) {
    const hit = card.profiles.find((p) => p.available && re.test(p.name));
    if (hit) return hit.name;
  }
  return null;
}

function pactl(args, { exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec('pactl', args, { timeout: 4000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

class BluetoothProfiles {
  constructor({ exec = execFile, enabled = () => true } = {}) {
    this.exec = exec;
    this.enabled = enabled;
    /** @type {Map<string, string>} card name -> profile to restore */
    this.restore = new Map();
    this.inCall = false;
    this._restoreTimer = null;
    this._missing = false;              // pactl not installed: say so once, then stay quiet
    this._busy = Promise.resolve();
  }

  /** Called with every call-state snapshot; switches on the first live call, restores after the last. */
  update(calls) {
    if (process.platform !== 'linux' || !this.enabled()) return;
    const live = calls.some((c) => c.state === 'calling' || c.state === 'ringing' || c.state === 'connected');
    if (live && !this.inCall) {
      this.inCall = true;
      clearTimeout(this._restoreTimer);
      this._queue(() => this.switchToHeadset());
    } else if (!live && this.inCall) {
      this.inCall = false;
      // A short grace period: back-to-back calls should not flap the headset.
      clearTimeout(this._restoreTimer);
      this._restoreTimer = setTimeout(() => this._queue(() => this.restoreProfiles()), 2000);
      this._restoreTimer.unref?.();
    }
  }

  _queue(fn) {
    this._busy = this._busy.then(fn, fn).catch((err) => log.warn('bluetooth profile step failed', err));
    return this._busy;
  }

  async switchToHeadset() {
    let cards;
    try {
      cards = parseCards(await pactl(['list', 'cards'], { exec: this.exec }));
    } catch (err) {
      if (!this._missing) { this._missing = true; log.info('pactl unavailable; Bluetooth profiles are left to the desktop', { error: err.message }); }
      return;
    }
    for (const card of cards) {
      const target = headsetProfileFor(card);
      if (!target) continue;
      try {
        await pactl(['set-card-profile', card.name, target], { exec: this.exec });
        this.restore.set(card.name, card.active);
        log.info('switched Bluetooth headset to call profile', { card: card.name, from: card.active, to: target });
      } catch (err) {
        log.warn('could not switch Bluetooth profile', { card: card.name, to: target, error: err.message });
      }
    }
  }

  async restoreProfiles() {
    for (const [card, profile] of [...this.restore]) {
      try {
        await pactl(['set-card-profile', card, profile], { exec: this.exec });
        log.info('restored Bluetooth headset profile', { card, to: profile });
      } catch (err) {
        log.warn('could not restore Bluetooth profile', { card, to: profile, error: err.message });
      }
      this.restore.delete(card);
    }
  }
}

module.exports = { BluetoothProfiles, parseCards, headsetProfileFor };
