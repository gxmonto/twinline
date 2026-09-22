'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ContactStore, normalizeNumber, numbersMatch, parseCSV, parseVCard } = require('../src/main/contacts');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-contacts-'));
  const store = new ContactStore(dir);
  store.load();
  return store;
}

test('numbers normalise and match on a shared tail', () => {
  assert.strictEqual(normalizeNumber('+1 (555) 010-1234'), '+15550101234');
  assert.strictEqual(numbersMatch('5550101234', '+1 555 010 1234'), true);
  assert.strictEqual(numbersMatch('1234', '+15550101234'), false, 'short tails are not matches');
  assert.strictEqual(numbersMatch('101', '101'), true, 'extensions match exactly');
  assert.strictEqual(numbersMatch('101', '201'), false);
});

test('store round-trips through disk and looks up callers', () => {
  const store = tempStore();
  const a = store.add({ name: 'Ada Lovelace', number: '+1 555 010 1234', company: 'Analytical' });
  store.add({ name: 'Front desk', number: '101' });

  const again = new ContactStore(path.dirname(store.file));
  again.load();
  assert.strictEqual(again.list().length, 2);
  assert.strictEqual(again.findByNumber('15550101234').id, a.id);
  assert.strictEqual(again.findByNumber('101').name, 'Front desk');
  assert.strictEqual(again.findByNumber('999'), null);
});

test('update and remove', () => {
  const store = tempStore();
  const c = store.add({ name: 'Bob', number: '200' });
  store.update(c.id, { name: 'Robert' });
  assert.strictEqual(store.get(c.id).name, 'Robert');
  assert.strictEqual(store.get(c.id).number, '200', 'unspecified fields are kept');
  assert.deepStrictEqual(store.remove(c.id), { removed: 1 });
  assert.strictEqual(store.list().length, 0);
});

test('a contact needs a name or a number', () => {
  const store = tempStore();
  assert.throws(() => store.add({ company: 'Nobody Inc' }));
  assert.strictEqual(store.add({ number: '300' }).name, '300', 'number becomes the name');
});

test('CSV export parses back identically', () => {
  const store = tempStore();
  store.add({ name: 'Smith, Jane', number: '+44 20 7946 0958', notes: 'Says "hi"\nmultiline' });
  store.add({ name: 'Ext 12', number: '12', accountId: 'line2' });

  const parsed = parseCSV(store.toCSV());
  assert.strictEqual(parsed.length, 2);
  const jane = parsed.find((c) => c.name === 'Smith, Jane');
  assert.strictEqual(jane.number, '+44 20 7946 0958');
  assert.strictEqual(jane.notes, 'Says "hi"\nmultiline');
  assert.strictEqual(parsed.find((c) => c.name === 'Ext 12').accountId, 'line2');
});

test('CSV import understands other tools\' headers', () => {
  const outlook = 'First Name,Last Name,Business Phone,E-mail Address\r\nGrace,Hopper,555-0100,grace@example.com\r\n';
  const parsed = parseCSV(outlook);
  assert.deepStrictEqual(parsed, [{ number: '555-0100', email: 'grace@example.com', name: 'Grace Hopper' }]);

  const semicolons = 'Name;Telephone\nLinus;+358 9 123\n';
  assert.deepStrictEqual(parseCSV(semicolons), [{ name: 'Linus', number: '+358 9 123' }]);

  const headerless = 'Reception,100\nWarehouse,101\n';
  assert.strictEqual(parseCSV(headerless).length, 2);
  assert.strictEqual(parseCSV(headerless)[1].number, '101');
});

test('vCard export parses back, including escapes and folding', () => {
  const store = tempStore();
  store.add({ name: 'Doe; John', number: '+1 555 010 9999', company: 'ACME, Inc', email: 'j@acme.example' });
  const vcf = store.toVCard();
  assert.ok(vcf.includes('BEGIN:VCARD'));
  assert.ok(vcf.includes('FN:Doe\\; John'));

  const parsed = parseVCard(vcf);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].name, 'Doe; John');
  assert.strictEqual(parsed[0].company, 'ACME, Inc');
  assert.strictEqual(parsed[0].number, '+1 555 010 9999');

  const folded = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Turing;Alan;;;\r\nTEL;TYPE=CELL:+44 1234\r\n 567890\r\nEND:VCARD\r\n';
  const t = parseVCard(folded)[0];
  assert.strictEqual(t.name, 'Alan Turing', 'N is used when FN is absent');
  assert.strictEqual(t.number, '+44 1234567890', 'folded lines are joined');
});

test('import merges on number instead of duplicating', () => {
  const store = tempStore();
  store.add({ name: 'Old Name', number: '555 0100' });
  const outcome = store.importMany([
    { name: 'New Name', number: '5550100', company: 'Co' },
    { name: 'Someone Else', number: '5550199' },
    { company: 'no name or number' },
  ]);
  assert.deepStrictEqual(outcome, { added: 1, updated: 1, skipped: 1, total: 2 });
  assert.strictEqual(store.findByNumber('5550100').name, 'New Name');
  assert.strictEqual(store.findByNumber('5550100').company, 'Co');
});

test('format sniffing picks the right parser', () => {
  assert.strictEqual(ContactStore.parse('[{"name":"A","number":"1"}]').length, 1);
  assert.strictEqual(ContactStore.parse('BEGIN:VCARD\nFN:B\nTEL:2\nEND:VCARD').length, 1);
  assert.strictEqual(ContactStore.parse('name,number\nC,3\n', 'x.csv').length, 1);
  assert.strictEqual(ContactStore.parse('﻿{"contacts":[{"displayName":"D","phone":"4"}]}')[0].name, 'D');
});
