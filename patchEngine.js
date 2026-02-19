const fs = require('fs');
const crypto = require('crypto');
const { ChannelType, PermissionsBitField } = require('discord.js');

const SNOWFLAKE_RE = /^\d{17,20}$/;

function tokenize(line) {
  const re = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  const out = [];
  let m;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[0]);
  }
  return out;
}

function parseKeyValue(tokens) {
  const named = {};
  const positional = [];
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      named[k] = v;
    } else {
      positional.push(t);
    }
  }
  return { named, positional };
}

function loadOpsMap(opsPath) {
  const map = new Map();
  const raw = fs.readFileSync(opsPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln || ln.startsWith('#')) continue;

    const [left, right] = ln.split('=').map(s => s.trim());
    if (!left || !right) continue;

    const [verb, type] = left.split(':').map(s => s.trim());
    const [handler, paramsRaw] = right.split(':').map(s => s.trim());
    const params = paramsRaw ? paramsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

    map.set(`${verb}:${type}`, { handler, params, line: i + 1 });
  }

  return map;
}

function resolveOp(opsMap, verb, type) {
  const exact = opsMap.get(`${verb}:${type}`);
  if (exact) return exact;

  const wild = opsMap.get(`${verb}:*`);
  if (wild) return wild;

  return null;
}

function parseBool(v) {
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return null;
}

function parseIntSafe(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function parsePermList(listStr) {
  if (!listStr) return [];
  return listStr.split(',').map(s => s.trim()).filter(Boolean);
}

function toOverwriteObject(allowList, denyList) {
  const out = {};
  for (const p of allowList) {
    if (!(p in PermissionsBitField.Flags)) throw new Error(`Permission inconnue (allow): ${p}`);
    out[p] = true;
  }
  for (const p of denyList) {
    if (!(p in PermissionsBitField.Flags)) throw new Error(`Permission inconnue (deny): ${p}`);
    out[p] = false;
  }
  return out;
}

function mapChannelType(ctype) {
  const t = (ctype || '').toLowerCase();
  if (t === 'text') return ChannelType.GuildText;
  if (t === 'voice') return ChannelType.GuildVoice;
  if (t === 'forum') return ChannelType.GuildForum;
  if (t === 'announcement' || t === 'news') return ChannelType.GuildAnnouncement;
  if (t === 'stage') return ChannelType.GuildStageVoice;
  if (t === 'category') return ChannelType.GuildCategory;
  return null;
}

function buildPlanSummary(actions) {
  const counts = {};
  for (const a of actions) {
    counts[a.handler] = (counts[a.handler] || 0) + 1;
  }
  const lines = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `• ${k}: ${v}`);
  return lines.length ? lines.join('\n') : 'Aucune action.';
}

function makeConfirmCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function parsePatchScript(scriptText, opsMap, opts = {}) {
  const { maxActions = 500 } = opts;
  const actions = [];
  const errors = [];
  const warnings = [];
  const lines = scriptText.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const tokens = tokenize(line);
    if (tokens.length < 2) {
      errors.push(`Ligne ${i + 1}: format invalide (verb + type requis)`);
      continue;
    }

    let verb = tokens[0];
    let type = tokens[1];
    let restIndex = 2;

    if (verb.includes(':')) {
      const [v, t] = verb.split(':');
      verb = v;
      type = t || type;
      restIndex = 1;
    }

    const op = resolveOp(opsMap, verb, type);
    if (!op) {
      errors.push(`Ligne ${i + 1}: opération inconnue "${verb}:${type}"`);
      continue;
    }

    const rest = tokens.slice(restIndex);
    const { named, positional } = parseKeyValue(rest);
    const args = {};

    for (const p of op.params) {
      if (p in named) args[p] = named[p];
      else if (positional.length) args[p] = positional.shift();
      else args[p] = '';
    }

    actions.push({ verb, type, handler: op.handler, args, line: i + 1, raw });

    if (actions.length > maxActions) {
      errors.push(`Trop d’actions (> ${maxActions}). Réduis le patch ou augmente PATCH_MAX_ACTIONS.`);
      break;
    }
  }

  return { actions, errors, warnings };
}

async function handlerNoop() {
  return { ok: true, changed: false };
}

async function handlerChannelRename(guild, args, ctx) {
  const id = args.id;
  const name = args.name;
  if (!SNOWFLAKE_RE.test(id)) throw new Error('id invalide');
  if (!name) throw new Error('name vide');
  const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  if (!ch) throw new Error(`salon introuvable: ${id}`);
  await ch.setName(name, { reason: ctx.reason });
  return { ok: true, changed: true, targetId: id };
}

