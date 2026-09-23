'use strict';
/**
 * TranscriptionService plumbing, with a fake worker in place of the Electron
 * utility process: does microphone audio actually reach the "mic" channel,
 * does each party's audio reach its own channel, do conference members all
 * get heard and labelled, and do segments come back attributed correctly?
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { TranscriptionService, formatTranscript } = require('../src/main/transcribe/service');
const { AudioEngine } = require('../src/main/media/engine');

/** Records everything posted to it; `reply()` lets a test answer as the worker would. */
function fakeWorker() {
  const child = new EventEmitter();
  child.posted = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.postMessage = (msg) => {
    child.posted.push(msg);
    if (msg.type === 'init') setImmediate(() => child.emit('message', { type: 'ready', version: 'fake' }));
    if (msg.type === 'close') setImmediate(() => child.emit('message', { type: 'closed', id: msg.id }));
  };
  child.kill = () => {};
  child.reply = (msg) => child.emit('message', msg);
  child.opened = () => child.posted.filter((m) => m.type === 'open').map((m) => m.id).sort();
  child.audioFor = (id) => child.posted.filter((m) => m.type === 'audio' && m.id === id);
  return child;
}

function fakeModels() {
  return {
    installed: () => true,
    paths: (id) => (id === 'vad' ? { vad: 'v.onnx' } : { type: 'nemo_transducer', encoder: 'e', decoder: 'd', joiner: 'j', tokens: 't' }),
    constructor: { entry: () => ({ type: 'nemo_transducer' }) },
  };
}

/** A leg whose inbound audio is a constant, so we can recognise it downstream. */
function fakeLeg(value) {
  return { pullFrame: () => new Int16Array(160).fill(value), sendFrame() {}, setDirection() {}, setMuted() {}, close() {}, on() {} };
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-transcripts-'));
  const audio = new AudioEngine();
  audio.mixer.addLeg('callA', fakeLeg(3000), 'active');
  audio.mixer.addLeg('callB', fakeLeg(-2000), 'active');
  let worker;
  const service = new TranscriptionService({
    audio, models: fakeModels(), transcriptsDir: dir, workerPath: 'worker.js', platformDir: 'libs',
    fork: () => { worker = fakeWorker(); return worker; },
  });
  service.configure({ model: 'parakeet', threads: 2 });
  return { audio, service, dir, worker: () => worker };
}

function tick(audio, micValue) {
  const mic = micValue == null ? null : new Int16Array(160).fill(micValue);
  audio.mixer.tick(mic);
  audio.emit('frames', { mic: audio.mixer.lastMic, legs: audio.mixer.lastInbound });
}

test('microphone and the call reach their own channels', async () => {
  const { audio, service, worker } = await setup();
  await service.start({ callId: 'callA', remoteNumber: '5550100', answeredAt: Date.now() });
  const w = worker();
  assert.deepStrictEqual(w.opened(), ['callA|party:callA', 'mic']);

  tick(audio, 1234);
  assert.strictEqual(w.audioFor('mic')[0].samples[0], 1234, 'microphone samples were sent');
  assert.strictEqual(w.audioFor('callA|party:callA')[0].samples[0], 3000, 'that caller\'s samples were sent');
  assert.strictEqual(w.audioFor('callA|party:callB').length, 0, 'a call that is not part of it sends nothing');
  assert.strictEqual(service.counters.get('mic').frames, 1);
  assert.strictEqual(service.counters.get('mic').loud, 1);
});

test('a tick with no microphone frame is counted, not sent', async () => {
  const { audio, service, worker } = await setup();
  await service.start({ callId: 'callA', remoteNumber: '1', answeredAt: Date.now() });
  tick(audio, null);
  assert.strictEqual(worker().audioFor('mic').length, 0);
  assert.strictEqual(service.counters.get('mic').empty, 1);
});

test('conference: every member is heard and labelled by name', async () => {
  const { audio, service, worker, dir } = await setup();
  // The CallManager says callA is in a conference with callB.
  service.participants = (id) => (id === 'callA'
    ? [{ callId: 'callA', label: 'Ada' }, { callId: 'callB', label: 'Bob' }]
    : [{ callId: id, label: id }]);
  const lines = [];
  service.on('line', (l) => lines.push(l.line));

  await service.start({ callId: 'callA', remoteNumber: '111', answeredAt: Date.now() - 1000 });
  const w = worker();
  assert.deepStrictEqual(w.opened(), ['callA|party:callA', 'callA|party:callB', 'mic']);
  assert.strictEqual(service.isActive('callB'), true, 'the other member counts as transcribed');

  tick(audio, 500);
  assert.strictEqual(w.audioFor('callA|party:callA')[0].samples[0], 3000);
  assert.strictEqual(w.audioFor('callA|party:callB')[0].samples[0], -2000, 'the second member\'s audio flows too');

  w.reply({ type: 'segment', channel: 'callA|party:callB', text: 'hola', startMs: 100, endMs: 800 });
  w.reply({ type: 'segment', channel: 'callA|party:callA', text: 'hello', startMs: 900, endMs: 1500 });
  w.reply({ type: 'segment', channel: 'mic', text: 'hi both', startMs: 1600, endMs: 2000 });
  assert.deepStrictEqual(lines.map((l) => `${l.speaker}/${l.party}:${l.text}`), ['caller/Bob:hola', 'caller/Ada:hello', 'you/null:hi both']);

  // Bob leaves the conference: his channel closes, his lines keep his name.
  service.participants = () => [{ callId: 'callA', label: 'Ada' }];
  tick(audio, 500);
  assert.ok(w.posted.some((m) => m.type === 'close' && m.id === 'callA|party:callB'));

  const finished = [];
  service.on('finished', (f) => finished.push(f));
  await service.stop('callA');
  const text = fs.readFileSync(path.join(dir, finished[0].file.replace(/\.json$/, '.txt')), 'utf8');
  assert.ok(text.includes('Conference with: Ada, Bob'));
  assert.ok(text.includes('] Bob: hola'));
  assert.ok(text.includes('] Ada: hello'));
  assert.ok(text.includes('] You: hi both'));
});

