'use strict';
/**
 * Settings persistence.
 *
 * Passwords are encrypted at rest with Electron's safeStorage (DPAPI on
 * Windows, the system keyring on Linux) whenever it is available, and are
 * never written to disk in the clear unless the platform offers no backend —
 * in which case the file is created 0600 and the UI says so.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SECRET_PREFIX = 'enc:v1:';

function defaultAccount(index) {
  return {
    id: `line${index}`,
    label: `Line ${index}`,
    enabled: index === 1,
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
    dtmfMode: 'rfc2833',
    holdDirection: 'sendonly',
    publicAddress: '',
  };
}

const DEFAULT_SETTINGS = {
  version: 1,
  accounts: [defaultAccount(1), defaultAccount(2)],
  audio: {
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    ringtoneDeviceId: 'default',
    micGain: 1,
    speakerGain: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ringVolume: 0.7,
  },
  behaviour: {
    autoAnswerSeconds: 0,
    maxCalls: 4,
    holdOnAnswer: true,
    minimiseToTray: true,
    startMinimised: false,
    mediaPortRange: [16384, 32766],
    incomingPopup: true,
    // Where the user last dragged the incoming-call popup; null = centred.
    popupPosition: null,
    // Record every SIP message in the log file (troubleshooting only).
    sipTrace: false,
  },
  updates: {
    mode: 'ask',           // ask | auto | off
    url: '',               // empty = the server baked in at build time
  },
};

class SettingsStore {
  /**
   * @param {string} dir       directory to store settings.json in
   * @param {object} [crypto]  Electron safeStorage, when available
   */
  constructor(dir, crypto = null) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.crypto = crypto;
    this.data = null;
  }

  get encryptionAvailable() {
    try {
      return !!(this.crypto && this.crypto.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = mergeDefaults(parsed, DEFAULT_SETTINGS);
    } catch {
      this.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
    for (const account of this.data.accounts) {
      account.password = this._decrypt(account.password);
    }
    return this.data;
  }

  save(data) {
    if (data) this.data = mergeDefaults(data, DEFAULT_SETTINGS);
    const onDisk = JSON.parse(JSON.stringify(this.data));
    for (const account of onDisk.accounts) {
      account.password = this._encrypt(account.password);
    }

    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    if (os.platform() !== 'win32') {
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
    }
    return this.data;
  }

  _encrypt(value) {
    if (!value) return '';
    if (!this.encryptionAvailable) return value;
    try {
      return SECRET_PREFIX + this.crypto.encryptString(value).toString('base64');
    } catch {
      return value;
    }
  }

  _decrypt(value) {
    if (typeof value !== 'string' || !value.startsWith(SECRET_PREFIX)) return value || '';
    if (!this.encryptionAvailable) return '';
    try {
      return this.crypto.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64'));
    } catch {
      return '';
    }
  }

  /** Settings with passwords replaced by a placeholder, for the renderer. */
  redacted() {
    const copy = JSON.parse(JSON.stringify(this.data));
    for (const account of copy.accounts) {
      account.hasPassword = !!account.password;
      account.password = account.password ? '••••••••' : '';
    }
    copy.encryptionAvailable = this.encryptionAvailable;
    return copy;
  }

  /**
   * Merge an update from the renderer, keeping any password the user did not
   * retype (the UI sends the placeholder back unchanged).
   */
  applyUpdate(update) {
    const current = this.data;
    const merged = mergeDefaults(update, DEFAULT_SETTINGS);
    for (const account of merged.accounts) {
      const existing = current.accounts.find((a) => a.id === account.id);
      if (!existing) continue;
      if (!account.password || /^[•*]+$/.test(account.password)) {
        account.password = existing.password;
      }
    }
    return this.save(merged);
  }
}

/** Deep-merge `value` over `defaults`, keeping the defaults' shape. */
function mergeDefaults(value, defaults) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : defaults.slice();
  if (defaults && typeof defaults === 'object') {
    const out = {};
    for (const key of new Set([...Object.keys(defaults), ...Object.keys(value || {})])) {
      out[key] = key in defaults
        ? mergeDefaults(value ? value[key] : undefined, defaults[key])
        : (value ? value[key] : undefined);
    }
    return out;
  }
  return value === undefined ? defaults : value;
}

module.exports = { SettingsStore, DEFAULT_SETTINGS, defaultAccount, mergeDefaults };
