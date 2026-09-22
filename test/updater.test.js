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
const { compareVersions, parseLatestYml, feedFromUrl, linuxManifestUrl } = require('../src/main/updater');
Module._load = realLoad;

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
