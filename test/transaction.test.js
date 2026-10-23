'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ClientTransaction } = require('../src/main/sip/transaction');

const layer = () => ({ clientTransactions: new Map(), transport: { type: 'UDP' }, send: async () => {} });
const request = (method) => ({ method, uri: 'sip:x', version: 'SIP/2.0', headers: { via: ['SIP/2.0/UDP 1.2.3.4:5060;branch=z9hG4bKabc'], cseq: [`1 ${method}`] }, body: '' });

test('an INVITE that got a provisional response no longer times out while it rings (Timer B stops)', () => {
  const txn = new ClientTransaction(layer(), request('INVITE'), { address: '127.0.0.1', port: 5060 }).start();
  assert.ok(txn.timers.timeout, 'Timer B armed while Calling');
  txn.receiveResponse({ status: 180, headers: {} });
  assert.strictEqual(txn.timers.timeout, null, 'Timer B gone once Proceeding');
  assert.strictEqual(txn.state, 'proceeding');
  txn._terminate();
});

test('a non-INVITE keeps its overall timeout after a provisional (Timer F)', () => {
  const txn = new ClientTransaction(layer(), request('REGISTER'), { address: '127.0.0.1', port: 5060 }).start();
  txn.receiveResponse({ status: 100, headers: {} });
  assert.ok(txn.timers.timeout);
  txn._terminate();
});
