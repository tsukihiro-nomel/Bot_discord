const { LIMITS, THEME, clampStr } = require('./ui');

function parseBool(value, defaultValue = null) {
  if (value == null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(normalized)) return true;
  if (['off', 'false', '0', 'no'].includes(normalized)) return false;
  return defaultValue;
}

function parseColor(value, fallback = THEME.colors.neutral) {
  if (value == null || value === '') return fallback;
  const str = String(value).trim();
  if (/^#?[0-9a-f]{6}$/i.test(str)) return parseInt(str.replace('#', ''), 16);
  if (/^0x[0-9a-f]{6}$/i.test(str)) return parseInt(str.slice(2), 16);
  if (/^\d+$/.test(str)) {
    const intVal = parseInt(str, 10);
    if (intVal >= 0 && intVal <= 0xFFFFFF) return intVal;
  }
  return fallback;
}

function parseChannelMention(token) {
  if (!token) return null;
  const match = String(token).trim().match(/^<#(\d+)>$/);
  return match ? match[1] : null;
}

function parseMessageLink(token) {
  if (!token) return null;
  const match = String(token).trim().match(/^https?:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/i);
  if (!match) return null;
  return { guildId: match[1], channelId: match[2], messageId: match[3] };
}

function tokenizeOptions(raw) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      cur += raw[i + 1];
      i += 1;
      continue;
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (cur) out.push(cur), cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function splitSpecAndOptions(rawSpec) {
  const parts = String(rawSpec || '').split(/\n?\|\|/g);
  const specText = (parts.shift() || '').trim();
  const optionsText = parts.map(s => s.trim()).filter(Boolean).join(' ');
  return { specText, optionsText };
}

function parseField(rawField) {
  const [nameRaw = '', valueRaw = '', inlineRaw] = String(rawField).split('::');
  return {
    name: clampStr(nameRaw.trim(), LIMITS.fieldName) || '—',
    value: clampStr(valueRaw.trim(), LIMITS.fieldValue) || '—',
    inline: Boolean(parseBool(inlineRaw, false)),
  };
}

function parseOptions(rawOptions) {
  const opts = { fields: [] };
  if (!rawOptions) return opts;
  const tokens = tokenizeOptions(rawOptions);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token === '--preset' && next) { opts.preset = next; i += 1; }
    else if (token === '--color' && next) { opts.color = next; i += 1; }
    else if (token === '--thumbnail' && next) { opts.thumbnail = next; i += 1; }
    else if (token === '--image' && next) { opts.image = next; i += 1; }
    else if (token === '--footer' && next) { opts.footer = next; i += 1; }
    else if (token === '--timestamp' && next) { opts.timestamp = next; i += 1; }
    else if (token === '--author' && next) { opts.author = next; i += 1; }
    else if (token === '--authorIcon' && next) { opts.authorIcon = next; i += 1; }
    else if (token === '--authorUrl' && next) { opts.authorUrl = next; i += 1; }
    else if (token === '--url' && next) { opts.url = next; i += 1; }
    else if (token === '--field' && next) { opts.fields.push(parseField(next)); i += 1; }
  }
  return opts;
}

function parseEmbedBody(specText) {
  const trimmed = specText.trim();
  const block = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (block) {
    try {
      const parsed = JSON.parse(block[1]);
      return { mode: 'json', data: parsed };
    } catch (err) {
      return { error: 'JSON invalide dans le codeblock.' };
    }
  }

  let escaped = false;
  let pipeIdx = -1;
  for (let i = 0; i < specText.length; i += 1) {
    const ch = specText[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '|') {
      pipeIdx = i;
      break;
    }
  }

  if (pipeIdx === -1) {
    return { mode: 'text', data: { title: '', description: specText.trim() } };
  }

  return {
    mode: 'text',
    data: {
      title: specText.slice(0, pipeIdx).replace(/\\\|/g, '|').trim(),
      description: specText.slice(pipeIdx + 1).replace(/\\\|/g, '|').trim(),
    },
  };
}

function splitDescription(description, limit = LIMITS.description) {
  const text = String(description || '');
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let idx = remaining.lastIndexOf('\n', limit);
    if (idx < Math.floor(limit * 0.6)) idx = limit;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function mergePreset(base, overrides) {
  return {
    ...base,
    ...overrides,
    fields: [...(base.fields || []), ...(overrides.fields || [])],
    author: overrides.author || base.author,
    authorIcon: overrides.authorIcon || base.authorIcon,
    authorUrl: overrides.authorUrl || base.authorUrl,
  };
}

function buildEmbedsFromSpec(rawSpec, { presets = {}, defaultPreset = null } = {}) {
  const { specText, optionsText } = splitSpecAndOptions(rawSpec);
  const options = parseOptions(optionsText);
  const presetName = options.preset || defaultPreset;
  const preset = presetName ? (presets[presetName] || {}) : {};
  const merged = mergePreset(preset, options);

  const parsed = parseEmbedBody(specText);
  if (parsed.error) return { error: parsed.error };

  const src = parsed.data || {};
  const title = clampStr(src.title || '', LIMITS.title);
  const description = String(src.description || '');
  const color = parseColor(src.color ?? merged.color, THEME.colors.neutral);
  const footer = clampStr(src.footer?.text || src.footer || merged.footer || '', LIMITS.footerText);

  const fields = [];
  const fromJsonFields = Array.isArray(src.fields) ? src.fields : [];
  for (const f of [...fromJsonFields, ...(merged.fields || [])]) {
    fields.push({
      name: clampStr(f.name || '', LIMITS.fieldName) || '—',
      value: clampStr(f.value || '', LIMITS.fieldValue) || '—',
      inline: Boolean(parseBool(f.inline, false)),
    });
    if (fields.length >= 25) break;
  }

  const chunks = splitDescription(description, LIMITS.description);
  const embeds = chunks.map((chunk, idx) => {
    const total = chunks.length;
    const item = { color, fields };
    if (title) item.title = total > 1 ? clampStr(`${title} (${idx + 1}/${total})`, LIMITS.title) : title;
    if (chunk) item.description = clampStr(chunk, LIMITS.description);

    const url = src.url || merged.url;
    if (url) item.url = url;

    const image = src.image?.url || src.image || merged.image;
    if (image) item.image = { url: image };

    const thumbnail = src.thumbnail?.url || src.thumbnail || merged.thumbnail;
    if (thumbnail) item.thumbnail = { url: thumbnail };

    const authorName = src.author?.name || src.author || merged.author;
    const authorIcon = src.author?.icon_url || src.author?.iconURL || merged.authorIcon;
    const authorUrl = src.author?.url || merged.authorUrl;
    if (authorName) item.author = { name: clampStr(authorName, 256), icon_url: authorIcon, url: authorUrl };

    if (footer) item.footer = { text: footer };

    const ts = parseBool(src.timestamp ?? merged.timestamp, null);
    if (ts !== false) item.timestamp = new Date().toISOString();

    return item;
  });

  return { embeds, presetName: presetName || null };
}

module.exports = {
  parseBool,
  parseColor,
  parseChannelMention,
  parseMessageLink,
  parseOptions,
  splitDescription,
  buildEmbedsFromSpec,
};
