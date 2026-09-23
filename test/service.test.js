'use strict';
/**
 * TranscriptionService plumbing, with a fake worker in place of the Electron
 * utility process: does microphone audio actually reach the "mic" channel,
 * does each caller's audio reach its own channel, and do segments come back
 * attributed to the right speaker?
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { TranscriptionService } = require('../src/main/transcribe/service');
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

test('microphone and each caller reach their own channels', async () => {
  const { audio, service, worker } = await setup();
  await service.start({ callId: 'callA', remoteNumber: '5550100', answeredAt: Date.now() });
  const w = worker();

  const opens = w.posted.filter((m) => m.type === 'open').map((m) => m.id);
  assert.deepStrictEqual(opens.sort(), ['callA|remote', 'mic']);

  // Drive the mixer as the engine's clock would, with a real mic frame.
  const mic = new Int16Array(160).fill(1234);
  audio.mixer.tick(mic);
  audio.emit('frames', { mic: audio.mixer.lastMic, legs: audio.mixer.lastInbound });

  const audioMsgs = w.posted.filter((m) => m.type === 'audio');
  const micMsg = audioMsgs.find((m) => m.id === 'mic');
  const remoteMsg = audioMsgs.find((m) => m.id === 'callA|remote');
  assert.ok(micMsg, 'a mic frame was sent');
  assert.strictEqual(micMsg.samples[0], 1234, 'with the microphone samples');
  assert.ok(remoteMsg, 'the caller frame was sent');
  assert.strictEqual(remoteMsg.samples[0], 3000, 'with that caller\'s samples');
  assert.ok(!audioMsgs.some((m) => m.id === 'callB|remote'), 'a call that is not being transcribed sends nothing');

  assert.strictEqual(service.counters.get('mic').frames, 1);
  assert.strictEqual(service.counters.get('mic').loud, 1);
});

test('a tick with no microphone frame is counted, not sent', async () => {
  const { audio, service, worker } = await setup();
  await service.start({ callId: 'callA', remoteNumber: '1', answeredAt: Date.now() });
  audio.mixer.tick(null);
  audio.emit('frames', { mic: audio.mixer.lastMic, legs: audio.mixer.lastInbound });
  assert.ok(!worker().posted.some((m) => m.type === 'audio' && m.id === 'mic'));
  assert.strictEqual(service.counters.get('mic').empty, 1);
});

test('segments are attributed: mic → You on every live call, remote → that call only', async () => {
  const { service, worker, dir } = await setup();
  const lines = [];
  service.on('line', (l) => lines.push(l));
  const t0 = Date.now() - 5000;
  await service.start({ callId: 'callA', remoteNumber: '111', answeredAt: t0 });
  await service.start({ callId: 'callB', remoteNumber: '222', answeredAt: t0 });
  const w = worker();

  w.reply({ type: 'segment', channel: 'mic', text: 'hello both', startMs: 100, endMs: 900 });
  w.reply({ type: 'segment', channel: 'callA|remote', text: 'hi from A', startMs: 1000, endMs: 1800 });
  w.reply({ type: 'segment', channel: 'callB|remote', text: 'hi from B', startMs: 1200, endMs: 2000 });

  const forA = lines.filter((l) => l.callId === 'callA').map((l) => `${l.line.speaker}:${l.line.text}`);
  const forB = lines.filter((l) => l.callId === 'callB').map((l) => `${l.line.speaker}:${l.line.text}`);
  assert.deepStrictEqual(forA, ['you:hello both', 'caller:hi from A']);
  assert.deepStrictEqual(forB, ['you:hello both', 'caller:hi from B']);
  assert.ok(lines[0].line.atMs >= 5000, 'timestamps are relative to when the call was answered');

  const finished = [];
  service.on('finished', (f) => finished.push(f));
  await service.stop('callA');
  assert.strictEqual(finished.length, 1);
  assert.ok(finished[0].file, 'a transcript with lines is saved');
  const saved = fs.readFileSync(path.join(dir, finished[0].file.replace(/\.json$/, '.txt')), 'utf8');
  assert.ok(saved.includes('You: hello both'));
  assert.ok(saved.includes('Caller: hi from A'));
  assert.ok(!saved.includes('hi from B'));

  // The mic channel stays open while call B is still transcribing.
  assert.ok(!w.posted.some((m) => m.type === 'close' && m.id === 'mic'));
  await service.stop('callB');
  assert.ok(w.posted.some((m) => m.type === 'close' && m.id === 'mic'), 'and closes with the last one');
  assert.strictEqual(service.list().length, 2);
});

test('the worker is told the model type and a sensible thread count', async () => {
  const { service, worker } = await setup();
  await service.start({ callId: 'callA', remoteNumber: '1', answeredAt: Date.now() });
  const init = worker().posted.find((m) => m.type === 'init');
  assert.strictEqual(init.model.type, 'nemo_transducer');
  assert.strictEqual(init.model.joiner, 'j');
  assert.strictEqual(init.threads, 2);
  service.configure({ threads: 0 });
  assert.ok(service.settings.threads === 0);
});
