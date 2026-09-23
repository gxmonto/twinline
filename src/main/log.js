'use strict';
/**
 * Small file logger with size-based rotation.
 *
 * Writes go straight to disk (appendFileSync) so the tail of the log survives
 * a crash. Volume is low — registration events, call state, errors — unless
 * SIP tracing is switched on, in which case every message is recorded.
 *
 * Usage:
 *   const log = require('./log');
 *   log.init(dir);                 // once, in main
 *   const l = log.child('ua:line1');
 *   l.info('registered', { expires: 300 });
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const state = {
  dir: null,
  file: null,
  maxBytes: 2 * 1024 * 1024,
  keep: 3,
  level: LEVELS.info,
  traceSip: false,
  size: 0,
  buffer: [],            // lines logged before init()
};

function init(dir, { maxBytes, keep } = {}) {
  state.dir = dir;
  state.file = path.join(dir, 'twinline.log');
  if (maxBytes) state.maxBytes = maxBytes;
  if (keep) state.keep = keep;
  fs.mkdirSync(dir, { recursive: true });
  try { state.size = fs.statSync(state.file).size; } catch { state.size = 0; }
  for (const line of state.buffer) write(line);
  state.buffer.length = 0;
  info('log', `--- log opened; pid ${process.pid}, platform ${process.platform} ---`);
}

function setLevel(level) {
  state.level = LEVELS[level] ?? LEVELS.info;
}

/** Turn full SIP message tracing on or off (implies debug level when on). */
function setTraceSip(enabled) {
  state.traceSip = !!enabled;
  state.level = enabled ? LEVELS.debug : LEVELS.info;
  info('log', `SIP trace ${enabled ? 'enabled' : 'disabled'}`);
}

function rotate() {
  for (let i = state.keep - 1; i >= 1; i--) {
    const from = i === 1 ? state.file : `${state.file}.${i - 1}`;
    const to = `${state.file}.${i}`;
    try { fs.renameSync(from, to); } catch { /* nothing to rotate */ }
  }
  state.size = 0;
}

function write(line) {
  if (!state.file) { state.buffer.push(line); if (state.buffer.length > 500) state.buffer.shift(); return; }
  try {
    if (state.size + line.length > state.maxBytes) rotate();
    fs.appendFileSync(state.file, line + '\n');
    state.size += line.length + 1;
  } catch { /* logging must never take the app down */ }
}

function format(level, scope, message, data) {
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (data !== undefined) {
    try {
      line += ' ' + (typeof data === 'string' ? data : JSON.stringify(data, replacer));
    } catch {
      line += ' [unserialisable]';
    }
  }
  return line;
}

function replacer(_key, value) {
  if (value instanceof Error) return { message: value.message, code: value.code };
  return value;
}

function log(level, scope, message, data) {
  if ((LEVELS[level] ?? LEVELS.info) < state.level) return;
  write(format(level, scope, message, data));
}

const debug = (scope, msg, data) => log('debug', scope, msg, data);
const info = (scope, msg, data) => log('info', scope, msg, data);
const warn = (scope, msg, data) => log('warn', scope, msg, data);
const error = (scope, msg, data) => log('error', scope, msg, data);

/**
 * Blank the parts of a SIP message that would let a reader of the log answer
 * the server's challenge: the digest response and the nonces it was computed
 * over. Username and realm stay — they are what the trace is usually read
 * for. Header names are matched case-insensitively.
 */
function redactSip(text) {
  return String(text).replace(/^((?:Proxy-)?Authorization|WWW-Authenticate|Proxy-Authenticate|Authentication-Info):(.*)$/gim,
    (_, name, value) => `${name}:${value.replace(/\b(response|c?nonce|rspauth)=("?)[^",\s]*\2/gi, '$1=$2[redacted]$2')}`);
}

/** Record one SIP message when tracing is on. */
function sip(scope, direction, text, peer) {
  if (!state.traceSip) return;
  const where = peer ? `${peer.address}:${peer.port}` : '';
  write(format('debug', scope, `${direction} ${where}\n${redactSip(text).replace(/\r\n/g, '\n').trimEnd()}`));
}

function child(scope) {
  return {
    debug: (msg, data) => debug(scope, msg, data),
    info: (msg, data) => info(scope, msg, data),
    warn: (msg, data) => warn(scope, msg, data),
    error: (msg, data) => error(scope, msg, data),
    sip: (direction, text, peer) => sip(scope, direction, text, peer),
    get traceSip() { return state.traceSip; },
  };
}

module.exports = {
  init, setLevel, setTraceSip, child, debug, info, warn, error, sip, redactSip,
  get dir() { return state.dir; },
  get file() { return state.file; },
  get traceSip() { return state.traceSip; },
  _state: state,
};
