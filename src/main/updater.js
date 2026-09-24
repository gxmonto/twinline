'use strict';
/**
 * Update checking and installation, built on electron-updater.
 *
 * Feed: any HTTPS folder holding the files electron-builder writes into
 * dist/<version>/ (`latest.yml`, the Setup exe and its .blockmap; for Linux
 * `latest-linux.yml` and the AppImage), or a GitHub repository's Releases.
 * The URL comes from package.json `build.publish` at build time and can be
 * overridden at runtime from Settings, so moving hosts needs no rebuild.
 *
 * Modes:
 *   'ask'  check, tell the user, download only when they say so (default)
 *   'auto' check and download silently, then offer to restart
 *   'off'  never check (manual "Check now" still works)
 *
 * An update is never installed while a call is up.
 *
 * Linux: AppImage updates in place. .deb/.rpm cannot be replaced from inside
 * the app, so on those we only check the feed and hand the user a link.
 */

const { EventEmitter } = require('events');
const https = require('https');
const http = require('http');
const { app, shell } = require('electron');
const log = require('./log').child('updater');
const { isLocalNetwork, followRedirect } = require('./urlpolicy');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;

/** Compare dotted versions with optional pre-release; negative if a < b. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).trim().replace(/^v/, '').split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || null };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d;
  }
  // A pre-release sorts before the plain release of the same numbers.
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return String(x.pre || '').localeCompare(String(y.pre || ''));
}

/** The handful of fields we need from electron-builder's latest*.yml. */
function parseLatestYml(text) {
  const out = { files: [] };
  let notes = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = /^version:\s*(.+)$/.exec(line))) out.version = unquote(m[1]);
    else if ((m = /^path:\s*(.+)$/.exec(line))) out.path = unquote(m[1]);
    else if ((m = /^releaseDate:\s*(.+)$/.exec(line))) out.releaseDate = unquote(m[1]);
    else if ((m = /^\s+-\s+url:\s*(.+)$/.exec(line))) out.files.push({ url: unquote(m[1]) });
    else if (/^releaseNotes:\s*[|>]/.test(line)) notes = [];
    else if (notes && /^\s{2,}/.test(line)) notes.push(line.replace(/^\s{2}/, ''));
    else if (notes && line !== '') notes = null;
  }
  if (notes) out.releaseNotes = notes.join('\n').trim();
  return out;
}

function unquote(s) {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: { 'user-agent': `TwinLine/${app.getVersion()}` } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        // The redirect must not drop the manifest onto plain http (M3).
        let next;
        try { next = followRedirect(url, res.headers.location); } catch (err) { reject(err); return; }
        resolve(fetchText(next, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(new Error('response too large')); });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timed out')));
  });
}

/**
 * Turn a user-entered URL into an electron-updater publish config.
 *   https://github.com/owner/repo       -> GitHub Releases
 *   https://example.com/path/           -> generic folder
 */
function feedFromUrl(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error('Update server must be a full URL (https://…).'); }
  // An installer fetched over plain HTTP could be swapped on the way in and
  // its manifest with it, so http is only allowed for a machine on the local
  // network — the case for rehearsing an update with tools/serve-updates.js.
  if (parsed.protocol === 'http:' && !isLocalNetwork(parsed.hostname)) {
    throw new Error('Update server must use https:// (plain http is only allowed for local-network addresses).');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Update server must be an http(s) URL.');
  }
  const gh = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(u);
  if (gh) return { provider: 'github', owner: gh[1], repo: gh[2].replace(/\.git$/, '') };
  return { provider: 'generic', url: u.replace(/\/+$/, '') };
}

/**
 * Which Linux package manager owns this install: 'rpm', 'deb', or null (an
 * AppImage, a dev checkout, or something we cannot tell). Asked of the
 * package databases themselves; the distro family is only a fallback.
 */
function linuxPackageKind({ execFileSync = require('child_process').execFileSync, readFile = require('fs').readFileSync } = {}) {
  if (process.platform !== 'linux' || process.env.APPIMAGE) return null;
  const owns = (cmd, args) => {
    try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 3000 }); return true; } catch { return false; }
  };
  if (owns('rpm', ['-q', 'twinline'])) return 'rpm';
  if (owns('dpkg-query', ['-W', 'twinline'])) return 'deb';
  try {
    const os = readFile('/etc/os-release', 'utf8');
    const like = `${(/^ID=(.*)$/m.exec(os) || [])[1] || ''} ${(/^ID_LIKE=(.*)$/m.exec(os) || [])[1] || ''}`.toLowerCase();
    if (/fedora|rhel|centos|suse|opensuse|mageia/.test(like)) return 'rpm';
    if (/debian|ubuntu/.test(like)) return 'deb';
  } catch { /* no os-release */ }
  return null;
}

