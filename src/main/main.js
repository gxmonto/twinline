'use strict';
/**
 * Electron main process: window, tray, settings, and the bridge between the
 * renderer (UI + audio devices) and the SIP/RTP stack.
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, safeStorage, powerSaveBlocker, dialog, screen, powerMonitor } = require('electron');

const log = require('./log');
const { SettingsStore } = require('./config');
const { ContactStore } = require('./contacts');
const { AudioEngine } = require('./media/engine');
const { CallManager } = require('./callmanager');
const { Updater } = require('./updater');

const isDev = process.argv.includes('--dev');
// Headless self-check: boot everything, verify the UI came up, print a
// report and exit. Used by `npm run smoke` and in CI.
// Headless update check against a given feed: configures the updater, checks,
// downloads if something newer is there, writes a report and exits WITHOUT
// installing. Lets a release be verified on real packaged binaries:
//   TwinLine.exe --update-check=http://127.0.0.1:8123/
const updateCheckUrl = (process.argv.find((a) => a.startsWith('--update-check=')) || '').split('=').slice(1).join('=');
const isSmoke = process.argv.includes('--smoke') || !!updateCheckUrl;

// Icons must come from inside the packaged app (src/assets); build/ never
// ships. Windows gets a multi-resolution .ico for a crisp tray at any DPI.
const ASSETS = path.join(__dirname, '..', 'assets');
const WINDOW_ICON = path.join(ASSETS, 'icon.png');
const TRAY_ICON = process.platform === 'win32'
  ? path.join(ASSETS, 'tray.ico')
  : path.join(ASSETS, 'icon.png');

let mainWindow = null;
let popupWindow = null;
let trayIconLoaded = false;
let tray = null;
let settings = null;
let contacts = null;
let audio = null;
let manager = null;
let updater = null;
let powerBlockerId = null;
let quitting = false;

// The self-check runs against a throwaway profile so it neither fights the
// running app for the single-instance lock nor touches real settings.
if (isSmoke) app.setPath('userData', path.join(app.getPath('temp'), 'twinline-smoke'));

// A second launch (or a sip:/tel: link) focuses the running instance.
if (!app.requestSingleInstanceLock()) {
  if (isSmoke) console.error('SMOKE FAILED: another smoke instance holds the lock');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    focusWindow();
    const link = argv.find((a) => /^(sip|sips|tel):/i.test(a));
    if (link) handleDialLink(link);
  });
}

app.setAppUserModelId('com.twinline.softphone');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 720,
    minWidth: 380,
    minHeight: 560,
    show: false,
    backgroundColor: '#12151c',
    title: 'TwinLine',
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep the 20 ms audio loop running when the window is in the background.
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (isSmoke) return;
    if (!settings.data.behaviour.startMinimised) mainWindow.show();
  });

  if (isSmoke) runSmokeTest();

  mainWindow.on('close', (event) => {
    if (!quitting && settings.data.behaviour.minimiseToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // External links open in the user's browser, never in the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

/**
 * Boot the real UI against the real main process and assert it came up:
 * preload bridge present, state fetched, chrome rendered, no page errors.
 */
