const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');

const PATCH_PLAN_TTL_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 200;

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function httpError(status, code, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function applyVariables(text, variables) {
  return String(text || '').replace(/\{([a-z0-9_]+)\}/gi, (_match, key) => {
    const value = variables[String(key).toLowerCase()];
    return value == null ? '' : String(value);
  });
}

function parseJsonMaybe(value, fallback = value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

function parseBooleanMaybe(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeAnnouncementPayload(body) {
  const payload = typeof body?.payload === 'string'
    ? { ...body, ...parseJsonMaybe(body.payload, {}) }
    : { ...(body || {}) };

  delete payload.payload;
  payload.embedSpec = parseJsonMaybe(payload.embedSpec, payload.embedSpec);
  payload.templateVariables = parseJsonMaybe(payload.templateVariables, payload.templateVariables);
  payload.allowedRoleIds = parseJsonMaybe(payload.allowedRoleIds, payload.allowedRoleIds);
  payload.allowedUserIds = parseJsonMaybe(payload.allowedUserIds, payload.allowedUserIds);
  if ('suppressMentions' in payload) {
    payload.suppressMentions = parseBooleanMaybe(payload.suppressMentions, true);
  }
  return payload;
}

function getVariables({ guild, channel, payload }) {
  const provided = Object.fromEntries(
    Object.entries(payload.templateVariables || {}).map(([key, value]) => [String(key).toLowerCase(), value]),
  );
  return {
    server: guild.name,
    guild: guild.name,
    guildid: guild.id,
    channel: channel?.name || '',
    channelid: channel?.id || '',
    user: provided.user || guild.client.user?.username || 'Sawahiro API',
    date: new Date().toLocaleDateString('fr-FR'),
    datetime: new Date().toLocaleString('fr-FR'),
    ...provided,
  };
}

function safeConfig(guildCfg) {
  return {
    modules: cloneJson(guildCfg.modules || {}),
    featureToggles: cloneJson(guildCfg.featureToggles || {}),
    roleLevels: cloneJson(guildCfg.roleLevels || {}),
  };
}

function safeAllowedMentions(guild, payload) {
  if (payload.suppressMentions !== false) return { parse: [] };
  const roles = Array.isArray(payload.allowedRoleIds)
    ? payload.allowedRoleIds.filter((roleId) => guild.roles.cache.has(roleId))
    : [];
  const users = Array.isArray(payload.allowedUserIds)
    ? payload.allowedUserIds.filter((userId) => /^\d{17,20}$/.test(String(userId)))
    : [];
  return { parse: [], roles, users };
}

function normalizeRole(role, guildCfg) {
  return {
    id: role.id,
    name: role.name,
    color: role.hexColor,
    position: role.position,
    hoist: role.hoist,
    mentionable: role.mentionable,
    managed: role.managed,
    level: guildCfg.roleLevels?.[role.id] ?? 0,
    permissions: role.permissions.toArray(),
  };
}

function normalizeChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId || null,
    position: channel.position,
    topic: typeof channel.topic === 'string' ? channel.topic : null,
    nsfw: Boolean(channel.nsfw),
    slowmode: typeof channel.rateLimitPerUser === 'number' ? channel.rateLimitPerUser : 0,
  };
}

function writeAudit(auditPath, payload) {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, 'utf8');
}