async function handlerChannelMove(guild, args, ctx) {
  const id = args.id;
  const parent = args.parent;
  if (!SNOWFLAKE_RE.test(id)) throw new Error('id invalide');
  const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  if (!ch) throw new Error(`salon introuvable: ${id}`);
  if (parent && parent !== 'none' && !SNOWFLAKE_RE.test(parent)) throw new Error('parent invalide');
  const parentId = (!parent || parent === 'none') ? null : parent;
  await ch.setParent(parentId, { reason: ctx.reason });
  return { ok: true, changed: true, targetId: id };
}

async function handlerChannelTopic(guild, args, ctx) {
  const id = args.id;
  const topic = args.topic ?? '';
  const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  if (!ch) throw new Error(`salon introuvable: ${id}`);
  if (typeof ch.setTopic !== 'function') throw new Error('topic non supporté pour ce type de salon');
  await ch.setTopic(topic, { reason: ctx.reason });
  return { ok: true, changed: true, targetId: id };
}

async function handlerChannelSlowmode(guild, args, ctx) {
  const id = args.id;
  const seconds = parseIntSafe(args.seconds);
  if (seconds === null || seconds < 0) throw new Error('seconds invalide');
  const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  if (!ch) throw new Error(`salon introuvable: ${id}`);
  if (typeof ch.setRateLimitPerUser !== 'function') throw new Error('slowmode non supporté');
  await ch.setRateLimitPerUser(seconds, { reason: ctx.reason });
  return { ok: true, changed: true, targetId: id };
}

async function handlerChannelNsfw(guild, args, ctx) {
  const id = args.id;
  const b = parseBool(args.enabled);
  if (b === null) throw new Error('enabled invalide (true/false)');
  const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  if (!ch) throw new Error(`salon introuvable: ${id}`);
  if (typeof ch.setNSFW !== 'function') throw new Error('NSFW non supporté');
  await ch.setNSFW(b, { reason: ctx.reason });
  return { ok: true, changed: true, targetId: id };
}

async function handlerChannelCreate(guild, args, ctx) {
  const name = args.name;
  const ctype = args.ctype;
  const parent = args.parent;
  if (!name) throw new Error('name vide');
  const typeEnum = mapChannelType(ctype);
  if (typeEnum === null) throw new Error(`ctype invalide: ${ctype} (text/voice/forum/announcement/category/...)`);
  if (parent && parent !== 'none' && !SNOWFLAKE_RE.test(parent)) throw new Error('parent invalide');
  const parentId = (!parent || parent === 'none') ? null : parent;
  const created = await guild.channels.create({ name, type: typeEnum, parent: parentId, reason: ctx.reason });
  return { ok: true, changed: true, targetId: created.id };
}

async function handlerChannelDelete(guild, args, ctx) {
  const id = args.id;
  if (!SNOWFLAKE_RE.test(id)) throw new Error('id invalide');
  const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  if (!ch) throw new Error(`salon introuvable: ${id}`);
  await ch.delete(ctx.reason);
  return { ok: true, changed: true, targetId: id };
}

async function handlerCategoryCreate(guild, args, ctx) {
  const name = args.name;
  if (!name) throw new Error('name vide');
  const created = await guild.channels.create({ name, type: ChannelType.GuildCategory, reason: ctx.reason });
  return { ok: true, changed: true, targetId: created.id };
}

async function handlerRoleRename(guild, args, ctx) {
  const id = args.id;
  const name = args.name;
  if (!SNOWFLAKE_RE.test(id)) throw new Error('id invalide');
  if (!name) throw new Error('name vide');
  const role = guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null);
  if (!role) throw new Error(`rôle introuvable: ${id}`);
  await role.setName(name, ctx.reason);
  return { ok: true, changed: true, targetId: id };
}

async function handlerRoleCreate(guild, args, ctx) {
  const name = args.name;
  if (!name) throw new Error('name vide');
  const color = args.color || null;
  const hoist = parseBool(args.hoist) ?? false;
  const mentionable = parseBool(args.mentionable) ?? false;
  const created = await guild.roles.create({
    name,
    color: color || undefined,
    hoist,
    mentionable,
    reason: ctx.reason,
  });
  return { ok: true, changed: true, targetId: created.id };
}

async function handlerRoleDelete(guild, args, ctx) {
  const id = args.id;
  if (!SNOWFLAKE_RE.test(id)) throw new Error('id invalide');
  const role = guild.roles.cache.get(id) || await guild.roles.fetch(id).catch(() => null);
  if (!role) throw new Error(`rôle introuvable: ${id}`);
  await role.delete(ctx.reason);
  return { ok: true, changed: true, targetId: id };
}

