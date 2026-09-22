'use strict';
/**
 * The only bridge between the renderer and Node. Everything is an explicit,
 * named call — the renderer never sees ipcRenderer or require.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Unwrap the { ok, data, error } envelope that main.js replies with. */
async function call(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

const listeners = new Map();

function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  listeners.set(handler, { channel, wrapped });
  return () => {
    const entry = listeners.get(handler);
    if (entry) { ipcRenderer.removeListener(entry.channel, entry.wrapped); listeners.delete(handler); }
  };
}

contextBridge.exposeInMainWorld('twinline', {
  info: () => call('app:info'),

  settings: {
    get: () => call('settings:get'),
    save: (settings) => call('settings:save', settings),
  },

  state: {
    get: () => call('state:get'),
    history: () => call('history:get'),
  },

  call: {
    dial: (target, accountId) => call('call:dial', { target, accountId }),
    answer: (callId) => call('call:answer', { callId }),
    reject: (callId, status) => call('call:reject', { callId, status }),
    hangup: (callId) => call('call:hangup', { callId }),
    hangupAll: () => call('call:hangupAll'),
    hold: (callId) => call('call:hold', { callId }),
    unhold: (callId) => call('call:unhold', { callId }),
    setActive: (callId) => call('call:setActive', { callId }),
    dtmf: (callId, digit) => call('call:dtmf', { callId, digit }),
    transferBlind: (callId, target) => call('call:transferBlind', { callId, target }),
    transferAttended: (callId, otherCallId) => call('call:transferAttended', { callId, otherCallId }),
  },

  conference: {
    start: (callIds) => call('conf:start', { callIds }),
    add: (callId) => call('conf:add', { callId }),
    holdParty: (callId) => call('conf:holdParty', { callId }),
    resumeParty: (callId) => call('conf:resumeParty', { callId }),
    remove: (callId) => call('conf:remove', { callId }),
    hangupParty: (callId) => call('conf:hangupParty', { callId }),
    split: (keepActiveId) => call('conf:split', { keepActiveId }),
    end: () => call('conf:end'),
  },

  contacts: {
    list: () => call('contacts:list'),
    add: (contact) => call('contacts:add', contact),
    update: (id, contact) => call('contacts:update', { id, contact }),
    remove: (id) => call('contacts:remove', { id }),
    import: () => call('contacts:import'),
    export: (format) => call('contacts:export', { format }),
  },

  popup: {
    resetPosition: () => call('popup:reset'),
  },

  log: {
    openFolder: () => call('log:open'),
  },

  network: {
    /** Tell the SIP stack the network changed so every line re-registers. */
    refresh: (reason) => call('network:refresh', { reason }),
  },

  updates: {
    status: () => call('update:status'),
    check: () => call('update:check'),
    download: () => call('update:download'),
    install: () => call('update:install'),
    dismiss: () => call('update:dismiss'),
  },

  audio: {
    mute: (muted) => call('audio:mute', { muted }),
    speakerGain: (gain) => call('audio:speakerGain', { gain }),
    micGain: (gain) => call('audio:micGain', { gain }),
    /** Send one 20 ms frame of microphone PCM to the SIP stack. */
    sendMicFrame: (int16) => ipcRenderer.send('audio:mic', int16.buffer),
  },

  window: {
    minimise: () => ipcRenderer.send('window:minimise'),
    close: () => ipcRenderer.send('window:close'),
  },

  on: {
    state: (fn) => on('state', fn),
    accounts: (fn) => on('accounts', fn),
    incoming: (fn) => on('incoming', fn),
    callEnded: (fn) => on('callEnded', fn),
    levels: (fn) => on('levels', fn),
    dtmf: (fn) => on('dtmf', fn),
    warning: (fn) => on('warning', fn),
    history: (fn) => on('history', fn),
    accountError: (fn) => on('accountError', fn),
    message: (fn) => on('message', fn),
    error: (fn) => on('error', fn),
    speaker: (fn) => on('audio:speaker', fn),
    popupCalls: (fn) => on('popup:calls', fn),
    update: (fn) => on('update', fn),
  },
});
