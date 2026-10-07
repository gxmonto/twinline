'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { BluetoothProfiles, parseCards, headsetProfileFor } = require('../src/main/linuxbt');

// `pactl list cards` as pipewire-pulse prints it on Fedora, trimmed to what matters.
const PACTL = [
  'Card #46',
  '\tName: bluez_card.00_1B_66_A1_B2_C3',
  '\tDriver: module-bluez5-device.c',
  '\tOwner Module: n/a',
  '\tProperties:',
  '\t\tdevice.description = "WH-1000XM4"',
  '\t\tdevice.form_factor = "headset"',
  '\tProfiles:',
  '\t\ta2dp-sink: High Fidelity Playback (A2DP Sink) (sinks: 1, sources: 0, priority: 16, available: yes)',
  '\t\ta2dp-sink-aac: High Fidelity Playback (A2DP Sink, codec AAC) (sinks: 1, sources: 0, priority: 18, available: yes)',
  '\t\theadset-head-unit: Headset Head Unit (HSP/HFP) (sinks: 1, sources: 1, priority: 1, available: yes)',
  '\t\theadset-head-unit-cvsd: Headset Head Unit (HSP/HFP, codec CVSD) (sinks: 1, sources: 1, priority: 2, available: yes)',
  '\t\theadset-head-unit-msbc: Headset Head Unit (HSP/HFP, codec mSBC) (sinks: 1, sources: 1, priority: 3, available: yes)',
  '\t\toff: Off (sinks: 0, sources: 0, priority: 0, available: yes)',
  '\tActive Profile: a2dp-sink-aac',
  '\tPorts:',
  '\t\theadset-output: Headset (type: Headset, priority: 0, latency offset: 0 usec, available)',
  '\t\t\tPart of profile(s): a2dp-sink, a2dp-sink-aac, headset-head-unit, headset-head-unit-cvsd, headset-head-unit-msbc',
  'Card #47',
  '\tName: alsa_card.pci-0000_00_1f.3',
  '\tDriver: alsa',
  '\tProfiles:',
  '\t\toutput:analog-stereo+input:analog-stereo: Analog Stereo Duplex (sinks: 1, sources: 1, priority: 6565, available: yes)',
  '\tActive Profile: output:analog-stereo+input:analog-stereo',
  'Card #48',
  '\tName: bluez_card.AA_BB_CC_DD_EE_FF',
  '\tProfiles:',
  '\t\ta2dp-sink: High Fidelity Playback (A2DP Sink) (sinks: 1, sources: 0, priority: 16, available: yes)',
  '\t\theadset-head-unit: Headset Head Unit (HSP/HFP) (sinks: 1, sources: 1, priority: 1, available: no)',
  '\t\toff: Off (sinks: 0, sources: 0, priority: 0, available: yes)',
  '\tActive Profile: a2dp-sink',
  '',
].join('\n');

test('pactl output is parsed into Bluetooth cards with their profiles', () => {
  const cards = parseCards(PACTL);
  assert.deepStrictEqual(cards.map((c) => c.name), ['bluez_card.00_1B_66_A1_B2_C3', 'bluez_card.AA_BB_CC_DD_EE_FF'], 'only Bluetooth cards');
  assert.strictEqual(cards[0].active, 'a2dp-sink-aac');
  assert.strictEqual(cards[0].profiles.length, 6);
  assert.deepStrictEqual(cards[1].profiles.find((p) => p.name === 'headset-head-unit'), { name: 'headset-head-unit', available: false });
});

test('the best available headset profile is chosen; a card without one, or not in A2DP, is left alone', () => {
  const [sony, other] = parseCards(PACTL);
  assert.strictEqual(headsetProfileFor(sony), 'headset-head-unit-msbc', 'mSBC preferred');
  assert.strictEqual(headsetProfileFor(other), null, 'its headset profile is unavailable');
  assert.strictEqual(headsetProfileFor({ ...sony, active: 'headset-head-unit' }), null, 'already in a call profile');
});

test('a call switches the headset to its call profile and the end of the last call restores it', async () => {
  const calls = [];
  const exec = (cmd, args, _opts, cb) => {
    calls.push(args.join(' '));
    cb(null, args[0] === 'list' ? PACTL : '');
  };
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const bt = new BluetoothProfiles({ exec });
    bt.update([{ state: 'incoming' }]);                       // ringing: music stays in high quality
    await bt._busy;
    assert.deepStrictEqual(calls, []);

    bt.update([{ state: 'connected' }]);
    await bt._busy;
    assert.deepStrictEqual(calls, ['list cards', 'set-card-profile bluez_card.00_1B_66_A1_B2_C3 headset-head-unit-msbc']);
    assert.strictEqual(bt.restore.get('bluez_card.00_1B_66_A1_B2_C3'), 'a2dp-sink-aac');

    bt.update([{ state: 'connected' }, { state: 'calling' }]);  // a second call changes nothing
    await bt._busy;
    assert.strictEqual(calls.length, 2);

    bt.update([]);                                             // last call ended: restore after the grace period
    clearTimeout(bt._restoreTimer);
    await bt.restoreProfiles();
    assert.strictEqual(calls[2], 'set-card-profile bluez_card.00_1B_66_A1_B2_C3 a2dp-sink-aac');
    assert.strictEqual(bt.restore.size, 0);
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
  }
});

test('without pactl the feature stays quiet', async () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const bt = new BluetoothProfiles({ exec: (_c, _a, _o, cb) => cb(Object.assign(new Error('spawn pactl ENOENT'), { code: 'ENOENT' })) });
    bt.update([{ state: 'connected' }]);
    await bt._busy;
    assert.strictEqual(bt.restore.size, 0);
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
  }
});

test('on Windows nothing happens at all', () => {
  if (process.platform !== 'linux') {
    const bt = new BluetoothProfiles({ exec: () => { throw new Error('must not be called'); } });
    bt.update([{ state: 'connected' }]);
    assert.strictEqual(bt.inCall, false);
  }
});
