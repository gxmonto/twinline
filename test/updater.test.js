'use strict';
const test = require('node:test');
const assert = require('node:assert');

// updater.js requires electron at load; stub the two things it touches.
const Module = require('module');
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { getVersion: () => '1.0.4', isPackaged: false }, shell: { openExternal: async () => {} } };
  }
  return realLoad.call(this, request, ...rest);
};
const { compareVersions, parseLatestYml, feedFromUrl, linuxManifestUrl, linuxPackageKind, linuxDownloadUrl } = require('../src/main/updater');
Module._load = realLoad;

test('deb/rpm installs are sent to their own package, never the AppImage', () => {
  const gh = { provider: 'github', owner: 'gxmonto', repo: 'twinline' };
  assert.strictEqual(linuxDownloadUrl(gh, '1.4.7', 'rpm', 'x64'), 'https://github.com/gxmonto/twinline/releases/download/v1.4.7/twinline-1.4.7.x86_64.rpm');
  assert.strictEqual(linuxDownloadUrl(gh, '1.4.7', 'deb', 'x64'), 'https://github.com/gxmonto/twinline/releases/download/v1.4.7/twinline_1.4.7_amd64.deb');
  assert.strictEqual(linuxDownloadUrl(gh, '1.4.7', 'rpm', 'arm64'), 'https://github.com/gxmonto/twinline/releases/download/v1.4.7/twinline-1.4.7.aarch64.rpm');
  assert.strictEqual(linuxDownloadUrl(gh, '1.4.7', null, 'x64'), 'https://github.com/gxmonto/twinline/releases/tag/v1.4.7', 'unknown kind: the release page, not a file');
  const generic = { provider: 'generic', url: 'https://updates.example.com/twinline' };
  assert.strictEqual(linuxDownloadUrl(generic, '2.0.0', 'deb', 'x64'), 'https://updates.example.com/twinline/twinline_2.0.0_amd64.deb');
  assert.strictEqual(linuxDownloadUrl(generic, '2.0.0', null, 'x64'), 'https://updates.example.com/twinline/');
});

test('the package manager that owns the install is asked first, the distro family second', () => {
  if (process.platform !== 'linux') {
    assert.strictEqual(linuxPackageKind(), null, 'not Linux: never a package');
  }
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  const savedAppImage = process.env.APPIMAGE;
  delete process.env.APPIMAGE;
  try {
    const exec = (answers) => (cmd) => { if (!answers[cmd]) { const e = new Error('not installed'); throw e; } };
    assert.strictEqual(linuxPackageKind({ execFileSync: exec({ rpm: true }), readFile: () => '' }), 'rpm');
    assert.strictEqual(linuxPackageKind({ execFileSync: exec({ 'dpkg-query': true }), readFile: () => '' }), 'deb');
    assert.strictEqual(linuxPackageKind({ execFileSync: exec({}), readFile: () => 'ID=fedora\nID_LIKE=rhel\n' }), 'rpm');
    assert.strictEqual(linuxPackageKind({ execFileSync: exec({}), readFile: () => 'ID=ubuntu\nID_LIKE=debian\n' }), 'deb');
    assert.strictEqual(linuxPackageKind({ execFileSync: exec({}), readFile: () => 'ID=arch\n' }), null);
    process.env.APPIMAGE = '/tmp/TwinLine.AppImage';
    assert.strictEqual(linuxPackageKind({ execFileSync: exec({ rpm: true }), readFile: () => '' }), null, 'an AppImage updates itself');
  } finally {
    if (savedAppImage === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = savedAppImage;
    Object.defineProperty(process, 'platform', realPlatform);
  }
});

test('version comparison', () => {
  assert.ok(compareVersions('1.0.4', '1.0.3') > 0);
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0, 'numeric, not lexical');
  assert.ok(compareVersions('1.1.0', '1.0.99') > 0);
  assert.strictEqual(compareVersions('v2.0.0', '2.0.0'), 0);
  assert.ok(compareVersions('2.0.0-beta.1', '2.0.0') < 0, 'pre-release precedes release');
  assert.ok(compareVersions('2.0.0', '1.9.9-rc') > 0);
});

test('parses the manifest electron-builder writes', () => {
  const yml = [
    'version: 1.0.5',
    'files:',
    '  - url: TwinLine-1.0.5.AppImage',
    '    sha512: abc',
    '    size: 1234',
    '  - url: twinline_1.0.5_amd64.deb',
    '    sha512: def',
    'path: TwinLine-1.0.5.AppImage',
    'sha512: abc',
    "releaseDate: '2026-09-22T12:00:00.000Z'",
    'releaseNotes: |',
    '  Fixes the tray icon.',
    '  Adds contacts.',
    '',
  ].join('\n');
  const m = parseLatestYml(yml);
  assert.strictEqual(m.version, '1.0.5');
  assert.strictEqual(m.path, 'TwinLine-1.0.5.AppImage');
  assert.strictEqual(m.files.length, 2);
  assert.strictEqual(m.files[1].url, 'twinline_1.0.5_amd64.deb');
  assert.strictEqual(m.releaseDate, '2026-09-22T12:00:00.000Z');
  assert.strictEqual(m.releaseNotes, 'Fixes the tray icon.\nAdds contacts.');
});

test('feed URLs map to the right provider', () => {
  assert.deepStrictEqual(feedFromUrl('https://github.com/acme/twinline'), { provider: 'github', owner: 'acme', repo: 'twinline' });
  assert.deepStrictEqual(feedFromUrl('https://github.com/acme/twinline.git/'), { provider: 'github', owner: 'acme', repo: 'twinline' });
  assert.deepStrictEqual(feedFromUrl('https://updates.example.com/twinline/'), { provider: 'generic', url: 'https://updates.example.com/twinline' });
  assert.strictEqual(feedFromUrl(''), null);
  assert.strictEqual(linuxManifestUrl(feedFromUrl('https://updates.example.com/twinline')), 'https://updates.example.com/twinline/latest-linux.yml');
  assert.strictEqual(linuxManifestUrl(feedFromUrl('https://github.com/acme/twinline')), 'https://github.com/acme/twinline/releases/latest/download/latest-linux.yml');
});
