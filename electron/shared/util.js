'use strict';

const TAG_COLORS = {
  blue: '#0f6cbd',
  red: '#d13438',
  green: '#0b6a0b',
  orange: '#ca5010',
  purple: '#5c2e91',
  yellow: '#986f0b',
  teal: '#038387',
  pink: '#c239b3',
};

const GMAIL_LABEL_COLORS = {
  blue: { backgroundColor: '#4a86e8', textColor: '#ffffff' },
  red: { backgroundColor: '#e66550', textColor: '#ffffff' },
  green: { backgroundColor: '#16a765', textColor: '#ffffff' },
  orange: { backgroundColor: '#ff7537', textColor: '#ffffff' },
  purple: { backgroundColor: '#a479e2', textColor: '#ffffff' },
  yellow: { backgroundColor: '#fad165', textColor: '#000000' },
  teal: { backgroundColor: '#2da2bb', textColor: '#ffffff' },
  pink: { backgroundColor: '#f691b2', textColor: '#000000' },
};

const OUTLOOK_CATEGORY_PRESETS = {
  blue: 'preset7',
  red: 'preset0',
  green: 'preset4',
  orange: 'preset1',
  purple: 'preset8',
  yellow: 'preset3',
  teal: 'preset5',
  pink: 'preset9',
};

const PRESET_HEX = {
  preset0: '#d13438',
  preset1: '#ca5010',
  preset2: '#8e562e',
  preset3: '#986f0b',
  preset4: '#0b6a0b',
  preset5: '#038387',
  preset6: '#5c5a28',
  preset7: '#0f6cbd',
  preset8: '#5c2e91',
  preset9: '#c239b3',
  preset10: '#394146',
  preset11: '#394146',
  preset12: '#69797e',
  preset13: '#5d5a58',
  preset14: '#1b1a19',
  preset15: '#a4262c',
  preset16: '#da3b01',
  preset17: '#6e4b2a',
  preset18: '#8f6b00',
  preset19: '#054b16',
  preset20: '#0a5c5e',
  preset21: '#4d4a12',
  preset22: '#004e8c',
  preset23: '#3b1e6d',
  preset24: '#6b2048',
};

function unique(ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids || []) {
    const value = String(id || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapPool(items, limit, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workers }, run));
  return results;
}

function decodeBase64Url(data) {
  const text = String(data || '');
  if (!text) return Buffer.alloc(0);
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function encodeBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripHtml(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function encodeHeader(value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function parseOneAddress(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const wrapped = value.match(/^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/);
  if (wrapped) {
    return {
      name: String(wrapped[1] || '').trim(),
      email: String(wrapped[2] || '').trim(),
    };
  }
  return { name: '', email: value };
}

function parseAddressList(value) {
  const parts = [];
  let current = '';
  let quoted = false;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === ',' || ch === ';')) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  const people = [];
  const seen = new Set();
  for (const part of parts) {
    const person = parseOneAddress(part);
    if (!person || !person.email || !person.email.includes('@')) continue;
    const key = person.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(person);
  }
  return people;
}

function formatMailbox(person) {
  if (!person || !person.email) return '';
  const name = (person.name || '').trim();
  if (!name) return person.email;
  if (/^[\x20-\x7E]*$/.test(name) && !/[,";<>]/.test(name)) {
    return `${name} <${person.email}>`;
  }
  return `${encodeHeader(name)} <${person.email}>`;
}

function formatAddressList(people) {
  return (people || []).map(formatMailbox).filter(Boolean).join(', ');
}

function wrap76(b64) {
  return String(b64 || '').replace(/.{1,76}/g, '$&\r\n').trim();
}

function odataQuote(value) {
  return String(value || '').replace(/'/g, "''");
}

function zoneWallUtc(instant, timeZone) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const parts = Object.fromEntries(formatted.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  let hour = Number(parts.hour);
  let day = Number(parts.day);
  if (hour === 24) {
    hour = 0;
    day += 1;
  }
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, day, hour, Number(parts.minute), Number(parts.second));
}

function wallClockToUtc(wall, timeZone) {
  const match = String(wall || '').match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    const parsed = new Date(wall);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  const wallUtc = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6] || 0)
  );
  let utc = wallUtc;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const shown = zoneWallUtc(new Date(utc), timeZone);
      const next = utc - (shown - wallUtc);
      if (next === utc) break;
      utc = next;
    }
  } catch {
    return new Date(wallUtc).toISOString();
  }
  return new Date(utc).toISOString();
}

function parseHttpBatch(text, boundary) {
  const marker = `--${String(boundary || '').replace(/^"|"$/g, '')}`;
  if (marker === '--') return [];
  const messages = [];
  for (const piece of String(text || '').split(marker)) {
    const trimmed = piece.replace(/^\r\n/, '');
    if (!trimmed || trimmed.startsWith('--')) continue;
    const blocks = trimmed.split(/\r?\n\r?\n/);
    if (blocks.length < 2) continue;
    const status = Number((blocks[1].match(/HTTP\/\d(?:\.\d)?\s+(\d+)/) || [])[1] || 0);
    const idMatch = blocks[0].match(/content-id:\s*<?(?:response-)?([^>\r\n]+)>?/i);
    const raw = blocks.slice(2).join('\r\n\r\n').replace(/\s+$/, '');
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }
    messages.push({ id: idMatch ? idMatch[1].trim() : '', status, data });
  }
  return messages;
}

function colorKey(value) {
  const key = String(value || 'blue').toLowerCase();
  return Object.prototype.hasOwnProperty.call(TAG_COLORS, key) ? key : 'blue';
}

function apiMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data === 'string') return data || fallback;
  if (data.error_description) return String(data.error_description);
  if (data.error) {
    if (typeof data.error === 'string') return data.error;
    if (data.error.message) return String(data.error.message);
  }
  return fallback;
}

async function requestJson(url, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  let body;
  if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(url, { method: options.method || 'GET', headers, body });
  if (response.status === 204) return null;
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const error = new Error(apiMessage(data, response.statusText || `HTTP ${response.status}`));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

module.exports = {
  TAG_COLORS,
  GMAIL_LABEL_COLORS,
  OUTLOOK_CATEGORY_PRESETS,
  PRESET_HEX,
  unique,
  chunk,
  mapPool,
  decodeBase64Url,
  encodeBase64Url,
  decodeEntities,
  stripHtml,
  encodeHeader,
  parseOneAddress,
  parseAddressList,
  formatMailbox,
  formatAddressList,
  wrap76,
  odataQuote,
  colorKey,
  parseHttpBatch,
  requestJson,
  wallClockToUtc,
};