test('two-party transcripts still say "Caller"', () => {
  const record = { remoteNumber: '1', startedAt: Date.now(), model: 'parakeet', language: 'auto', partyLabels: { c1: '5550100' },
    lines: [{ speaker: 'caller', party: '5550100', atMs: 0, text: 'hi' }, { speaker: 'you', atMs: 1000, text: 'hello' }] };
  const text = formatTranscript(record);
  assert.ok(text.includes('] Caller: hi'));
  assert.ok(!text.includes('Conference with'));
});

test('merging a conference keeps the earliest transcript and closes the rest', async () => {
  const { service, worker } = await setup();
  await service.start({ callId: 'callA', remoteNumber: '111', answeredAt: Date.now() });
  await new Promise((r) => setTimeout(r, 5));
  await service.start({ callId: 'callB', remoteNumber: '222', answeredAt: Date.now() });
  assert.strictEqual(service.live.size, 2);

  service.participants = (id) => [{ callId: 'callA', label: 'A' }, { callId: 'callB', label: 'B' }];
  const kept = await service.mergeConference(['callA', 'callB']);
  assert.strictEqual(kept.callId, 'callA');
  assert.strictEqual(service.live.size, 1);
  assert.deepStrictEqual(kept.parties.sort(), ['A', 'B']);
  assert.strictEqual(service.isActive('callB'), true, 'callB is now covered by callA\'s transcript');
  assert.ok(worker().posted.some((m) => m.type === 'open' && m.id === 'callA|party:callB'));
});

test('segments are attributed and saved; the mic channel closes with the last transcript', async () => {
  const { service, worker, dir } = await setup();
  const lines = [];
  service.on('line', (l) => lines.push(l));
  const t0 = Date.now() - 5000;
  await service.start({ callId: 'callA', remoteNumber: '111', answeredAt: t0 });
  await service.start({ callId: 'callB', remoteNumber: '222', answeredAt: t0 });
  const w = worker();

  w.reply({ type: 'segment', channel: 'mic', text: 'hello both', startMs: 100, endMs: 900 });
  w.reply({ type: 'segment', channel: 'callA|party:callA', text: 'hi from A', startMs: 1000, endMs: 1800 });
  w.reply({ type: 'segment', channel: 'callB|party:callB', text: 'hi from B', startMs: 1200, endMs: 2000 });

  const forA = lines.filter((l) => l.callId === 'callA').map((l) => `${l.line.speaker}:${l.line.text}`);
  const forB = lines.filter((l) => l.callId === 'callB').map((l) => `${l.line.speaker}:${l.line.text}`);
  assert.deepStrictEqual(forA, ['you:hello both', 'caller:hi from A']);
  assert.deepStrictEqual(forB, ['you:hello both', 'caller:hi from B']);
  assert.ok(lines[0].line.atMs >= 5000, 'timestamps are relative to when the call was answered');

  const finished = [];
  service.on('finished', (f) => finished.push(f));
  await service.stop('callA');
  const saved = fs.readFileSync(path.join(dir, finished[0].file.replace(/\.json$/, '.txt')), 'utf8');
  assert.ok(saved.includes('You: hello both') && saved.includes('Caller: hi from A') && !saved.includes('hi from B'));
  assert.ok(!w.posted.some((m) => m.type === 'close' && m.id === 'mic'));
  await service.stop('callB');
  assert.ok(w.posted.some((m) => m.type === 'close' && m.id === 'mic'), 'closes with the last one');
  assert.strictEqual(service.list().length, 2);
});

test('the worker is told the model type and a sensible thread count', async () => {
  const { service, worker } = await setup();
  await service.start({ callId: 'callA', remoteNumber: '1', answeredAt: Date.now() });
  const init = worker().posted.find((m) => m.type === 'init');
  assert.strictEqual(init.model.type, 'nemo_transducer');
  assert.strictEqual(init.model.joiner, 'j');
  assert.strictEqual(init.threads, 2);
});