async function runSmokeTest() {
  const problems = [];
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) problems.push(`console: ${message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    problems.push(`renderer gone: ${details.reason}`);
  });

  try {
    await new Promise((resolve, reject) => {
      mainWindow.webContents.once('did-finish-load', resolve);
      mainWindow.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`${code} ${desc}`)));
      setTimeout(() => reject(new Error('page load timed out')), 20000);
    });
    // Give the module script and its first IPC round-trip time to settle.
    await new Promise((r) => setTimeout(r, 1500));

    const report = await mainWindow.webContents.executeJavaScript(`(() => ({
      bridge: typeof window.twinline === 'object',
      dialer: !!document.getElementById('dialInput'),
      keypadKeys: document.querySelectorAll('#keypad button').length,
      lineChips: document.querySelectorAll('.line-chip').length,
      settingsPanels: document.querySelectorAll('.tab-panel').length,
      bodyText: document.body.innerText.slice(0, 120),
      crashed: document.body.innerHTML.startsWith('<pre'),
    }))()`);

    if (!trayIconLoaded) problems.push(`tray icon failed to load from ${TRAY_ICON}`);
    if (!report.bridge) problems.push('preload bridge missing');
    if (!report.dialer) problems.push('dialer not rendered');
    if (report.keypadKeys !== 12) problems.push(`expected 12 keypad keys, got ${report.keypadKeys}`);
    if (report.crashed) problems.push(`renderer threw: ${report.bodyText}`);

    const snapshot = manager.snapshot();
    console.log('smoke: report      =', JSON.stringify(report));
    console.log('smoke: accounts    =', snapshot.accounts.length);
    console.log('smoke: calls       =', snapshot.calls.length);
    console.log('smoke: audio ticks =', audio.stats.ticks);
  } catch (err) {
    problems.push(err.message);
  }

  // Also write the verdict to a file: a packaged GUI exe (and the portable
  // launcher stub in particular) does not reliably forward stdout.
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'smoke-result.json'), JSON.stringify({
      ok: problems.length === 0,
      problems,
      exe: process.execPath,
      at: new Date().toISOString(),
    }, null, 2));
  } catch { /* best effort */ }

  if (problems.length) {
    console.error('SMOKE FAILED:\n  ' + problems.join('\n  '));
    app.exit(1);
  } else {
    console.log('SMOKE OK');
    app.exit(0);
  }
}

// ---- incoming-call popup ---------------------------------------------------

const POPUP_WIDTH = 380;
const POPUP_CALL_HEIGHT = 118;

/** Is a saved top-left point still on some connected display? */
function positionOnScreen(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return false;
  return screen.getAllDisplays().some(({ workArea }) =>
    pos.x >= workArea.x - POPUP_WIDTH + 60 &&
    pos.x <= workArea.x + workArea.width - 60 &&
    pos.y >= workArea.y - 20 &&
    pos.y <= workArea.y + workArea.height - 60);
}

function defaultPopupPosition(height) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - POPUP_WIDTH - 24),
    y: Math.round(workArea.y + workArea.height - height - 24),
  };
}

function createPopup(height) {
  const saved = settings.data.behaviour.popupPosition;
  const pos = positionOnScreen(saved) ? saved : defaultPopupPosition(height);

  popupWindow = new BrowserWindow({
    width: POPUP_WIDTH,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#1a1f29',
    title: 'Incoming call',
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  popupWindow.setAlwaysOnTop(true, 'screen-saver');
  popupWindow.setVisibleOnAllWorkspaces?.(true);
  popupWindow.loadFile(path.join(__dirname, '..', 'renderer', 'popup.html'));

  // Remember where the user drags it. Debounced: 'moved' fires continuously.
  let saveTimer = null;
  popupWindow.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!popupWindow || popupWindow.isDestroyed()) return;
      const [x, y] = popupWindow.getPosition();
      settings.data.behaviour.popupPosition = { x, y };
      settings.save();
    }, 400);
  });
  popupWindow.on('closed', () => { popupWindow = null; });
  popupWindow.webContents.on('did-finish-load', () => pushPopupCalls());
}

function incomingCalls() {
  return manager ? manager.snapshot().calls.filter((c) => c.state === 'incoming') : [];
}

function pushPopupCalls() {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  popupWindow.webContents.send('popup:calls', {
    calls: incomingCalls(),
    accounts: manager.snapshot().accounts,
  });
}

/** Show, resize or hide the popup to match the current set of ringing calls. */
function updatePopup() {
  if (isSmoke) return;
  const ringing = incomingCalls();
  if (!ringing.length || !settings.data.behaviour.incomingPopup) {
    if (popupWindow && !popupWindow.isDestroyed()) popupWindow.close();
    popupWindow = null;
    return;
  }

  const height = 44 + POPUP_CALL_HEIGHT * Math.min(ringing.length, 3);
  if (!popupWindow || popupWindow.isDestroyed()) {
    createPopup(height);
  } else {
    const [w, h] = popupWindow.getSize();
    if (h !== height) popupWindow.setSize(w, height, false);
    pushPopupCalls();
  }
  // showInactive keeps the user's keyboard focus where it was.
  if (!popupWindow.isVisible()) popupWindow.showInactive();
}

/** Forget the saved position and put the popup back in the default corner. */
function resetPopupPosition() {
  settings.data.behaviour.popupPosition = null;
  settings.save();
  if (popupWindow && !popupWindow.isDestroyed()) {
    const [, h] = popupWindow.getSize();
    const pos = defaultPopupPosition(h);
    popupWindow.setPosition(pos.x, pos.y, false);
  }
  return { ok: true };
}

async function runUpdateCheck(url) {
  const report = { url, current: app.getVersion(), exe: process.execPath, steps: [] };
  const finish = (ok) => {
    // This mode verifies a release; it must never install one. electron-updater
    // otherwise runs the downloaded installer from its quit hook.
    updater.disableInstallOnQuit();
    fs.writeFileSync(path.join(app.getPath('userData'), 'update-check-result.json'), JSON.stringify(report, null, 2));
    console.log(ok ? 'UPDATE CHECK OK' : 'UPDATE CHECK FAILED', JSON.stringify(report));
    app.exit(ok ? 0 : 1);
  };
  try {
    updater.configure({ mode: 'ask', url });
    let status = await updater.check({ manual: true });
    report.steps.push({ check: status.state, version: status.version, error: status.error });
    if (status.state === 'available' && !status.manualDownloadUrl) {
      status = await updater.download();
      // download() resolves when electron-updater finishes; give the final
      // 'update-downloaded' event a moment to land.
      await new Promise((r) => setTimeout(r, 500));
      status = updater.status;
      report.steps.push({ download: status.state, version: status.version, progress: status.progress, error: status.error });
    }
    report.final = updater.status.state;
    finish(['downloaded', 'up-to-date', 'available'].includes(report.final));
  } catch (err) {
    report.error = err.message;
    finish(false);
  }
}

function focusWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createTray() {
  let icon = nativeImage.createFromPath(TRAY_ICON);
  if (icon.isEmpty()) icon = nativeImage.createFromPath(WINDOW_ICON);
  trayIconLoaded = !icon.isEmpty();
  if (!trayIconLoaded) console.error(`tray icon missing: ${TRAY_ICON}`);
  // An .ico carries its own sizes; a PNG is scaled down for the tray cell.
  if (trayIconLoaded && process.platform !== 'win32') icon = icon.resize({ width: 22, height: 22 });
  tray = new Tray(icon);
  tray.setToolTip('TwinLine');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show TwinLine', click: focusWindow },
    { type: 'separator' },
    { label: 'Hang up all calls', click: () => manager && manager.hangupAll().catch(() => {}) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', focusWindow);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Keep the machine awake while a call is up. */
function updatePowerBlocker() {
  const inCall = manager && manager.activeCalls().length > 0;
  if (inCall && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!inCall && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

function handleDialLink(link) {
  if (!manager) return;
  const target = link.replace(/^tel:/i, '');
  manager.dial(target).catch((err) => send('error', { message: err.message }));
}

async function bootstrap() {
  log.init(path.join(app.getPath('userData'), 'logs'));
  log.info('main', `TwinLine ${app.getVersion()} starting`, { electron: process.versions.electron, exe: process.execPath });
  process.on('uncaughtException', (err) => log.error('main', 'uncaught exception', err));
  process.on('unhandledRejection', (err) => log.error('main', 'unhandled rejection', err));

  settings = new SettingsStore(app.getPath('userData'), safeStorage);
  settings.load();
  log.setTraceSip(settings.data.behaviour.sipTrace);
  contacts = new ContactStore(app.getPath('userData'));
  contacts.load();

  audio = new AudioEngine({
    portRange: settings.data.behaviour.mediaPortRange,
  });
  audio.on('speaker', (frame) => {
    // Transfer the PCM as a plain ArrayBuffer; structured clone keeps this cheap.
    send('audio:speaker', frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
  });
  audio.on('error', (err) => send('error', { message: err.message }));

  manager = new CallManager({
    audio,
    contacts,
    maxCalls: settings.data.behaviour.maxCalls,
  });

  manager.on('calls', (snapshot) => { send('state', snapshot); updatePowerBlocker(); updatePopup(); });
  manager.on('accounts', (accounts) => send('accounts', accounts));
  manager.on('incoming', (call) => { send('incoming', call); focusIfConfigured(); });
  manager.on('callEnded', (info) => send('callEnded', info));
  manager.on('levels', (levels) => send('levels', levels));
  manager.on('dtmf', (info) => send('dtmf', info));
  manager.on('warning', (info) => send('warning', info));
  manager.on('history', (history) => send('history', history));
  manager.on('accountError', (info) => send('accountError', info));
  manager.on('message', (info) => send('message', info));

  await manager.applyAccounts(settings.data.accounts);

  // Coming back from sleep or a locked screen is the classic moment the
  // network has changed underneath us: re-register straight away rather than
  // waiting for the next refresh or a failed call to reveal it.
  powerMonitor.on('resume', () => manager && manager.refreshNetwork('resume from sleep'));
  powerMonitor.on('unlock-screen', () => manager && manager.refreshNetwork('screen unlocked'));

  updater = new Updater({ inCall: () => !!(manager && manager.activeCalls().length) });
  updater.on('status', (status) => send('update', status));
  updater.configure(settings.data.updates);
  if (!isSmoke) updater.start();
}

function focusIfConfigured() {
  if (!mainWindow || isSmoke) return;
  // With the popup on, the main window stays where it is; the popup is the
  // thing that gets the user's attention.
  if (settings.data.behaviour.incomingPopup) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  setTimeout(() => mainWindow && mainWindow.setAlwaysOnTop(false), 1500);
}

// ---- contacts import / export ----------------------------------------------

const CONTACT_FILTERS = [
  { name: 'Contact files', extensions: ['csv', 'json', 'vcf'] },
  { name: 'CSV', extensions: ['csv'] },
  { name: 'JSON', extensions: ['json'] },
  { name: 'vCard', extensions: ['vcf'] },
];

async function importContacts() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import contacts',
    properties: ['openFile', 'multiSelections'],
    filters: CONTACT_FILTERS,
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  let added = 0, updated = 0, skipped = 0;
  for (const file of result.filePaths) {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = ContactStore.parse(text, file);
    const outcome = contacts.importMany(parsed);
    added += outcome.added; updated += outcome.updated; skipped += outcome.skipped;
  }
  return { added, updated, skipped, total: contacts.contacts.length };
}

async function exportContacts(format) {
  const ext = ['csv', 'json', 'vcf'].includes(format) ? format : 'csv';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export contacts',
    defaultPath: path.join(app.getPath('documents'), `twinline-contacts.${ext}`),
    filters: CONTACT_FILTERS.filter((f) => f.extensions.includes(ext)),
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const chosen = path.extname(result.filePath).slice(1).toLowerCase() || ext;
  const text = chosen === 'json' ? contacts.toJSON()
    : chosen === 'vcf' ? contacts.toVCard()
    : contacts.toCSV();
  fs.writeFileSync(result.filePath, text, 'utf8');
  return { file: result.filePath, count: contacts.contacts.length };
}

// ---- IPC -------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    encryptionAvailable: settings.encryptionAvailable,
  }));

  handle('settings:get', () => settings.redacted());
  handle('settings:save', async (update) => {
    // The popup position is owned by the popup itself, never by the form.
    const position = settings.data.behaviour.popupPosition;
    const saved = settings.applyUpdate(update);
    saved.behaviour.popupPosition = position;
    settings.save();
    audio.setMicGain(saved.audio.micGain);
    audio.setSpeakerGain(saved.audio.speakerGain);
    manager.maxCalls = saved.behaviour.maxCalls;
    log.setTraceSip(saved.behaviour.sipTrace);
    updater.configure(saved.updates);
    await manager.applyAccounts(saved.accounts);
    updatePopup();
    return settings.redacted();
  });

  handle('update:status', () => updater.status);
  handle('update:check', () => updater.check({ manual: true }));
  handle('update:download', () => updater.download());
  handle('update:install', () => updater.install());
  handle('update:dismiss', () => updater.dismiss());
  handle('popup:reset', () => resetPopupPosition());
  handle('log:open', async () => { await shell.openPath(log.dir); return { dir: log.dir }; });
  handle('network:refresh', ({ reason }) => manager.refreshNetwork(reason || 'requested'));

  handle('contacts:list', () => contacts.list());
  handle('contacts:add', (contact) => contacts.add(contact));
  handle('contacts:update', ({ id, contact }) => contacts.update(id, contact));
  handle('contacts:remove', ({ id }) => contacts.remove(id));
  handle('contacts:import', () => importContacts());
  handle('contacts:export', ({ format }) => exportContacts(format));

  handle('state:get', () => manager.snapshot());
  handle('history:get', () => manager.history.slice(0, 100));

  handle('call:dial', ({ target, accountId }) => manager.dial(target, { accountId }));
  handle('call:answer', ({ callId }) => manager.answer(callId));
  handle('call:reject', ({ callId, status }) => manager.reject(callId, status));
  handle('call:hangup', ({ callId }) => manager.hangup(callId));
  handle('call:hangupAll', () => manager.hangupAll());
  handle('call:hold', ({ callId }) => manager.hold(callId));
  handle('call:unhold', ({ callId }) => manager.unhold(callId));
  handle('call:setActive', ({ callId }) => manager.setActive(callId));
  handle('call:dtmf', ({ callId, digit }) => manager.dtmf(callId, digit));
  handle('call:transferBlind', ({ callId, target }) => manager.transferBlind(callId, target));
  handle('call:transferAttended', ({ callId, otherCallId }) => manager.transferAttended(callId, otherCallId));

  handle('conf:start', ({ callIds }) => manager.conference(callIds));
  handle('conf:add', ({ callId }) => manager.addToConference(callId));
  handle('conf:holdParty', ({ callId }) => manager.holdConferenceParty(callId));
  handle('conf:resumeParty', ({ callId }) => manager.resumeConferenceParty(callId));
  handle('conf:remove', ({ callId }) => manager.removeFromConference(callId));
  handle('conf:hangupParty', ({ callId }) => manager.hangupConferenceParty(callId));
  handle('conf:split', ({ keepActiveId }) => manager.splitConference(keepActiveId));
  handle('conf:end', () => manager.endConference());

  handle('audio:mute', ({ muted }) => manager.setMuted(muted));
  handle('audio:speakerGain', ({ gain }) => manager.setSpeakerGain(gain));
  handle('audio:micGain', ({ gain }) => manager.setMicGain(gain));

  // High-rate path: one 20 ms microphone frame, as Int16 PCM.
  ipcMain.on('audio:mic', (_event, buffer) => {
    if (!audio) return;
    audio.pushMicFrame(new Int16Array(buffer));
  });

  ipcMain.on('window:minimise', () => mainWindow && mainWindow.minimize());
  ipcMain.on('window:close', () => mainWindow && mainWindow.close());
}

// ---- lifecycle -------------------------------------------------------------

app.whenReady().then(async () => {
  registerIpc();
  await bootstrap();
  if (updateCheckUrl) { runUpdateCheck(updateCheckUrl); return; }
  createWindow();
  createTray();

  app.setAsDefaultProtocolClient('sip');
  app.setAsDefaultProtocolClient('tel');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusWindow();
  });
});

app.on('open-url', (event, url) => {       // macOS / some Linux desktops
  event.preventDefault();
  handleDialLink(url);
});

app.on('window-all-closed', () => {
  // The tray keeps the app alive; quitting is explicit.
  if (process.platform !== 'darwin' && !settings?.data.behaviour.minimiseToTray) {
    quitting = true;
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  if (quitting && manager) {
    // Give BYE/un-REGISTER a moment to reach the server.
    event.preventDefault();
    const done = manager.shutdown().catch(() => {});
    manager = null;
    await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
    app.exit(0);
  }
  quitting = true;
});