/**
 * The file a .deb/.rpm user should be sent to for `version`. The manifest
 * electron-builder writes (latest-linux.yml) only names the AppImage, and
 * handing that to a browser downloads it straight away — which is exactly
 * what a Fedora user with the rpm installed does not want. So name the
 * package the release workflow publishes, or fall back to the release page.
 */
function linuxDownloadUrl(feed, version, kind, arch = process.arch) {
  const v = String(version);
  const file = kind === 'rpm' ? `twinline-${v}.${arch === 'arm64' ? 'aarch64' : 'x86_64'}.rpm`
    : kind === 'deb' ? `twinline_${v}_${arch === 'arm64' ? 'arm64' : 'amd64'}.deb`
    : null;
  if (feed.provider === 'github') {
    const repo = `https://github.com/${feed.owner}/${feed.repo}/releases`;
    return file ? `${repo}/download/v${v}/${file}` : `${repo}/tag/v${v}`;
  }
  return file ? `${feed.url}/${file}` : `${feed.url}/`;
}

/** Where the Linux manifest lives for a given feed. */
function linuxManifestUrl(feed) {
  if (!feed) return null;
  if (feed.provider === 'github') {
    return `https://github.com/${feed.owner}/${feed.repo}/releases/latest/download/latest-linux.yml`;
  }
  return `${feed.url}/latest-linux.yml`;
}

