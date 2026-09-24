'use strict';
/**
 * Electron main process: window, tray, settings, and the bridge between the
 * renderer (UI + audio devices) and the SIP/RTP stack.
 */

const path = require('path');
const fs = require('fs');
const url = require('url');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, safeStorage, powerSaveBlocker, dialog, screen, powerMonitor } = require('electron');

const log = require('./log');
const { SettingsStore } = require('./config');
const { ContactStore } = require('./contacts');
const { AudioEngine } = require('./media/engine');
const { CallManager } = require('./callmanager');
const { Updater } = require('./updater');
const { ModelStore } = require('./transcribe/models');
const { TranscriptionService } = require('./transcribe/service');
const { cleanStaleAppImageEntries } = require('./linuxdesktop');

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

// Title bar: our HTML bar underneath, native minimise/maximise/close on top.
const TITLE_BAR_HEIGHT = 42;
const TITLE_BAR = process.platform === 'darwin'
  ? { titleBarStyle: 'hiddenInset' }
  : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1a1f29', symbolColor: '#e6eaf2', height: TITLE_BAR_HEIGHT } };
let tray = null;
let settings = null;
let contacts = null;
let audio = null;
let manager = null;
let updater = null;
let models = null;
let transcription = null;

/**
 * Files that must exist as real files (native addons, the worker script)
 * live in app.asar.unpacked when packaged. Map an in-asar path there.
 */
