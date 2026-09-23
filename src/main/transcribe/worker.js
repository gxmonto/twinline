'use strict';
/**
 * Utility-process entry point: hosts the Transcriber so Whisper decoding
 * (seconds of CPU per utterance) can never disturb the main process's
 * 20 ms audio clock.
 *
 * Messages in:
 *   { type: 'init', model: {encoder, decoder, tokens}, vadModel, language, threads }
 *   { type: 'open', id, label, inputRate }
 *   { type: 'audio', id, samples: Int16Array }
 *   { type: 'close', id }
 *   { type: 'shutdown' }
 * Messages out:
 *   { type: 'ready', version } | { type: 'error', message, fatal }
 *   { type: 'segment', channel, label, text, lang, startMs, endMs, decodeMs }
 *   { type: 'speaking', id, speaking }
 *   { type: 'closed', id }        after a channel's last segment was decoded
 */

const { Transcriber } = require('./core');

const port = process.parentPort;
const post = (msg) => port.postMessage(msg);

let transcriber = null;

async function init(msg) {
  let sherpa;
  try {
    sherpa = require('sherpa-onnx-node');
  } catch (err) {
    post({ type: 'error', fatal: true, message: `speech engine failed to load: ${err.message}` });
    return;
  }
  try {
    transcriber = new Transcriber({
      sherpa,
      model: msg.model,
      vadModel: msg.vadModel,
      speakerModel: msg.speakerModel || null,
      language: msg.language,
      threads: msg.threads,
      onSegment: (seg) => post({ type: 'segment', ...seg }),
      onSpeaking: (id, speaking) => post({ type: 'speaking', id, speaking }),
    });
    await transcriber.init();
    post({ type: 'ready', version: sherpa.version, voices: !!transcriber.speaker });
  } catch (err) {
    post({ type: 'error', fatal: true, message: `could not load the model: ${err.message}` });
  }
}

port.on('message', async (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init': await init(msg); break;
      case 'open': transcriber && transcriber.openChannel(msg.id, { inputRate: msg.inputRate, label: msg.label }); break;
      case 'audio': transcriber && transcriber.pushAudio(msg.id, new Int16Array(msg.samples)); break;
      case 'close':
        if (transcriber) {
          transcriber.closeChannel(msg.id);
          await transcriber.idle();
        }
        post({ type: 'closed', id: msg.id });
        break;
      case 'shutdown':
        if (transcriber) { transcriber.close(); await transcriber.idle(); }
        post({ type: 'bye' });
        process.exit(0);
        break;
      default: break;
    }
  } catch (err) {
    post({ type: 'error', fatal: false, message: err.message, id: msg.id });
  }
});

port.start?.();
post({ type: 'hello' });
