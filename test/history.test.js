'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { CallManager } = require('../src/main/callmanager');

const fakeCall = (id, overrides = {}) => ({
  id, accountId: 'line1', direction: 'in', remoteNumber: '+15551234567', remoteDisplayName: 'Ann',
  createdAt: 1000, answeredAt: 2000, endedAt: 9000, ...overrides,
});

test('call history is written to disk and read back by the next CallManager', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-hist-'));
  const file = path.join(dir, 'history.json');

  const first = new CallManager({ audio: new EventEmitter(), historyFile: file });
  assert.deepStrictEqual(first.history, []);
  first._recordHistory(fakeCall('c1'), { reason: 'hangup', status: 200 });
  first._recordHistory(fakeCall('c2', { answeredAt: null, endedAt: 3000 }), { reason: 'cancelled' });
  assert.ok(fs.existsSync(file), 'saved as soon as a call ends');

  const second = new CallManager({ audio: new EventEmitter(), historyFile: file });
  assert.strictEqual(second.history.length, 2);
  assert.strictEqual(second.history[0].id, 'c2', 'newest first, as before');
  assert.strictEqual(second.history[0].missed, true);
  assert.strictEqual(second.history[1].durationMs, 7000);
});

test('a damaged history file is ignored rather than crashing start-up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-hist-'));
  const file = path.join(dir, 'history.json');
  fs.writeFileSync(file, '{not json');
  assert.deepStrictEqual(new CallManager({ audio: new EventEmitter(), historyFile: file }).history, []);
  fs.writeFileSync(file, JSON.stringify([{ id: 'ok' }, 'junk', null, { noId: true }]));
  assert.deepStrictEqual(new CallManager({ audio: new EventEmitter(), historyFile: file }).history, [{ id: 'ok' }]);
  assert.deepStrictEqual(new CallManager({ audio: new EventEmitter() }).history, [], 'no file configured: in-memory only');
});
