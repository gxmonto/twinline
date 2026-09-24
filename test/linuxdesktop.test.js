'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanStaleAppImageEntries, execTarget } = require('../src/main/linuxdesktop');

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-home-'));
  fs.mkdirSync(path.join(h, '.local', 'share', 'applications'), { recursive: true });
  fs.mkdirSync(path.join(h, '.config'), { recursive: true });
  return h;
}
const apps = (h) => path.join(h, '.local', 'share', 'applications');

test('Exec targets are extracted from the ways AppImage helpers write them', () => {
  assert.strictEqual(execTarget('Exec=/home/m/Apps/TwinLine-1.4.2.AppImage %U'), '/home/m/Apps/TwinLine-1.4.2.AppImage');
  assert.strictEqual(execTarget('Exec="/home/m/My Apps/TwinLine.AppImage" --no-sandbox %U'), '/home/m/My Apps/TwinLine.AppImage');
  assert.strictEqual(execTarget('Exec=env APPIMAGELAUNCHER_DISABLE=1 /tmp/TwinLine.AppImage'), '/tmp/TwinLine.AppImage');
  assert.strictEqual(execTarget('Name=x'), null);
});

test('a launcher for a deleted TwinLine AppImage is removed and link handlers repointed', () => {
  const h = home();
  const stale = 'appimagekit_1a2b3c-TwinLine.desktop';
  fs.writeFileSync(path.join(apps(h), stale),
    '[Desktop Entry]\nName=TwinLine\nExec=/home/m/Downloads/TwinLine-1.4.2.AppImage %U\nX-AppImage-Version=1.4.2\n');
  // A launcher for an AppImage that still exists, and someone else's launcher, stay.
  const live = path.join(h, 'Live.AppImage');
  fs.writeFileSync(live, '');
  fs.writeFileSync(path.join(apps(h), 'appimagekit_9-TwinLine.desktop'), `[Desktop Entry]\nName=TwinLine\nExec=${live} %U\n`);
  fs.writeFileSync(path.join(apps(h), 'appimagekit_7-Other.desktop'), '[Desktop Entry]\nName=Other\nExec=/gone/Other.AppImage\n');
  fs.writeFileSync(path.join(h, '.config', 'mimeapps.list'),
    `[Default Applications]\nx-scheme-handler/sip=${stale}\nx-scheme-handler/tel=${stale};org.gnome.Other.desktop\ntext/plain=gedit.desktop\n`);

  const r = cleanStaleAppImageEntries(h);
  assert.deepStrictEqual(r.removed, [path.join(apps(h), stale)]);
  assert.strictEqual(r.mimeRepointed, true);
  assert.deepStrictEqual(fs.readdirSync(apps(h)).sort(), ['appimagekit_7-Other.desktop', 'appimagekit_9-TwinLine.desktop']);
  const mime = fs.readFileSync(path.join(h, '.config', 'mimeapps.list'), 'utf8');
  assert.ok(mime.includes('x-scheme-handler/sip=twinline.desktop\n'));
  assert.ok(mime.includes('x-scheme-handler/tel=twinline.desktop;org.gnome.Other.desktop\n'));
  assert.ok(mime.includes('text/plain=gedit.desktop'), 'unrelated lines untouched');
});

test('nothing happens without an applications folder or without stale entries', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-home-'));
  assert.deepStrictEqual(cleanStaleAppImageEntries(empty), { removed: [], mimeRepointed: false });
  const h = home();
  fs.writeFileSync(path.join(apps(h), 'twinline.desktop'), '[Desktop Entry]\nName=TwinLine\nExec=/gone/TwinLine.AppImage\n');
  const r = cleanStaleAppImageEntries(h);
  assert.deepStrictEqual(r.removed, [], "the package's own id is never removed");
});