function writeSnapshot(dataDir, guildId, label, snapshot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(dataDir, 'api-snapshots', guildId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${stamp}-${label}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  return filePath;
}

function remember(store, entry) {
  store.history.unshift(entry);
  if (store.history.length > HISTORY_LIMIT) store.history.length = HISTORY_LIMIT;
}

function buildAnnouncement({ guild, channel, guildCfg, payload, files, buildEmbedsFromSpec }) {
  const content = typeof payload.content === 'string' ? payload.content : '';
  const mode = payload.mode || (payload.templateName ? 'template' : payload.embedSpec || payload.specText ? 'embedSpec' : 'plain');
  const variables = getVariables({ guild, channel, payload });
  let embeds = [];
  let presetName = null;

  if (mode === 'template') {
    const name = String(payload.templateName || '').toLowerCase();
    const template = guildCfg.modules.templates.items?.[name];
    if (!template) throw httpError(404, 'TEMPLATE_NOT_FOUND', `Template introuvable: ${name}`);
    embeds = [{
      color: 0x40449b,
      title: applyVariables(template.title || '', variables),
      description: applyVariables(template.content || '', variables),
      footer: { text: `${guild.name} • ${new Date().toLocaleDateString('fr-FR')}` },
      timestamp: new Date().toISOString(),
    }];
    presetName = name;
  } else if (mode === 'embedSpec') {
    const parsedEmbedSpec = parseJsonMaybe(payload.embedSpec, payload.embedSpec);
    if (typeof parsedEmbedSpec === 'object' && parsedEmbedSpec) {
      embeds = Array.isArray(payload.embedSpec)
        ? parsedEmbedSpec
        : Array.isArray(parsedEmbedSpec.embeds)
          ? parsedEmbedSpec.embeds
          : [parsedEmbedSpec];
    } else {
      const rawSpec = String(payload.specText || parsedEmbedSpec || '');
      const built = buildEmbedsFromSpec(rawSpec, {
        presets: guildCfg.modules.embeds?.presets || {},
        defaultPreset: guildCfg.modules.embeds?.defaultPreset || null,
      });
      if (built.error) throw httpError(400, 'INVALID_EMBED_SPEC', built.error);
      embeds = built.embeds;
      presetName = built.presetName;
    }
  }

  return {
    sendable: {
      content,
      embeds,
      allowedMentions: safeAllowedMentions(guild, payload),
    },
    preview: {
      mode,
      content,
      embeds: cloneJson(embeds),
      templateName: presetName,
      files: (files || []).map((file) => ({
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      })),
    },
  };
}

function startBotApiServer(options) {
  const jobsPath = path.join(options.dataDir, 'api-jobs.json');
  const auditPath = path.join(options.dataDir, 'api-audit.log');
  const jobs = loadJson(jobsPath, { publishes: {}, history: [] });
  const patchPlans = new Map();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 5 } });
  const host = process.env.BOT_API_HOST || '0.0.0.0';
  const port = Number.parseInt(process.env.BOT_API_PORT || process.env.PORT || '3000', 10);
  const healthPath = options.healthPath || process.env.HEALTH_PATH || '/health';
  const app = express();

  const apiEnabled = () => String(process.env.BOT_API_ENABLED || 'false').toLowerCase() === 'true';
  const apiToken = () => process.env.BOT_API_TOKEN || '';

  async function fetchGuild(guildId) {
    const guild = options.client.guilds.cache.get(guildId) || await options.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw httpError(404, 'GUILD_NOT_FOUND', `Serveur introuvable: ${guildId}`);
    return guild;
  }

  async function fetchTextChannel(guild, channelId) {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) throw httpError(404, 'CHANNEL_NOT_FOUND', `Salon introuvable: ${channelId}`);
    if (!channel.isTextBased()) throw httpError(400, 'CHANNEL_NOT_TEXT', 'Le salon cible doit accepter des messages.');
    return channel;
  }

  function audit(req, payload) {
    writeAudit(auditPath, { method: req.method, path: req.originalUrl, ip: req.ip, ...payload });
  }

  function requireApi(req, _res, next) {
    if (!apiEnabled()) return next(httpError(503, 'API_DISABLED', 'BOT_API_ENABLED doit etre active.'));
    if (!apiToken() || req.headers['x-bot-admin-token'] !== apiToken()) {
      return next(httpError(401, 'UNAUTHORIZED', 'Token API invalide.'));
    }
    next();
  }

  app.disable('x-powered-by');
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-admin-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get(healthPath, (_req, res) => res.json({ ok: true, apiEnabled: apiEnabled(), ready: options.client.isReady(), uptimeMs: options.client.uptime || 0 }));
  app.use('/api/v1', requireApi);

  app.get('/api/v1/guilds', asyncRoute(async (req, res) => {
    const items = options.client.guilds.cache.map((guild) => ({ id: guild.id, name: guild.name, memberCount: guild.memberCount, iconUrl: guild.iconURL() }));
    audit(req, { outcome: 'success', kind: 'guilds.list', count: items.length });
    res.json({ items });
  }));

  app.get('/api/v1/jobs', asyncRoute(async (_req, res) => {
    res.json({
      publishes: Object.values(jobs.publishes || {}).slice(-25).reverse(),
      history: jobs.history || [],
      patchPlans: Array.from(patchPlans.entries()).map(([planId, plan]) => ({ planId, guildId: plan.guildId, createdAt: plan.createdAt, hasDeletes: plan.hasDeletes, summary: plan.summary })),
    });
  }));

  app.get('/api/v1/guilds/:guildId/meta', asyncRoute(async (_req, res) => {
    const guild = await fetchGuild(_req.params.guildId);
    const guildCfg = options.ensureGuildConfig(guild.id);
    res.json({ id: guild.id, name: guild.name, memberCount: guild.memberCount, featureToggles: cloneJson(guildCfg.featureToggles) });
  }));

  app.get('/api/v1/guilds/:guildId/config', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    res.json({ guildId: guild.id, config: safeConfig(options.ensureGuildConfig(guild.id)) });
  }));

  app.get('/api/v1/guilds/:guildId/roles', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const guildCfg = options.ensureGuildConfig(guild.id);
    res.json({ items: guild.roles.cache.sort((left, right) => right.position - left.position).map((role) => normalizeRole(role, guildCfg)) });
  }));

  app.get('/api/v1/guilds/:guildId/channels', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    res.json({ items: guild.channels.cache.sort((left, right) => left.rawPosition - right.rawPosition).map(normalizeChannel) });
  }));

  app.get('/api/v1/guilds/:guildId/modules', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const guildCfg = options.ensureGuildConfig(guild.id);
    res.json({ featureToggles: cloneJson(guildCfg.featureToggles), modules: cloneJson(guildCfg.modules) });
  }));

  app.put('/api/v1/guilds/:guildId/modules/:module', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const guildCfg = options.ensureGuildConfig(guild.id);
    const moduleName = req.params.module;
    if (!(moduleName in guildCfg.featureToggles)) throw httpError(404, 'MODULE_NOT_FOUND', `Module inconnu: ${moduleName}`);
    if ('enabled' in req.body) guildCfg.featureToggles[moduleName] = parseBooleanMaybe(req.body.enabled, guildCfg.featureToggles[moduleName]);
    const moduleConfig = parseJsonMaybe(req.body.config, req.body.config);
    if (moduleConfig && typeof moduleConfig === 'object') {
      guildCfg.modules[moduleName] = { ...(guildCfg.modules[moduleName] || {}), ...moduleConfig };
    }
    options.persist();
    audit(req, { outcome: 'success', kind: 'module.update', guildId: guild.id, module: moduleName });
    res.json({ featureToggle: guildCfg.featureToggles[moduleName], config: cloneJson(guildCfg.modules[moduleName] || {}) });
  }));

  app.get('/api/v1/guilds/:guildId/templates', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const guildCfg = options.ensureGuildConfig(guild.id);
    res.json({ templates: cloneJson(guildCfg.modules.templates.items || {}), presets: cloneJson(guildCfg.modules.embeds?.presets || {}), defaultPreset: guildCfg.modules.embeds?.defaultPreset || null });
  }));

  app.put('/api/v1/guilds/:guildId/templates/:name', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const guildCfg = options.ensureGuildConfig(guild.id);
    const name = String(req.params.name || '').toLowerCase();
    guildCfg.modules.templates.enabled = true;
    guildCfg.modules.templates.items[name] = { title: String(req.body.title || ''), content: String(req.body.content || '') };
    options.persist();
    res.json({ name, item: cloneJson(guildCfg.modules.templates.items[name]) });
  }));

  app.delete('/api/v1/guilds/:guildId/templates/:name', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const guildCfg = options.ensureGuildConfig(guild.id);
    delete guildCfg.modules.templates.items[String(req.params.name || '').toLowerCase()];
    options.persist();
    res.json({ ok: true });
  }));

  app.get('/api/v1/guilds/:guildId/rules', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    res.json({ rules: cloneJson(options.ensureGuildConfig(guild.id).modules.rules) });
  }));

  app.put('/api/v1/guilds/:guildId/rules', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const rulesCfg = options.ensureGuildConfig(guild.id).modules.rules;
    rulesCfg.enabled = req.body.enabled !== false;
    rulesCfg.title = String(req.body.title || rulesCfg.title || 'Regles');
    rulesCfg.content = String(req.body.content || rulesCfg.content || '');
    options.persist();
    res.json({ rules: cloneJson(rulesCfg) });
  }));

  app.post('/api/v1/guilds/:guildId/rules/post', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const channel = await fetchTextChannel(guild, String(req.body.channelId || ''));
    const rulesCfg = options.ensureGuildConfig(guild.id).modules.rules;
    const message = await channel.send({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(rulesCfg.title || 'Regles').setDescription(rulesCfg.content || '')] });
    res.json({ messageId: message.id, channelId: channel.id, jumpUrl: message.url });
  }));

  app.get('/api/v1/guilds/:guildId/welcome', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    res.json({ welcome: cloneJson(options.ensureGuildConfig(guild.id).modules.welcome) });
  }));

  app.put('/api/v1/guilds/:guildId/welcome', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const welcomeCfg = options.ensureGuildConfig(guild.id).modules.welcome;
    if ('enabled' in req.body) welcomeCfg.enabled = Boolean(req.body.enabled);
    if ('channelId' in req.body) welcomeCfg.channelId = req.body.channelId || null;
    if ('message' in req.body) welcomeCfg.message = String(req.body.message || '');
    options.persist();
    res.json({ welcome: cloneJson(welcomeCfg) });
  }));

  app.post('/api/v1/guilds/:guildId/welcome/test', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const memberId = String(req.body.memberId || guild.members.me?.id || '');
    const member = memberId ? await guild.members.fetch(memberId).catch(() => null) : null;
    if (!member) throw httpError(404, 'MEMBER_NOT_FOUND', 'Impossible de charger le membre de test.');
    await options.handleGuildMemberAdd(member);
    res.json({ ok: true, memberId });
  }));

  app.get('/api/v1/guilds/:guildId/tickets', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    res.json({ config: cloneJson(options.ensureGuildConfig(guild.id).modules.tickets), state: cloneJson(options.getState()[guild.id]?.tickets || {}) });
  }));

  app.put('/api/v1/guilds/:guildId/tickets', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    Object.assign(options.ensureGuildConfig(guild.id).modules.tickets, req.body || {});
    options.persist();
    res.json({ tickets: cloneJson(options.ensureGuildConfig(guild.id).modules.tickets) });
  }));

  app.post('/api/v1/guilds/:guildId/tickets/panel/publish', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const ticketsCfg = options.ensureGuildConfig(guild.id).modules.tickets;
    const channel = await fetchTextChannel(guild, String(req.body.channelId || ticketsCfg.panelChannelId || ''));
    const message = await channel.send({ embeds: [options.buildTicketPanelEmbed(guild)], components: options.buildTicketPanelComponents() });
    ticketsCfg.panelMessageId = message.id;
    ticketsCfg.panelChannelId = channel.id;
    options.persist();
    res.json({ messageId: message.id, channelId: channel.id, jumpUrl: message.url });
  }));

  app.get('/api/v1/guilds/:guildId/snapshot', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    res.json({ snapshot: options.exportServerStructure(guild) });
  }));

  app.post('/api/v1/guilds/:guildId/import/dry-run', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const summary = await options.importServerStructure(guild, req.body.structure, { ...(req.body.options || {}), dryRun: true });
    res.json({ summary });
  }));

  app.post('/api/v1/guilds/:guildId/import/apply', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const backupPath = writeSnapshot(options.dataDir, guild.id, 'before-import', options.exportServerStructure(guild));
    const summary = await options.importServerStructure(guild, req.body.structure, { ...(req.body.options || {}), dryRun: false });
    res.json({ summary, backupPath });
  }));

  app.post('/api/v1/guilds/:guildId/patch/plan', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const parsed = options.parsePatchScript(String(req.body.script || ''), options.getOpsMap(), { maxActions: options.patchMaxActions });
    if (parsed.errors.length) throw httpError(400, 'PATCH_INVALID', 'Le patch contient des erreurs.', parsed.errors);
    const hasDeletes = parsed.actions.some((action) => action.handler === 'channel.delete' || action.handler === 'role.delete');
    const planId = crypto.randomUUID();
    patchPlans.set(planId, { guildId: guild.id, createdAt: Date.now(), confirmCode: options.makeConfirmCode(), actions: parsed.actions, hasDeletes, summary: options.buildPlanSummary(parsed.actions) });
    res.json({ planId, confirmCode: patchPlans.get(planId).confirmCode, hasDeletes, summary: patchPlans.get(planId).summary, actions: parsed.actions, warnings: parsed.warnings });
  }));

  app.post('/api/v1/guilds/:guildId/patch/apply', asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const plan = patchPlans.get(String(req.body.planId || ''));
    if (!plan || plan.guildId !== guild.id) throw httpError(404, 'PATCH_PLAN_NOT_FOUND', 'Plan de patch introuvable.');
    if (Date.now() - plan.createdAt > PATCH_PLAN_TTL_MS) {
      patchPlans.delete(String(req.body.planId || ''));
      throw httpError(410, 'PATCH_PLAN_EXPIRED', 'Le plan de patch a expire.');
    }
    if (String(req.body.confirmCode || '').toUpperCase() !== plan.confirmCode) throw httpError(400, 'PATCH_CONFIRM_INVALID', 'Code de confirmation invalide.');
    if (plan.hasDeletes && !req.body.allowDeletes) throw httpError(400, 'PATCH_DELETES_BLOCKED', 'Ce patch contient des suppressions.');
    const backupPath = writeSnapshot(options.dataDir, guild.id, 'before-patch', options.exportServerStructure(guild));
    const results = await options.applyActions(guild, plan.actions, { reason: `API patch apply ${req.body.planId}` });
    patchPlans.delete(String(req.body.planId || ''));
    res.json({ results, backupPath });
  }));

  app.post('/api/v1/guilds/:guildId/patch/cancel', asyncRoute(async (req, res) => {
    res.json({ ok: patchPlans.delete(String(req.body.planId || '')) });
  }));

  app.post('/api/v1/guilds/:guildId/announcements/preview', upload.any(), asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const guildCfg = options.ensureGuildConfig(guild.id);
    const payload = normalizeAnnouncementPayload(req.body);
    const channel = payload.channelId ? await fetchTextChannel(guild, String(payload.channelId)) : null;
    const built = buildAnnouncement({ guild, channel, guildCfg, payload, files: req.files, buildEmbedsFromSpec: options.buildEmbedsFromSpec });
    audit(req, { outcome: 'success', kind: 'announcement.preview', guildId: guild.id, channelId: channel?.id || null });
    res.json(built.preview);
  }));

  app.post('/api/v1/guilds/:guildId/announcements/publish', upload.any(), asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const guildCfg = options.ensureGuildConfig(guild.id);
    const payload = normalizeAnnouncementPayload(req.body);
    const channel = await fetchTextChannel(guild, String(payload.channelId || ''));
    const key = String(payload.idempotencyKey || '').trim();
    const storeKey = `${guild.id}:${key}`;
    if (key && jobs.publishes[storeKey]) return res.json({ ...jobs.publishes[storeKey], reused: true });
    const built = buildAnnouncement({ guild, channel, guildCfg, payload, files: req.files, buildEmbedsFromSpec: options.buildEmbedsFromSpec });
    const files = (req.files || []).map((file) => new AttachmentBuilder(file.buffer, { name: file.originalname }));
    const message = await channel.send({ ...built.sendable, files });
    const result = { messageId: message.id, channelId: channel.id, guildId: guild.id, jumpUrl: message.url, publishedAt: new Date(message.createdTimestamp).toISOString() };
    if (key) jobs.publishes[storeKey] = result;
    remember(jobs, { kind: 'publish', guildId: guild.id, channelId: channel.id, messageId: message.id, createdAt: Date.now() });
    saveJson(jobsPath, jobs);
    audit(req, { outcome: 'success', kind: 'announcement.publish', guildId: guild.id, channelId: channel.id, messageId: message.id });
    res.json(result);
  }));

  app.post('/api/v1/guilds/:guildId/messages/test', upload.any(), asyncRoute(async (req, res) => {
    const guild = await fetchGuild(req.params.guildId);
    const guildCfg = options.ensureGuildConfig(guild.id);
    const payload = normalizeAnnouncementPayload(req.body);
    const channel = await fetchTextChannel(guild, String(payload.channelId || ''));
    const built = buildAnnouncement({ guild, channel, guildCfg, payload, files: req.files, buildEmbedsFromSpec: options.buildEmbedsFromSpec });
    const files = (req.files || []).map((file) => new AttachmentBuilder(file.buffer, { name: file.originalname }));
    const message = await channel.send({ ...built.sendable, files });
    res.json({ messageId: message.id, channelId: channel.id, guildId: guild.id, jumpUrl: message.url, publishedAt: new Date(message.createdTimestamp).toISOString() });
  }));

  app.use((error, req, res, _next) => {
    const status = error.status || 500;
    audit(req, { outcome: 'error', status, code: error.code || 'INTERNAL_ERROR', message: error.message || 'Erreur interne.' });
    res.status(status).json({ error: { code: error.code || 'INTERNAL_ERROR', message: error.message || 'Erreur interne.', details: error.details || null } });
  });

  const server = app.listen(Number.isFinite(port) ? port : 3000, host, () => {
    console.log(`[api] listening on ${host}:${Number.isFinite(port) ? port : 3000} (${healthPath})`);
  });

  return { app, server };
}

module.exports = {
  startBotApiServer,
  _internal: {
    applyVariables,
    normalizeAnnouncementPayload,
    safeConfig,
    safeAllowedMentions,
    buildAnnouncement,
  },
};