async function handlerPermSet(guild, args, ctx) {
  const channelId = args.channel;
  const roleId = args.role;
  if (!SNOWFLAKE_RE.test(channelId)) throw new Error('channel invalide');
  if (!SNOWFLAKE_RE.test(roleId)) throw new Error('role invalide');
  const ch = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error(`salon introuvable: ${channelId}`);
  const allow = parsePermList(args.allow);
  const deny = parsePermList(args.deny);
  const overwriteObj = toOverwriteObject(allow, deny);
  await ch.permissionOverwrites.edit(roleId, overwriteObj, { reason: ctx.reason });
  return { ok: true, changed: true, targetId: `${channelId}:${roleId}` };
}

async function handlerPermRemove(guild, args, ctx) {
  const channelId = args.channel;
  const roleId = args.role;
  if (!SNOWFLAKE_RE.test(channelId)) throw new Error('channel invalide');
  if (!SNOWFLAKE_RE.test(roleId)) throw new Error('role invalide');
  const ch = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new Error(`salon introuvable: ${channelId}`);
  await ch.permissionOverwrites.delete(roleId, { reason: ctx.reason });
  return { ok: true, changed: true, targetId: `${channelId}:${roleId}` };
}

const HANDLERS = {
  noop: handlerNoop,
  'channel.rename': handlerChannelRename,
  'channel.move': handlerChannelMove,
  'channel.topic': handlerChannelTopic,
  'channel.slowmode': handlerChannelSlowmode,
  'channel.nsfw': handlerChannelNsfw,
  'channel.create': handlerChannelCreate,
  'channel.delete': handlerChannelDelete,
  'category.create': handlerCategoryCreate,
  'role.rename': handlerRoleRename,
  'role.create': handlerRoleCreate,
  'role.delete': handlerRoleDelete,
  'perm.set': handlerPermSet,
  'perm.remove': handlerPermRemove,
};

async function applyActions(guild, actions, ctx) {
  const results = [];
  for (const a of actions) {
    const fn = HANDLERS[a.handler];
    if (!fn) {
      results.push({ ok: false, line: a.line, error: `handler inconnu: ${a.handler}` });
      continue;
    }
    try {
      const r = await fn(guild, a.args, ctx);
      results.push({ ok: true, line: a.line, handler: a.handler, ...r });
    } catch (e) {
      results.push({ ok: false, line: a.line, handler: a.handler, error: e?.message || String(e) });
    }
  }
  return results;
}

function buildTemplateForGuild(guild) {
  const lines = [];
  lines.push('# Sawachi Patch Template');
  lines.push('# Change "keep" to rename/move/topic/perm/... then send with !patch plan');
  lines.push('# ------------------------------------------------------------');
  lines.push('');
  lines.push('# Categories');
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildCategory) {
      lines.push(`keep category ${ch.id} name="${escapeQuotes(ch.name)}"`);
    }
  }
  lines.push('');
  lines.push('# Channels');
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildCategory) continue;
    const parent = ch.parentId ? ch.parentId : 'none';
    const ctype = channelTypeToString(ch.type);
    const topic = typeof ch.topic === 'string' ? ch.topic : '';
    const nsfw = typeof ch.nsfw === 'boolean' ? String(ch.nsfw) : 'false';
    lines.push(`keep channel ${ch.id} name="${escapeQuotes(ch.name)}" ctype=${ctype} parent=${parent} topic="${escapeQuotes(topic)}" nsfw=${nsfw}`);
  }
  lines.push('');
  lines.push('# Roles (excluding @everyone)');
  for (const r of guild.roles.cache.values()) {
    if (r.id === guild.id) continue;
    const color = r.hexColor || '';
    lines.push(`keep role ${r.id} name="${escapeQuotes(r.name)}" color=${color} hoist=${String(r.hoist)} mentionable=${String(r.mentionable)}`);
  }
  lines.push('');
  lines.push('# Permission overwrites (roles only) — WARNING: can be large');
  for (const ch of guild.channels.cache.values()) {
    for (const ow of ch.permissionOverwrites.cache.values()) {
      if (ow.type !== 0) continue;
      const allow = new PermissionsBitField(ow.allow.bitfield);
      const deny = new PermissionsBitField(ow.deny.bitfield);
      const allowNames = allow.toArray().join(',');
      const denyNames = deny.toArray().join(',');
      lines.push(`keep perm:set channel=${ch.id} role=${ow.id} allow=${allowNames} deny=${denyNames}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function channelTypeToString(type) {
  switch (type) {
    case ChannelType.GuildText: return 'text';
    case ChannelType.GuildVoice: return 'voice';
    case ChannelType.GuildForum: return 'forum';
    case ChannelType.GuildAnnouncement: return 'announcement';
    case ChannelType.GuildCategory: return 'category';
    case ChannelType.GuildStageVoice: return 'stage';
    default: return 'text';
  }
}

function escapeQuotes(s) {
  return String(s || '').replace(/"/g, '\\"');
}

module.exports = {
  loadOpsMap,
  parsePatchScript,
  applyActions,
  buildPlanSummary,
  makeConfirmCode,
  buildTemplateForGuild,
};
