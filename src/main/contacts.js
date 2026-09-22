'use strict';
/**
 * Contact storage plus import/export in CSV, JSON and vCard.
 *
 * Contacts are small and few, so the whole list lives in one JSON file that
 * is rewritten atomically on every change.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CSV_COLUMNS = ['name', 'number', 'company', 'email', 'notes', 'accountId'];

/** Digits (plus a leading +) only, for matching numbers to contacts. */
function normalizeNumber(value) {
  const s = String(value || '').trim();
  const plus = s.startsWith('+') ? '+' : '';
  const digits = s.replace(/[^\d]/g, '');
  return plus + digits;
}

/**
 * Two numbers "match" when one ends with the other and the shared tail is
 * long enough to be a real subscriber number — so 5551234 matches
 * +15555551234 but 34 does not match anything.
 */
function numbersMatch(a, b) {
  const x = normalizeNumber(a).replace(/^\+/, '');
  const y = normalizeNumber(b).replace(/^\+/, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = x.length < y.length ? x : y;
  const longer = x.length < y.length ? y : x;
  return shorter.length >= 7 && longer.endsWith(shorter);
}

function sanitize(input, existing = {}) {
  const c = {
    id: existing.id || input.id || crypto.randomUUID(),
    name: String(input.name ?? existing.name ?? '').trim(),
    number: String(input.number ?? existing.number ?? '').trim(),
    company: String(input.company ?? existing.company ?? '').trim(),
    email: String(input.email ?? existing.email ?? '').trim(),
    notes: String(input.notes ?? existing.notes ?? '').trim(),
    accountId: String(input.accountId ?? existing.accountId ?? '').trim(),
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  if (!c.name && !c.number) throw new Error('a contact needs a name or a number');
  if (!c.name) c.name = c.number;
  return c;
}

class ContactStore {
  constructor(dir) {
    this.file = path.join(dir, 'contacts.json');
    this.contacts = [];
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.contacts = Array.isArray(parsed) ? parsed.map((c) => sanitize(c, c)) : [];
    } catch {
      this.contacts = [];
    }
    return this.contacts;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.contacts, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return [...this.contacts].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  get(id) {
    return this.contacts.find((c) => c.id === id) || null;
  }

  add(input) {
    const contact = sanitize(input);
    this.contacts.push(contact);
    this.save();
    return contact;
  }

  update(id, input) {
    const index = this.contacts.findIndex((c) => c.id === id);
    if (index === -1) throw new Error('no such contact');
    this.contacts[index] = sanitize(input, this.contacts[index]);
    this.save();
    return this.contacts[index];
  }

  remove(id) {
    const before = this.contacts.length;
    this.contacts = this.contacts.filter((c) => c.id !== id);
    if (this.contacts.length !== before) this.save();
    return { removed: before - this.contacts.length };
  }

  findByNumber(number) {
    if (!normalizeNumber(number)) return null;
    // Prefer an exact match, then the longest shared tail.
    let best = null;
    for (const c of this.contacts) {
      if (!numbersMatch(c.number, number)) continue;
      if (normalizeNumber(c.number) === normalizeNumber(number)) return c;
      if (!best || c.number.length > best.number.length) best = c;
    }
    return best;
  }

  /**
   * Merge a list of imported contacts. A contact whose number already exists
   * updates that entry rather than duplicating it.
   */
  importMany(items) {
    let added = 0, updated = 0, skipped = 0;
    for (const item of items) {
      let contact;
      try { contact = sanitize(item); } catch { skipped++; continue; }
      const existing = contact.number
        ? this.contacts.find((c) => normalizeNumber(c.number) === normalizeNumber(contact.number))
        : null;
      if (existing) {
        Object.assign(existing, sanitize({ ...existing, ...stripEmpty(contact) }, existing));
        updated++;
      } else {
        this.contacts.push(contact);
        added++;
      }
    }
    if (added || updated) this.save();
    return { added, updated, skipped, total: this.contacts.length };
  }

  // ---- formats ------------------------------------------------------------

  toJSON() {
    return JSON.stringify(this.list().map(({ id, createdAt, updatedAt, ...rest }) => rest), null, 2);
  }

  toCSV() {
    const lines = [CSV_COLUMNS.join(',')];
    for (const c of this.list()) lines.push(CSV_COLUMNS.map((k) => csvCell(c[k])).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  toVCard() {
    return this.list().map((c) => [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${vEscape(c.name)}`,
      `N:${vEscape(c.name)};;;;`,
      c.number ? `TEL;TYPE=VOICE:${vEscape(c.number)}` : null,
      c.company ? `ORG:${vEscape(c.company)}` : null,
      c.email ? `EMAIL:${vEscape(c.email)}` : null,
      c.notes ? `NOTE:${vEscape(c.notes)}` : null,
      'END:VCARD',
    ].filter(Boolean).join('\r\n')).join('\r\n') + '\r\n';
  }

  /** Parse any supported format; the format is sniffed from the content. */
  static parse(text, hint = '') {
    const body = String(text || '').replace(/^\uFEFF/, '');
    const lower = hint.toLowerCase();
    if (lower.endsWith('.json') || /^\s*[[{]/.test(body)) return parseJSON(body);
    if (lower.endsWith('.vcf') || /^\s*BEGIN:VCARD/im.test(body)) return parseVCard(body);
    return parseCSV(body);
  }
}

function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) out[k] = v;
  return out;
}

// ---- CSV ---------------------------------------------------------------------

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 parser that also tolerates semicolon-separated exports. */
function parseCSVRows(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  const sep = detectSeparator(text);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

function detectSeparator(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

// Header aliases so exports from other phones and PBXs map onto our fields.
const HEADER_ALIASES = {
  name: ['name', 'full name', 'fullname', 'display name', 'displayname', 'contact', 'fn'],
  number: ['number', 'phone', 'phone number', 'telephone', 'tel', 'mobile', 'extension', 'ext', 'primary phone', 'phone 1 - value', 'mobile phone', 'business phone', 'work phone'],
  company: ['company', 'organization', 'organisation', 'org'],
  email: ['email', 'e-mail', 'email address', 'e-mail address', 'e-mail 1 - value'],
  notes: ['notes', 'note', 'comment', 'comments'],
  accountId: ['accountid', 'account', 'line'],
};

function mapHeader(header) {
  const h = String(header || '').trim().toLowerCase();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(h)) return field;
  }
  return null;
}

function parseCSV(text) {
  const rows = parseCSVRows(text);
  if (!rows.length) return [];

  const header = rows[0].map(mapHeader);
  const hasHeader = header.some(Boolean);
  if (!hasHeader) {
    // Headerless: assume "name, number" (or "number" alone).
    return rows.map((r) => (r.length === 1 ? { number: r[0] } : { name: r[0], number: r[1] }));
  }

  // Some exports have several phone columns; the first non-empty one wins,
  // and a "First Name"/"Last Name" pair is joined.
  const first = rows[0].findIndex((h) => /^first\s*name$/i.test(h.trim()));
  const last = rows[0].findIndex((h) => /^last\s*name$/i.test(h.trim()));

  return rows.slice(1).map((r) => {
    const out = {};
    header.forEach((field, i) => {
      if (!field) return;
      const value = (r[i] || '').trim();
      if (!value) return;
      if (out[field] === undefined) out[field] = value;
    });
    if (!out.name && (first !== -1 || last !== -1)) {
      out.name = [r[first], r[last]].filter(Boolean).join(' ').trim();
    }
    return out;
  }).filter((c) => c.name || c.number);
}

// ---- JSON ----------------------------------------------------------------------

function parseJSON(text) {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.contacts) ? parsed.contacts : [];
  return list.map((c) => ({
    name: c.name ?? c.displayName ?? c.fullName,
    number: c.number ?? c.phone ?? c.tel,
    company: c.company ?? c.organization,
    email: c.email,
    notes: c.notes,
    accountId: c.accountId,
  }));
}

// ---- vCard -----------------------------------------------------------------------

function vEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => '\\' + m);
}

function vUnescape(s) {
  return String(s).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function parseVCard(text) {
  // Unfold continuation lines (RFC 6350 §3.2).
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const cards = unfolded.split(/END:VCARD/i);
  const out = [];

  for (const card of cards) {
    if (!/BEGIN:VCARD/i.test(card)) continue;
    const c = {};
    for (const rawLine of card.split(/\r?\n/)) {
      const line = rawLine.trim();
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const [prop] = line.slice(0, colon).split(';');
      const value = vUnescape(line.slice(colon + 1));
      switch (prop.toUpperCase().replace(/^ITEM\d+\./, '')) {
        case 'FN': if (!c.name) c.name = value; break;
        case 'N': {
          if (!c.name) {
            const parts = value.split(';');
            c.name = [parts[1], parts[0]].filter(Boolean).join(' ').trim();
          }
          break;
        }
        case 'TEL': if (!c.number) c.number = value.replace(/^tel:/i, ''); break;
        case 'ORG': if (!c.company) c.company = value.split(';')[0]; break;
        case 'EMAIL': if (!c.email) c.email = value; break;
        case 'NOTE': if (!c.notes) c.notes = value; break;
        default: break;
      }
    }
    if (c.name || c.number) out.push(c);
  }
  return out;
}

module.exports = { ContactStore, normalizeNumber, numbersMatch, parseCSV, parseVCard, parseJSON, CSV_COLUMNS };