function unpacked(p) {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}
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
    // The page draws the title bar; the OS draws the caption buttons over it
    // (Window Controls Overlay). OS-drawn buttons are hit-tested by the OS,
    // so they cannot end up with dead zones the way CSS drag regions can on
    // scaled displays.
    ...TITLE_BAR,
    backgroundColor: '#12151c',
    title: 'TwinLine',
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the 20 ms audio loop running when the window is in the background.
      backgroundThrottling: false,
    },
  });
  harden(mainWindow);

  mainWindow.setMenuBarVisibility(false);
  const sendWindowState = () => send('window:state', { maximized: mainWindow.isMaximized() });
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
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

    // Optional: run real speech through the transcription worker.
    //   TwinLine.exe --smoke --smoke-wav=path\to\16k-mono.wav
    const wavArg = (process.argv.find((a) => a.startsWith('--smoke-wav=')) || '').split('=').slice(1).join('=');
    if (wavArg) {
      if (!transcription.available) {
        problems.push(`smoke-wav: model "${transcription.settings.model}" not installed in ${models.root}`);
      } else {
        const wav = readWavMono8k(wavArg);
        const t0 = Date.now();
        const segments = await transcription.testAudio(wav);
        const text = segments.map((s) => s.text).join(' ');
        console.log('smoke: transcript  =', JSON.stringify(text), `(${segments.length} segments, ${Date.now() - t0} ms)`);
        if (!segments.length) problems.push('smoke-wav: no speech recognised');
        report.transcript = text;
      }
    }

    // A popped-out panel must render just that dialog.
    openPanel('settings');
    const panel = panels.get('settings:');
    await new Promise((resolve, reject) => {
      panel.webContents.once('did-finish-load', resolve);
      setTimeout(() => reject(new Error('panel load timed out')), 15000);
    });
    // The panel page opens its dialog only after it has fetched the settings
    // over IPC; on a slow shared CI runner that can take seconds, so poll for
    // it rather than guess a delay (a fixed 800 ms made CI fail one run in four).
    const probePanel = () => panel.webContents.executeJavaScript(`(() => ({
      panelMode: document.body.classList.contains('panel-mode'),
      settingsShown: !document.getElementById('settingsOverlay').classList.contains('hidden'),
      dialerHidden: getComputedStyle(document.querySelector('.dialer')).display === 'none',
      title: document.querySelector('.titlebar .name').textContent,
      nativeControls: document.body.classList.contains('wco'),
    }))()`);
    const panelDeadline = Date.now() + 15000;
    do {
      await new Promise((r) => setTimeout(r, 250));
      report.panel = await probePanel();
    } while (!report.panel.settingsShown && Date.now() < panelDeadline);
    // Nothing may sit on top of the dialog's close button or the dialler.
    report.hits = await mainWindow.webContents.executeJavaScript(`(() => {
      const hit = (id) => { const el = document.getElementById(id); if (!el || !el.offsetParent && el.tagName !== 'BODY') return 'hidden';
        const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top === el || (top && el.contains(top)) ? 'ok' : (top ? top.id || top.className || top.tagName : 'none'); };
      return { dialInput: hit('dialInput'), btnDial: hit('btnDial'), btnSettings: hit('btnSettings'), keypad5: (() => {
        const el = document.querySelector('#keypad button[data-digit="5"]'); const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el.contains(top) ? 'ok' : (top && (top.id || top.className)); })() };
    })()`);
    for (const [name, result] of Object.entries(report.hits)) {
      if (result !== 'ok') problems.push(`${name} is covered by ${result}`);
    }
    // At the smallest allowed width the title-bar buttons must still sit
    // inside the bar — anything pushed past its right edge is under the OS
    // caption buttons on Windows and cannot be clicked (Mike's report).
    const [w0, h0] = mainWindow.getSize();
    mainWindow.setSize(380, 560, false);
    await new Promise((r) => setTimeout(r, 400));
    report.narrow = await mainWindow.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.titlebar').getBoundingClientRect();
      const btn = document.getElementById('btnSettings').getBoundingClientRect();
      return { width: window.innerWidth, barRight: Math.round(bar.right), settingsRight: Math.round(btn.right), visible: btn.width > 0 };
    })()`);
    mainWindow.setSize(w0, h0, false);
    if (!report.narrow.visible || report.narrow.settingsRight > report.narrow.barRight) {
      problems.push(`settings button does not fit the title bar at minimum width: ${JSON.stringify(report.narrow)}`);
    }

    // The incoming-call popup must open over the phone window — even when the
    // phone is docked at a screen edge and a far-away position is remembered.
    mainWindow.showInactive();
    await new Promise((r) => setTimeout(r, 300));
    const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
    mainWindow.setPosition(workArea.x + workArea.width - w0, workArea.y + 40, false);
    settings.data.behaviour.popupPosition = { x: workArea.x + 4, y: workArea.y + 4 };
    createPopup(44 + POPUP_CALL_HEIGHT);
    await new Promise((r) => setTimeout(r, 400));
    const [px, py] = popupWindow.getPosition();
    const [pw, ph] = popupWindow.getSize();
    const mb = mainWindow.getBounds();
    const centre = { x: px + pw / 2, y: py + ph / 2 };
    report.popup = {
      main: mb, popup: { x: px, y: py, w: pw, h: ph },
      overMain: centre.x >= mb.x && centre.x <= mb.x + mb.width && centre.y >= mb.y && centre.y <= mb.y + mb.height,
      onScreen: px >= workArea.x && py >= workArea.y && px + pw <= workArea.x + workArea.width && py + ph <= workArea.y + workArea.height,
    };
    popupWindow.close();
    popupWindow = null;
    settings.data.behaviour.popupPosition = null;
    if (!report.popup.overMain || !report.popup.onScreen) problems.push(`popup did not open over the main window: ${JSON.stringify(report.popup)}`);
    panel.close();
    if (!report.panel.panelMode || !report.panel.settingsShown || !report.panel.dialerHidden) {
      problems.push(`popped-out settings panel did not render as a panel: ${JSON.stringify(report.panel)}`);
    }

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

/** Keep a popup rectangle fully inside the work area of the display it is on. */
function clampToDisplay(pos, height) {
  const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(pos.x + POPUP_WIDTH / 2), y: Math.round(pos.y + 20) });
  return {
    x: Math.round(Math.min(Math.max(pos.x, workArea.x), workArea.x + workArea.width - POPUP_WIDTH)),
    y: Math.round(Math.min(Math.max(pos.y, workArea.y), workArea.y + workArea.height - height)),
  };
}

/** Centred over the main window, when there is one on screen to centre over. */
function positionOverMainWindow(height) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return null;
  const b = mainWindow.getBounds();
  return clampToDisplay({ x: b.x + (b.width - POPUP_WIDTH) / 2, y: b.y + (b.height - height) / 2 }, height);
}

/**
 * Where the popup appears (Mike, 1.4.6): right over the phone window,
 * whenever the phone is on screen — never at a screen edge, whatever was
 * remembered from last time. The remembered position only matters when the
 * phone is hidden in the tray or minimised; then it is honoured (pulled fully
 * onto the nearest display), else the bottom-right corner is used. Dragging
 * still works while it rings.
 */
function popupPosition(height) {
  const over = positionOverMainWindow(height);
  const saved = settings.data.behaviour.popupPosition;
  let pos, reason;
  if (over) { pos = over; reason = 'over main window'; }
  else if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) { pos = clampToDisplay(saved, height); reason = 'remembered (main window not on screen)'; }
  else {
    const { workArea } = screen.getPrimaryDisplay();
    pos = clampToDisplay({ x: workArea.x + workArea.width - POPUP_WIDTH - 24, y: workArea.y + workArea.height - height - 24 }, height);
    reason = 'default corner';
  }
  // Logged so a "it opened at the edge" report can be read straight off the log.
  const main = mainWindow && !mainWindow.isDestroyed()
    ? { bounds: mainWindow.getBounds(), visible: mainWindow.isVisible(), minimized: mainWindow.isMinimized() } : null;
  log.info('main', 'popup placed', { reason, pos, main, saved });
  return pos;
}

function createPopup(height) {
  const pos = popupPosition(height);

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
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  harden(popupWindow);
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

/** Calls whose popup the user dismissed with ✕; forgotten once they stop ringing. */
const popupDismissed = new Set();

function incomingCalls() {
  const ringing = manager ? manager.snapshot().calls.filter((c) => c.state === 'incoming') : [];
  for (const id of [...popupDismissed]) if (!ringing.some((c) => c.id === id)) popupDismissed.delete(id);
  return ringing.filter((c) => !popupDismissed.has(c.id));
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
    if (h !== height) {
      popupWindow.setSize(w, height, false);
      // Growing for a second caller must not push the bottom off the screen.
      const [x, y] = popupWindow.getPosition();
      const pos = clampToDisplay({ x, y }, height);
      if (pos.x !== x || pos.y !== y) popupWindow.setPosition(pos.x, pos.y, false);
    }
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
    const pos = popupPosition(h);
    popupWindow.setPosition(pos.x, pos.y, false);
  }
  return { ok: true };
}

/** 16-bit PCM WAV → mono Int16 at 8 kHz (nearest-sample), for the self-test. */
function readWavMono8k(file) {
  const buf = fs.readFileSync(file);
  let offset = 12, channels = 1, rate = 16000, data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') { channels = buf.readUInt16LE(offset + 10); rate = buf.readUInt32LE(offset + 12); }
    if (id === 'data') data = buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`${file}: not a PCM WAV`);
  const frames = Math.floor(data.length / 2 / channels);
  const out = new Int16Array(Math.floor(frames * 8000 / rate));
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(Math.floor(i * rate / 8000) * 2 * channels);
  return out;
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

/**
 * Broadcast to every window: the main window and any popped-out panels all
 * render from the same main-process state, so they all get the same events.
 * (The incoming-call popup ignores channels it does not know.)
 */
function send(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/** The 50 Hz speaker stream only ever plays in the main window. */
function sendAudio(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---- popped-out panels -----------------------------------------------------

/** @type {Map<string, BrowserWindow>} panel key -> window */
const panels = new Map();

const PANEL_SIZES = {
  settings: { width: 470, height: 740 },
  contacts: { width: 460, height: 640 },
  history: { width: 500, height: 620 },
  transcript: { width: 440, height: 540 },
  transcriptView: { width: 540, height: 660 },
  transfer: { width: 400, height: 340 },
};

/**
 * Open a dialog as its own window. The page is the same index.html in
 * "panel mode" (?panel=...), which shows only that dialog with a draggable
 * title bar; closing the dialog closes the window.
 */
function openPanel(name, params = {}) {
  if (!PANEL_SIZES[name]) throw new Error(`unknown panel "${name}"`);
  const key = `${name}:${params.call || params.file || ''}`;
  const existing = panels.get(key);
  if (existing && !existing.isDestroyed()) { existing.focus(); return { focused: true }; }

  const size = PANEL_SIZES[name];
  const anchor = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  const win = new BrowserWindow({
    ...size,
    minWidth: 340,
    minHeight: 260,
    x: anchor ? anchor.x + anchor.width + 12 : undefined,
    y: anchor ? anchor.y : undefined,
    ...TITLE_BAR,
    show: false,
    backgroundColor: '#1a1f29',
    title: `TwinLine — ${name}`,
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  harden(win);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: { panel: name, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) },
  });
  win.once('ready-to-show', () => { if (!isSmoke) win.show(); });
  win.on('closed', () => { if (panels.get(key) === win) panels.delete(key); });
  panels.set(key, win);
  return { opened: true };
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

/**
 * A sip:/tel: link from a browser or another program fills in the dialler and
 * brings the window up; it never dials by itself. Otherwise any web page could
 * make the phone call a premium number.
 */
function handleDialLink(link) {
  const target = String(link).replace(/^tel:/i, '').replace(/[\r\n\s]/g, '').slice(0, 256);
  if (!target) return;
  focusWindow();
  send('dial:prefill', { target });
}

/** Renderer hardening shared by every window. */
function harden(win) {
  // Our pages are local files; nothing should ever navigate them elsewhere.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function bootstrap() {
  log.init(path.join(app.getPath('userData'), 'logs'));
  log.info('main', `TwinLine ${app.getVersion()} starting`, { electron: process.versions.electron, exe: process.execPath });
  process.on('uncaughtException', (err) => log.error('main', 'uncaught exception', err));
  process.on('unhandledRejection', (err) => log.error('main', 'unhandled rejection', err));

  // The .deb/.rpm start-up sweeps launchers left behind by a deleted AppImage
  // (see linuxdesktop.js). Never from the AppImage itself or a dev checkout.
  if (process.platform === 'linux' && app.isPackaged && !process.env.APPIMAGE) {
    try {
      const swept = cleanStaleAppImageEntries(app.getPath('home'));
      if (swept.removed.length) log.info('main', 'removed stale AppImage launchers', swept);
    } catch (err) { log.warn('main', 'stale launcher sweep failed', err); }
  }

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
    sendAudio('audio:speaker', frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
  });
  audio.on('error', (err) => send('error', { message: err.message }));

  models = new ModelStore(path.join(app.getPath('userData'), 'models'));
  models.on('progress', (p) => send('models:progress', p));
  models.on('installed', () => send('models:status', models.status()));
  models.on('error', (e) => send('error', { message: `Model download failed: ${e.message}` }));

  const platformDir = path.join(app.getAppPath(), 'node_modules',
    `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`);
  transcription = new TranscriptionService({
    audio,
    models,
    transcriptsDir: path.join(app.getPath('userData'), 'transcripts'),
    workerPath: unpacked(path.join(__dirname, 'transcribe', 'worker.js')),
    platformDir: unpacked(platformDir),
  });
  transcription.configure(settings.data.transcription);
  if (!isSmoke) setTimeout(() => transcription.ensureSpeakerModel(), 20000);
  transcription.on('line', (p) => send('transcript:line', p));
  transcription.on('speaking', (p) => send('transcript:speaking', p));
  transcription.on('started', (p) => send('transcript:started', p));
  transcription.on('finished', (p) => send('transcript:finished', p));
  transcription.on('status', (p) => send('transcript:status', p));
  transcription.on('voices', (p) => send('transcript:voices', p));
  transcription.on('warning', (message) => send('warning', { message }));

  manager = new CallManager({
    audio,
    contacts,
    transcription,
    maxCalls: settings.data.behaviour.maxCalls,
    historyFile: path.join(app.getPath('userData'), 'history.json'),
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

// Only our own pages may drive the main process. Every window loads a file
// from the renderer directory and harden() keeps it there, so a sender whose
// frame is anywhere else is not something we created — refuse it rather than
// trust that the renderer can never be led astray.
const RENDERER_ORIGIN = url.pathToFileURL(path.join(__dirname, '..', 'renderer') + path.sep).href;
function trustedSender(event) {
  try {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return false;
    if (!String(frame.url).startsWith(RENDERER_ORIGIN)) return false;
    return !!BrowserWindow.fromWebContents(event.sender);
  } catch {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) {
      log.warn('main', 'refused IPC from an unexpected sender', { channel, url: event.senderFrame?.url });
      return { ok: false, error: 'not allowed' };
    }
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

/** ipcMain.on with the same sender check; untrusted messages are dropped. */
function on(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (!trustedSender(event)) return;
    fn(event, ...args);
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    // `process.platform` says "win32" on every Windows, 64-bit included; give
    // the UI something a person would say.
    platformLabel: `${{ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[process.platform] || process.platform} ${{ x64: '64-bit', arm64: 'ARM 64-bit', ia32: '32-bit' }[process.arch] || process.arch}`,
    electron: process.versions.electron,
    windowControls: 'native',             // the OS draws min/max/close; the page must not
    titleBarHeight: TITLE_BAR_HEIGHT,
    encryptionAvailable: settings.encryptionAvailable,
    encryptionBackend: settings.encryptionBackend,
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
    transcription.configure(saved.transcription);
    await manager.applyAccounts(saved.accounts);
    updatePopup();
    // Every window caches the redacted settings; tell them all.
    send('settings', settings.redacted());
    return settings.redacted();
  });

  handle('transcribe:start', ({ callId }) => manager.startTranscription(callId));
  handle('transcribe:stop', ({ callId }) => manager.stopTranscription(callId));
  handle('transcribe:live', ({ callId }) => transcription.liveTranscript(callId));
  handle('transcribe:status', () => transcription.status());
  handle('transcripts:list', () => transcription.list());
  handle('transcripts:read', ({ file }) => transcription.read(file));
  handle('transcripts:remove', ({ file }) => transcription.remove(file));
  handle('transcripts:openFolder', async () => { await shell.openPath(transcription.dir); return { dir: transcription.dir }; });
  handle('models:status', () => models.status());
  handle('models:download', ({ id }) => models.download(id));
  handle('models:cancel', ({ id }) => models.cancel(id));
  handle('models:remove', ({ id }) => models.remove(id));

  handle('update:status', () => updater.status);
  handle('update:check', () => updater.check({ manual: true }));
  handle('update:download', () => updater.download());
  handle('update:install', () => updater.install());
  handle('update:dismiss', () => updater.dismiss());
  handle('popup:reset', () => resetPopupPosition());
  handle('log:open', async () => { await shell.openPath(log.dir); return { dir: log.dir }; });
  handle('network:refresh', ({ reason }) => manager.refreshNetwork(reason || 'requested'));

  const contactsChanged = (result) => { send('contacts:changed', {}); return result; };
  handle('contacts:list', () => contacts.list());
  handle('contacts:add', (contact) => contactsChanged(contacts.add(contact)));
  handle('contacts:update', ({ id, contact }) => contactsChanged(contacts.update(id, contact)));
  handle('contacts:remove', ({ id }) => contactsChanged(contacts.remove(id)));
  handle('contacts:import', async () => contactsChanged(await importContacts()));
  handle('contacts:export', ({ format }) => exportContacts(format));

  handle('state:get', () => manager.snapshot());
  handle('history:get', () => manager.history.slice(0, 100));

  handle('call:dial', ({ target, accountId }) => manager.dial(target, { accountId }));
  handle('call:answer', ({ callId }) => manager.answer(callId));
  handle('call:reject', ({ callId, status }) => manager.reject(callId, status));
  handle('call:deflect', ({ callId, target }) => manager.deflect(callId, target));
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
  on('audio:mic', (_event, buffer) => {
    if (!audio) return;
    audio.pushMicFrame(new Int16Array(buffer));
  });

  // Window controls act on whichever window sent them: the main window or a
  // popped-out panel.
  const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);
  on('window:minimise', (event) => senderWindow(event)?.minimize());
  on('window:maximise', (event) => {
    const win = senderWindow(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  on('window:close', (event) => senderWindow(event)?.close());
  handle('window:openPanel', ({ name, params }) => openPanel(name, params || {}));

  // The incoming-call popup drags itself: it has no OS frame and no CSS drag
  // region (those develop dead zones on scaled displays), so the page reports
  // where the grip was dragged to and we move the window.
  on('popup:move', (event, { x, y }) => {
    const win = senderWindow(event);
    if (win && win === popupWindow && Number.isFinite(x) && Number.isFinite(y)) win.setPosition(Math.round(x), Math.round(y), false);
  });
  on('popup:dismiss', () => {
    // Hide the popup for the calls ringing now; the main window keeps ringing.
    for (const c of incomingCalls()) popupDismissed.add(c.id);
    updatePopup();
  });
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