class Updater extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => boolean} opts.inCall   true while any call is active
   */
  constructor({ inCall = () => false } = {}) {
    super();
    this.inCall = inCall;
    this.settings = { mode: 'ask', url: '' };
    this.feed = null;                       // runtime override, null = app-update.yml
    this.status = {
      state: 'idle',                        // idle|checking|available|downloading|downloaded|up-to-date|error|unsupported|disabled
      current: app.getVersion(),
      version: null,
      notes: null,
      progress: null,
      error: null,
      lastCheck: null,
      manualDownloadUrl: null,              // set when we can only point at a file
      packageKind: null,                    // 'rpm' | 'deb' when the download is a package
      pendingInstall: false,
    };
    this._timer = null;
    this._auto = null;
    this._supported = app.isPackaged;
    // .deb/.rpm cannot be swapped from inside; AppImage can.
    this._linuxManualOnly = process.platform === 'linux' && !process.env.APPIMAGE;
  }

  configure(updateSettings) {
    this.settings = { mode: 'ask', url: '', ...updateSettings };
    try {
      this.feed = feedFromUrl(this.settings.url);
    } catch (err) {
      this.feed = null;
      this._set({ state: 'error', error: err.message });
      log.warn('update server rejected', { url: this.settings.url, error: err.message });
    }
    if (this._auto && this.feed) {
      try { this._auto.setFeedURL(this.feed); } catch (err) { log.warn('setFeedURL failed', err); }
    }
    this._auto && (this._auto.autoDownload = this.settings.mode === 'auto');
    this._schedule();
  }

  _set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  /** Wire electron-updater lazily; it throws when not packaged. */
  _autoUpdater() {
    if (this._auto) return this._auto;
    if (!this._supported || this._linuxManualOnly) return null;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = {
      info: (m) => log.info(String(m)), warn: (m) => log.warn(String(m)),
      error: (m) => log.error(String(m)), debug: (m) => log.debug(String(m)),
    };
    autoUpdater.autoDownload = this.settings.mode === 'auto';
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    if (this.feed) {
      try { autoUpdater.setFeedURL(this.feed); } catch (err) { log.warn('setFeedURL failed', err); }
    }

    autoUpdater.on('checking-for-update', () => this._set({ state: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => {
      log.info('update available', { version: info.version });
      this._set({ state: this.settings.mode === 'auto' ? 'downloading' : 'available', version: info.version, notes: notesText(info.releaseNotes), progress: null });
    });
    autoUpdater.on('update-not-available', (info) => {
      this._set({ state: 'up-to-date', version: info && info.version, progress: null });
    });
    autoUpdater.on('download-progress', (p) => {
      this._set({ state: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bps: p.bytesPerSecond } });
    });
    autoUpdater.on('update-downloaded', (info) => {
      log.info('update downloaded', { version: info.version });
      this._set({ state: 'downloaded', version: info.version, notes: notesText(info.releaseNotes), progress: null, pendingInstall: true });
    });
    autoUpdater.on('error', (err) => {
      log.error('updater error', err);
      this._set({ state: 'error', error: friendlyError(err), progress: null });
    });
    this._auto = autoUpdater;
    return autoUpdater;
  }

  start() {
    if (!this._supported) { this._set({ state: 'disabled', error: 'Updates only work in the installed app, not from source.' }); return; }
    this._schedule();
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._supported || this.settings.mode === 'off') return;
    this._timer = setTimeout(() => {
      this.check({ manual: false }).catch(() => {});
      this._timer = setInterval(() => this.check({ manual: false }).catch(() => {}), CHECK_INTERVAL_MS);
      this._timer.unref?.();
    }, STARTUP_DELAY_MS);
    this._timer.unref?.();
  }

  /** Check the feed. Resolves with the status; never throws to the caller. */
  async check({ manual = true } = {}) {
    if (!this._supported) return this.status;
    if (['downloading', 'downloaded'].includes(this.status.state)) return this.status;
    this._set({ state: 'checking', error: null, lastCheck: Date.now() });

    try {
      if (this._linuxManualOnly) {
        await this._checkManual();
      } else {
        const auto = this._autoUpdater();
        const result = await auto.checkForUpdates();
        if (!result) this._set({ state: 'up-to-date' });
      }
    } catch (err) {
      log.error('check failed', err);
      this._set({ state: 'error', error: friendlyError(err) });
    }
    if (manual) log.info('manual check', { state: this.status.state, version: this.status.version });
    return this.status;
  }

  /** deb/rpm: read the Linux manifest ourselves and offer a download link. */
  async _checkManual() {
    const feed = this.feed || this._feedFromAppUpdateYml();
    const url = linuxManifestUrl(feed);
    if (!url) throw new Error('No update server configured.');
    const manifest = parseLatestYml(await fetchText(url));
    if (!manifest.version) throw new Error('Update manifest is missing a version.');

    if (compareVersions(manifest.version, app.getVersion()) <= 0) {
      this._set({ state: 'up-to-date', version: manifest.version });
      return;
    }
    this._packageKind ??= linuxPackageKind();
    this._set({
      state: 'available',
      version: manifest.version,
      notes: manifest.releaseNotes || null,
      manualDownloadUrl: linuxDownloadUrl(feed, manifest.version, this._packageKind),
      packageKind: this._packageKind,
    });
  }

  /** Read the feed electron-builder baked into the package. */
  _feedFromAppUpdateYml() {
    try {
      const fs = require('fs');
      const path = require('path');
      const text = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
      const get = (k) => { const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(text); return m ? unquote(m[1]) : null; };
      const provider = get('provider');
      if (provider === 'github') return { provider, owner: get('owner'), repo: get('repo') };
      if (provider === 'generic') return { provider, url: String(get('url') || '').replace(/\/+$/, '') };
    } catch { /* not packaged, or no publish config */ }
    return null;
  }

  async download() {
    if (this.status.manualDownloadUrl) {
      // Only ever hand the browser a web URL from the manifest, never a scheme
      // that could run something.
      if (/^https?:\/\//i.test(this.status.manualDownloadUrl)) await shell.openExternal(this.status.manualDownloadUrl);
      return this.status;
    }
    const auto = this._autoUpdater();
    if (!auto || this.status.state !== 'available') return this.status;
    this._set({ state: 'downloading', progress: { percent: 0 } });
    try {
      await auto.downloadUpdate();
    } catch (err) {
      this._set({ state: 'error', error: friendlyError(err) });
    }
    return this.status;
  }

  /**
   * Install the downloaded update and restart. Refused while a call is up —
   * the caller shows why and the update installs on the next quit instead.
   */
  install() {
    if (this.status.state !== 'downloaded' || !this._auto) return { ok: false, reason: 'Nothing downloaded yet.' };
    if (this.inCall()) return { ok: false, reason: 'A call is in progress. The update will install when you quit TwinLine.' };
    log.info('installing update', { version: this.status.version });
    setImmediate(() => this._auto.quitAndInstall(false, true));
    return { ok: true };
  }

  /**
   * Make sure nothing gets installed when the process exits. Used by the
   * headless --update-check mode, which must only ever *download*.
   */
  disableInstallOnQuit() {
    if (this._auto) this._auto.autoInstallOnAppQuit = false;
    this._set({ pendingInstall: false });
  }

  /** Put the banner away until the next check; the install-on-quit still happens. */
  dismiss() {
    if (['available', 'downloaded', 'error', 'up-to-date'].includes(this.status.state)) {
      this._set({ state: 'idle', error: null });
    }
    return this.status;
  }

  stop() {
    clearTimeout(this._timer);
    clearInterval(this._timer);
    this._timer = null;
  }
}

function notesText(notes) {
  if (!notes) return null;
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.map((n) => `${n.version}\n${n.note || ''}`).join('\n\n');
  return null;
}

function friendlyError(err) {
  const m = String(err && err.message || err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out/i.test(m)) return 'Could not reach the update server.';
  if (/404/.test(m)) return 'No update manifest found at the update server (latest.yml is missing).';
  if (/No update server|app-update\.yml|publish/i.test(m)) return 'No update server configured. Set one in Settings → General → Updates.';
  return m.length > 160 ? m.slice(0, 157) + '…' : m;
}

module.exports = { Updater, compareVersions, parseLatestYml, feedFromUrl, linuxManifestUrl, isLocalNetwork, fetchText, linuxPackageKind, linuxDownloadUrl };
