const fs = require('fs');
const path = require('path');

// Import Discord.js v14 components.  This bot makes heavy use of structured
// messages such as embeds and attachments to display rich content in the
// chat.  These classes provide the necessary builders and flags.  See
// https://discord.js.org/#/docs/discord.js/main/general/welcome for more
// information about the API surface.
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { THEME, buildEmbed, clampStr } = require('./ui');
const { parseCommandContent } = require('./commandParser');
const {
  parseChannelMention,
  parseMessageLink,
  parseBool,
  parseOptions,
  buildEmbedsFromSpec,
} = require('./embedKit');
const {
  loadOpsMap,
  parsePatchScript,
  applyActions,
  buildPlanSummary,
  makeConfirmCode,
  buildTemplateForGuild,
} = require('./patchEngine');
const slashCommandDefs = require('./slashCommands');

// ------------------------------------------------------------
// Render compatibility: tiny HTTP server for health checks
// ------------------------------------------------------------
// On Render's Free Web Service, the instance spins down after ~15 minutes
// without inbound HTTP traffic. A Discord bot maintains an outbound gateway
// connection, but that doesn't count as inbound web traffic. Exposing a small
// HTTP endpoint lets you ping it (e.g., with UptimeRobot) so the service stays
// awake and your bot remains connected.
//
// Ping: https://<your-service>.onrender.com/health
// You can change the path with HEALTH_PATH.
const http = require('http');
const RENDER_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HEALTH_PATH = process.env.HEALTH_PATH || '/health';
const POLL_INTERVAL_MS = (() => {
  const raw = process.env.POLL_INTERVAL_MS;
  const parsed = raw ? parseInt(raw, 10) : 5 * 60 * 1000;
  if (Number.isNaN(parsed) || parsed < 60_000) return 5 * 60 * 1000;
  return parsed;
})();
const botStartedAt = Date.now();

const healthServer = http.createServer((req, res) => {
  if (!req || !req.url) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (req.url === HEALTH_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  return res.end('running');
});

healthServer.listen(RENDER_PORT, '0.0.0.0', () => {
  console.log(`[health] listening on 0.0.0.0:${RENDER_PORT} (${HEALTH_PATH})`);
});


/*
 * Ultra Discord Bot
 *
 * This file implements a feature‑rich Discord bot designed to manage and
 * moderate community servers.  It goes far beyond the basic implementation
 * provided in the starter template.  Key capabilities include:
 *  - YouTube and Twitch notifications for multiple channels/streamers per
 *    guild with anti‑spam logic and first‑install modes.
 *  - Exporting and importing complete server structures with dry runs and
 *    prefixing support.
 *  - Role based permission levels with per‑command requirements.
 *  - Configurable templates, welcome messages, rules embeds and backups.
 *  - A dynamic help system that lists commands relevant to the current
 *    configuration and the caller’s permission level.
 *  - Feature toggles to enable or disable modules on a per‑server basis.
 *  - Comprehensive logging and health status reporting.
 *
 * This bot uses a pair of JSON files to persist its configuration and
 * runtime state.  The configuration file (config.json) stores server
 * specific settings (such as watched channels, enabled modules, role levels,
 * logs channel identifiers, backup schedules, templates, welcome and rules
 * messages, and feature toggles).  The state file (state.json) records
 * transient data such as the last video ID seen on each watched YouTube
 * channel and whether a Twitch streamer is currently live.  Both files live
 * in a data directory that can be configured via the DATA_DIR environment
 * variable.  When running on Fly.io or similar container platforms you
 * should mount a persistent volume at this location.
 */

// Determine where to store persistent files.  By default the working
// directory of this script is used.  When running in production you should
// specify DATA_DIR to a writable location.  The directory and files will
// be created lazily if they do not exist.
const dataDir = process.env.DATA_DIR || __dirname;

const configPaths = {
  config: path.join(dataDir, 'config.json'),
  state: path.join(dataDir, 'state.json'),
};

const OPS_PATH = path.join(__dirname, 'ops.map');
let opsMap = loadOpsMap(OPS_PATH);

const SAWA_GUILD_ID = '1118826910437347348';
const SAWA_LOGS_CHANNEL_ID = '1474092653325979678';
const SAWA_SUPPORT_ALERT_CHANNEL_ID = '1483876875544694903';
const SAWA_TICKET_DEFAULTS = {
  enabled: true,
  panelChannelId: '1119946805522731061',
  panelMessageId: null,
  openCategoryId: '1119944142492012544',
  closedCategoryId: '1483878040974000292',
  transcriptsChannelId: '1483878205030006835',
  logsChannelId: SAWA_LOGS_CHANNEL_ID,
  creatorRoleId: null,
  verifiedRoleId: '1119269512882176125',
  openCooldownMs: 60_000,
  maxOpenPerUser: 2,
  dmOnOpen: true,
  dmTranscript: true,
};
const SAWA_ADMIN_ROLE_IDS = [
  '1328310491038351471',
  '1328310384007970888',
  '1119267312780967966',
  '1118835561868824637',
  '1118834640296349696',
];
const SAWA_TICKET_TYPES = {
  'sawa-support': {
    label: '🐾 Support',
    emoji: '🐾',
    description: 'Aide technique, question ou souci sur le serveur.',
    pingRoles: ['1328310491038351471'],
    adminRoles: SAWA_ADMIN_ROLE_IDS,
    questions: [
      { id: 'q_support_subject', label: 'Probleme resume', style: TextInputStyle.Short, required: true, placeholder: 'Probleme (resume)' },
      { id: 'q_support_details', label: 'Explique ce qui se passe', style: TextInputStyle.Paragraph, required: true, placeholder: 'Explique ce qui se passe' },
      { id: 'q_support_links', label: 'Lien ou capture', style: TextInputStyle.Short, required: false, placeholder: 'Lien / capture (si besoin)' },
    ],
  },
  'sawa-report': {
    label: '🚨 Signalement',
    emoji: '🚨',
    description: 'Signaler un membre, un message ou une situation.',
    pingRoles: ['1119267312780967966'],
    adminRoles: ['1119267312780967966', '1119267076960432209', '1118835561868824637', '1118834640296349696'],
    questions: [
      { id: 'q_report_who', label: 'Qui est concerne', style: TextInputStyle.Short, required: true, placeholder: 'Pseudo + ID' },
      { id: 'q_report_what', label: 'Que sest il passe', style: TextInputStyle.Paragraph, required: true, placeholder: 'Decris les faits' },
      { id: 'q_report_proof', label: 'Preuve', style: TextInputStyle.Short, required: false, placeholder: 'Lien / capture' },
    ],
  },
  'sawa-collab': {
    label: '🤝 Collab',
    emoji: '🤝',
    description: 'Proposer une collaboration ou un projet commun.',
    pingRoles: ['1328310384007970888'],
    adminRoles: ['1328310384007970888', '1119267989083148298', '1119267472353284299', '1118835561868824637', '1118834640296349696'],
    requiresVerified: true,
    questions: [
      { id: 'q_collab_platform', label: 'Plateforme et lien', style: TextInputStyle.Short, required: true, placeholder: 'Twitch / YT / autre + lien' },
      { id: 'q_collab_idea', label: 'Idee de collab', style: TextInputStyle.Paragraph, required: true, placeholder: 'Lidee de collab' },
      { id: 'q_collab_avail', label: 'Disponibilites', style: TextInputStyle.Short, required: false, placeholder: 'Dispos' },
    ],
  },
  'sawa-staff': {
    label: '🧸 Staff',
    emoji: '🧸',
    description: 'Candidature staff pour aider le serveur au quotidien.',
    pingRoles: ['1328310384007970888'],
    adminRoles: ['1328310384007970888', '1118835561868824637', '1118834640296349696'],
    requiresVerified: true,
    questions: [
      { id: 'q_staff_motive', label: 'Pourquoi toi', style: TextInputStyle.Paragraph, required: true, placeholder: 'Pourquoi toi ?' },
      { id: 'q_staff_exp', label: 'Experience', style: TextInputStyle.Paragraph, required: false, placeholder: 'Experience' },
      { id: 'q_staff_time', label: 'Disponibilite', style: TextInputStyle.Short, required: true, placeholder: 'Disponibilite' },
      { id: 'q_staff_age', label: 'Majeur ou non', style: TextInputStyle.Short, required: false, placeholder: 'Majeur ou non' },
    ],
  },
  'sawa-other': {
    label: '🌙 Autre',
    emoji: '🌙',
    description: 'Autre demande si aucune categorie ne convient.',
    pingRoles: ['1328310384007970888'],
    adminRoles: SAWA_ADMIN_ROLE_IDS,
    questions: [
      { id: 'q_other_subject', label: 'Sujet', style: TextInputStyle.Short, required: true, placeholder: 'Resume rapide' },
      { id: 'q_other_details', label: 'Details', style: TextInputStyle.Paragraph, required: true, placeholder: 'Explique ta demande' },
    ],
  },
};

/**
 * Load JSON data from disk.  If the file cannot be read or parsed, the
 * provided default value is returned instead.  This helper centralises the
 * error handling for file IO and JSON parsing.
 *
 * @param {string} filePath The absolute path to the JSON file.
 * @param {any} defaultValue The value to return if reading/parsing fails.
 * @returns {any}
 */
function loadJson(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to load JSON from ${filePath}:`, err);
    return defaultValue;
  }
}

/**
 * Persist JSON data to disk.  Any errors are propagated to the caller.
 *
 * @param {string} filePath The absolute path to write to.
 * @param {any} data The data to serialise.
 */
function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Load or initialise configuration.  The config.json file is organised
// per‑guild: each top level key is a guild ID mapping to a configuration
// object for that server.  See the documentation in the readme for a full
// specification of these fields.  If the file doesn’t exist the defaults
// from `defaultConfig()` are used instead.
let config = loadJson(configPaths.config, {});

// Load or initialise state.  The state file holds transient per‑guild
// information such as last seen YouTube video IDs and Twitch live status.
// If absent, it is initialised to an empty object.
let state = loadJson(configPaths.state, {});

/**
 * Return a fresh configuration object with sensible defaults for a new guild.
 * This helper is called whenever a guild is encountered for the first time.
 */
function defaultGuildConfig() {
  return {
    modules: {
      youtube: { enabled: false, channels: [], cooldown: 5 * 60 * 1000, firstInstall: 'notify' },
      shorts: { enabled: false, channels: [], cooldown: 5 * 60 * 1000, firstInstall: 'notify' },
      twitch: { enabled: false, streamers: {}, cooldown: 5 * 60 * 1000, consecutiveChecks: 1 },
      autopublish: { enabled: false },
      tickets: {
        enabled: false,
        panelChannelId: null,
        panelMessageId: null,
        openCategoryId: null,
        closedCategoryId: null,
        transcriptsChannelId: null,
        logsChannelId: null,
        creatorRoleId: null,
        verifiedRoleId: null,
        openCooldownMs: 60_000,
        maxOpenPerUser: 2,
        dmOnOpen: true,
        dmTranscript: true,
      },
      backups: { enabled: false, channelId: null, schedule: null, retention: 10 },
      templates: { enabled: false, items: {} },
      welcome: { enabled: false, channelId: null, message: 'Bienvenue sur {server}, {user} !' },
      rules: { enabled: false, title: 'Règles', content: 'Aucune règle définie.' },
      logs: { enabled: false, channelId: null },
      suggestions: { enabled: false, channelId: null },
      polls: { enabled: true },
      embeds: { enabled: true, presets: {}, defaultPreset: null },
    },
    roleLevels: {},
    featureToggles: {
      youtube: true,
      shorts: true,
      twitch: true,
      autopublish: true,
      tickets: true,
      backups: true,
      templates: true,
      welcome: true,
      rules: true,
      logs: true,
      suggestions: true,
      polls: true,
      embeds: true,
      utility: true,
      fun: true,
    },
    antiSpam: {}, // per‑channel last send timestamps
  };
}

function applyGuildPreset(guildId, guildCfg) {
  if (guildId !== SAWA_GUILD_ID) return guildCfg;
  guildCfg.modules.tickets = {
    ...guildCfg.modules.tickets,
    ...SAWA_TICKET_DEFAULTS,
    panelMessageId: guildCfg.modules.tickets.panelMessageId || null,
    creatorRoleId: guildCfg.modules.tickets.creatorRoleId || null,
    verifiedRoleId: guildCfg.modules.tickets.verifiedRoleId || null,
  };
  guildCfg.modules.logs.enabled = true;
  guildCfg.modules.logs.channelId = guildCfg.modules.logs.channelId || SAWA_LOGS_CHANNEL_ID;
  guildCfg.featureToggles.tickets = true;
  return guildCfg;
}

function migrateGuildConfig(guildCfg) {
  const def = defaultGuildConfig();
  if (!guildCfg.modules) guildCfg.modules = {};
  if (!guildCfg.roleLevels) guildCfg.roleLevels = {};
  if (!guildCfg.featureToggles) guildCfg.featureToggles = {};
  if (!guildCfg.antiSpam) guildCfg.antiSpam = {};

  for (const [k, v] of Object.entries(def.modules)) {
    if (!guildCfg.modules[k]) guildCfg.modules[k] = v;
    else {
      for (const [subk, subv] of Object.entries(v)) {
        if (guildCfg.modules[k][subk] === undefined) guildCfg.modules[k][subk] = subv;
      }
    }
  }

  for (const [k, v] of Object.entries(def.featureToggles)) {
    if (guildCfg.featureToggles[k] === undefined) guildCfg.featureToggles[k] = v;
  }

  // Migrate firstInstall from 'skip' to 'notify' for youtube/shorts
  if (guildCfg.modules.youtube && guildCfg.modules.youtube.firstInstall === 'skip') {
    guildCfg.modules.youtube.firstInstall = 'notify';
  }
  if (guildCfg.modules.shorts && guildCfg.modules.shorts.firstInstall === 'skip') {
    guildCfg.modules.shorts.firstInstall = 'notify';
  }

  return guildCfg;
}

/**
 * Ensure that a guild has an entry in both the configuration and state
 * dictionaries.  This helper is called whenever the bot is invoked on a
 * guild for the first time.
 *
 * @param {string} guildId
 * @returns {object} The guild configuration object
 */
function ensureGuildConfig(guildId) {
  if (!config[guildId]) {
    config[guildId] = defaultGuildConfig();
  } else {
    config[guildId] = migrateGuildConfig(config[guildId]);
  }
  config[guildId] = applyGuildPreset(guildId, config[guildId]);
  if (!state[guildId]) {
    state[guildId] = { youtube: {}, twitch: {}, shorts: {}, tickets: {} };
  }
  if (!state[guildId].shorts) state[guildId].shorts = {};
  if (!state[guildId].tickets) state[guildId].tickets = {};
  return config[guildId];
}

/**
 * Persist both the configuration and the transient state to disk.  This
 * function should be called whenever a modification is made to the config or
 * state objects to ensure durability.
 */
function persist() {
  saveJson(configPaths.config, config);
  saveJson(configPaths.state, state);
}

/*
 * Permission management helpers
 *
 * Commands are gated behind numeric permission levels.  Each role in a guild
 * may be assigned a level via the !setlevel command.  A member’s level is
 * defined as the maximum level across all of their roles.  Administrators
 * implicitly have infinite level and bypass level checks.  When no level
 * mapping exists for a role the default level is 0.
 */

/**
 * Compute the highest permission level of a member.  If the member has the
 * administrator permission they automatically bypass checks (Infinity).
 *
 * @param {GuildMember} member
 * @returns {number}
 */
function getUserLevel(member) {
  const guildId = member.guild.id;
  const guildCfg = ensureGuildConfig(guildId);
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return Infinity;
  let maxLevel = 0;
  for (const role of member.roles.cache.values()) {
    const level = guildCfg.roleLevels[role.id];
    if (typeof level === 'number' && level > maxLevel) {
      maxLevel = level;
    }
  }
  return maxLevel;
}

/**
 * Assign a permission level to a role within a guild.  This updates the
 * configuration and immediately persists the change.
 *
 * @param {string} guildId
 * @param {string} roleId
 * @param {number} level
 */
function setRoleLevel(guildId, roleId, level) {
  const guildCfg = ensureGuildConfig(guildId);
  guildCfg.roleLevels[roleId] = level;
  persist();
}

/**
 * Produce a sorted list of role levels configured for a guild.  Roles that
 * have been deleted will be represented by their raw ID.
 *
 * @param {Guild} guild
 * @returns {Array<{name: string, level: number}>}
 */
function listRoleLevels(guild) {
  const guildCfg = ensureGuildConfig(guild.id);
  const entries = [];
  for (const [roleId, level] of Object.entries(guildCfg.roleLevels)) {
    const role = guild.roles.cache.get(roleId);
    entries.push({ name: role ? role.name : roleId, level });
  }
  // sort descending
  return entries.sort((a, b) => b.level - a.level);
}

/*
 * Export/import helpers
 *
 * The following routines allow the bot to export the complete structure of a
 * guild (roles, categories, channels and overwrites) to a JSON blob and
 * restore it later.  These functions are extended from the starter code to
 * include additional metadata such as role positions, hoist and mentionable
 * flags, slowmode settings, NSFW flags and bitrates where applicable.  The
 * export format is versioned to allow future changes.
 */

/**
 * Export the server’s roles, categories and channels into an object.  Managed
 * roles (typically bots and integrations) are excluded because they cannot
 * be recreated via the API.  Channel permission overwrites use role names
 * so that they can be matched against newly created roles when importing.
 *
 * @param {Guild} guild The guild to export
 * @returns {object}
 */
function exportServerStructure(guild) {
  const data = {
    meta: {
      exportedAt: new Date().toISOString(),
      guildId: guild.id,
      version: 1,
    },
    roles: [],
    categories: [],
    uncategorized: [],
  };
  // Roles: exclude managed roles
  guild.roles.cache
    .filter(role => !role.managed)
    .sort((a, b) => a.position - b.position)
    .forEach(role => {
      data.roles.push({
        name: role.name,
        color: role.hexColor,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: role.permissions.toArray(),
      });
    });
  // Categories and channels
  const categories = guild.channels.cache
    .filter(ch => ch.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);
  for (const cat of categories.values()) {
    const catObj = { name: cat.name, channels: [] };
    // gather channels under this category, sorted by position
    const children = guild.channels.cache
      .filter(ch => ch.parentId === cat.id)
      .sort((a, b) => a.position - b.position);
    for (const ch of children.values()) {
      const overwrites = {};
      ch.permissionOverwrites.cache.forEach(over => {
        if (over.type === 0) {
          const role = guild.roles.cache.get(over.id);
          const roleName = role ? role.name : over.id;
          overwrites[roleName] = {
            allow: over.allow.toArray(),
            deny: over.deny.toArray(),
          };
        }
      });
      catObj.channels.push({
        name: ch.name,
        type: ch.type,
        topic: ch.topic || null,
        nsfw: ch.nsfw || false,
        slowmode: ch.rateLimitPerUser || 0,
        bitrate: ch.bitrate || null,
        userLimit: ch.userLimit || null,
        permissionOverwrites: overwrites,
      });
    }
    data.categories.push(catObj);
  }
  // Uncategorised channels
  const uncategorised = guild.channels.cache
    .filter(ch => !ch.parentId && ch.type !== ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);
  for (const ch of uncategorised.values()) {
    const overwrites = {};
    ch.permissionOverwrites.cache.forEach(over => {
      if (over.type === 0) {
        const role = guild.roles.cache.get(over.id);
        const roleName = role ? role.name : over.id;
        overwrites[roleName] = {
          allow: over.allow.toArray(),
          deny: over.deny.toArray(),
        };
      }
    });
    data.uncategorized.push({
      name: ch.name,
      type: ch.type,
      topic: ch.topic || null,
      nsfw: ch.nsfw || false,
      slowmode: ch.rateLimitPerUser || 0,
      bitrate: ch.bitrate || null,
      userLimit: ch.userLimit || null,
      permissionOverwrites: overwrites,
    });
  }
  return data;
}

/**
 * Simulate importing a server structure.  This routine counts how many
 * entities would be created without actually making modifications to the
 * guild.  It is useful for --dry-run operations.
 *
 * @param {object} structure The exported structure
 * @param {Guild} guild The guild into which the structure would be imported
 * @returns {object} Summary { roles, categories, channels }
 */
function simulateImport(structure, guild) {
  const rolesCount = structure.roles.length;
  let categoriesCount = structure.categories.length;
  let channelsCount = 0;
  structure.categories.forEach(cat => {
    channelsCount += cat.channels.length;
  });
  channelsCount += (structure.uncategorized || []).length;
  return { roles: rolesCount, categories: categoriesCount, channels: channelsCount };
}

/**
 * Import a previously exported server structure into a guild.  Roles are
 * created first, followed by categories and their channels, then
 * uncategorized channels.  Permission overwrites are matched by role names.
 *
 * @param {Guild} guild The guild into which the structure should be imported
 * @param {object} structure The exported structure
 * @param {object} options Import options { prefix?: string, skipExisting?: boolean, dryRun?: boolean, tolerant?: boolean }
 */
async function importServerStructure(guild, structure, options = {}) {
  const {
    prefix = '',
    skipExisting = false,
    dryRun = false,
    tolerant = true,
  } = options;
  const summary = { rolesCreated: 0, categoriesCreated: 0, channelsCreated: 0, warnings: [] };
  if (dryRun) {
    const counts = simulateImport(structure, guild);
    return { ...summary, ...counts };
  }
  // Build mapping from exported role name to created role object
  const roleMap = {};
  for (const roleData of structure.roles) {
    try {
      // Skip if a role with the same name already exists when skipExisting is true
      const existing = guild.roles.cache.find(r => r.name === roleData.name);
      if (skipExisting && existing) {
        roleMap[roleData.name] = existing;
        continue;
      }
      const newRole = await guild.roles.create({
        name: prefix + roleData.name,
        color: roleData.color,
        hoist: roleData.hoist,
        mentionable: roleData.mentionable,
        permissions: roleData.permissions,
        reason: 'Importation de la structure du serveur',
      });
      roleMap[roleData.name] = newRole;
      summary.rolesCreated++;
    } catch (err) {
      summary.warnings.push(`Erreur lors de la création du rôle ${roleData.name}: ${err.message}`);
      if (!tolerant) throw err;
    }
  }
  // Create categories and channels
  for (const catData of structure.categories) {
    let category;
    try {
      if (skipExisting) {
        category = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === catData.name);
      }
      if (!category) {
        category = await guild.channels.create({ name: prefix + catData.name, type: ChannelType.GuildCategory });
        summary.categoriesCreated++;
      }
    } catch (err) {
      summary.warnings.push(`Erreur lors de la création de la catégorie ${catData.name}: ${err.message}`);
      if (!tolerant) throw err;
      continue;
    }
    for (const chData of catData.channels) {
      try {
        // Skip if channel exists
        if (skipExisting) {
          const exists = guild.channels.cache.find(ch => ch.parentId === category.id && ch.name === chData.name);
          if (exists) continue;
        }
        const overwrites = [];
        for (const roleName of Object.keys(chData.permissionOverwrites)) {
          const perms = chData.permissionOverwrites[roleName];
          let role = null;
          if (roleName === '@everyone') role = guild.roles.everyone;
          else if (roleMap[roleName]) role = roleMap[roleName];
          else role = guild.roles.cache.find(r => r.name === prefix + roleName);
          if (role) {
            overwrites.push({ id: role.id, allow: perms.allow, deny: perms.deny });
          }
        }
        await guild.channels.create({
          name: prefix + chData.name,
          type: chData.type,
          parent: category,
          topic: chData.topic || undefined,
          nsfw: chData.nsfw || false,
          rateLimitPerUser: chData.slowmode || undefined,
          bitrate: chData.bitrate || undefined,
          userLimit: chData.userLimit || undefined,
          permissionOverwrites: overwrites,
        });
        summary.channelsCreated++;
      } catch (err) {
        summary.warnings.push(`Erreur lors de la création du salon ${chData.name}: ${err.message}`);
        if (!tolerant) throw err;
      }
    }
  }
  // Uncategorised channels
  for (const chData of structure.uncategorized || []) {
    try {
      if (skipExisting) {
        const exists = guild.channels.cache.find(ch => !ch.parentId && ch.name === chData.name);
        if (exists) continue;
      }
      const overwrites = [];
      for (const roleName of Object.keys(chData.permissionOverwrites)) {
        const perms = chData.permissionOverwrites[roleName];
        let role = null;
        if (roleName === '@everyone') role = guild.roles.everyone;
        else if (roleMap[roleName]) role = roleMap[roleName];
        else role = guild.roles.cache.find(r => r.name === prefix + roleName);
        if (role) {
          overwrites.push({ id: role.id, allow: perms.allow, deny: perms.deny });
        }
      }
      await guild.channels.create({
        name: prefix + chData.name,
        type: chData.type,
        topic: chData.topic || undefined,
        nsfw: chData.nsfw || false,
        rateLimitPerUser: chData.slowmode || undefined,
        bitrate: chData.bitrate || undefined,
        userLimit: chData.userLimit || undefined,
        permissionOverwrites: overwrites,
      });
      summary.channelsCreated++;
    } catch (err) {
      summary.warnings.push(`Erreur lors de la création du salon ${chData.name}: ${err.message}`);
      if (!tolerant) throw err;
    }
  }
  return summary;
}

/*
 * YouTube and Twitch notification helpers
 *
 * These functions periodically poll the YouTube Data API and Twitch Helix API
 * to detect new videos and live streams.  When a new video or stream is
 * detected the bot posts a richly formatted embed to the configured
 * announcement channel.  Anti‑spam logic ensures that each guild receives
 * notifications at a controlled rate.  First‑install modes avoid spamming
 * existing videos when channels are first added.
 */

// Global in‑memory cache for Twitch access tokens.  The token is valid
// across all guilds as Twitch issues tokens per client ID/secret.  If your
// bot needs to use different client IDs per guild you can modify this
// structure accordingly.
let twitchAccessToken = null;
let twitchTokenExpiry = 0;

/**
 * Request a new Twitch app access token if the cached one has expired.  Uses
 * the client credentials grant flow as documented by Twitch【33025305339231†L160-L187】.  A
 * successful response returns an access token along with an expiration time.
 * Tokens are cached until one minute before their expiry to avoid repeated
 * requests.
 *
 * @returns {Promise<string>} The bearer token
 */
async function getTwitchAccessToken(clientId, clientSecret) {
  const now = Date.now();
  if (twitchAccessToken && now < twitchTokenExpiry) {
    return twitchAccessToken;
  }
  if (!clientId || !clientSecret) throw new Error('Missing Twitch client credentials');
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('grant_type', 'client_credentials');
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to obtain Twitch access token');
  twitchAccessToken = data.access_token;
  twitchTokenExpiry = now + data.expires_in * 1000 - 60000;
  return twitchAccessToken;
}

/**
 * Resolve a YouTube channel identifier (UC… ID, @handle, or custom URL slug)
 * to a verified { id, title } object.  Returns null when the identifier does
 * not match any channel.
 */
async function resolveYouTubeChannel(input) {
  const apiKey = process.env.YT_API_KEY;
  if (!apiKey) return null;

  // Try direct channel ID lookup first (UC…)
  if (input.startsWith('UC')) {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(input)}&key=${apiKey}`,
    );
    if (res.ok) {
      const data = await res.json();
      if (data.items && data.items.length > 0) {
        return { id: data.items[0].id, title: data.items[0].snippet.title };
      }
    }
  }

  // Try resolving as @handle or custom slug
  const handle = input.startsWith('@') ? input : `@${input}`;
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`,
  );
  if (res.ok) {
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      return { id: data.items[0].id, title: data.items[0].snippet.title };
    }
  }

  return null;
}

/**
 * Convert a YouTube channel ID (UCxxx) to its uploads playlist ID (UUxxx).
 */
function getUploadsPlaylistId(channelId) {
  if (channelId.startsWith('UC')) return 'UU' + channelId.slice(2);
  return channelId;
}

/**
 * Parse an ISO 8601 duration string (e.g. PT1H2M30S, PT58S, PT1M) into
 * total seconds.
 */
function parseISO8601Duration(str) {
  const m = (str || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || '0', 10) * 3600) +
         (parseInt(m[2] || '0', 10) * 60) +
         (parseInt(m[3] || '0', 10));
}

/**
 * Poll all guilds for new YouTube videos and Shorts.  Uses the playlistItems
 * endpoint (1 quota unit) instead of search (100 units) for efficiency.
 * After finding new videos, calls the videos endpoint to check duration and
 * classify content as a Short (≤60s) or a regular video.
 */
async function pollYouTube() {
  const apiKey = process.env.YT_API_KEY;
  if (!apiKey) return;

  for (const [guildId, guildCfg] of Object.entries(config)) {
    const ytCfg = guildCfg.modules.youtube;
    const shCfg = guildCfg.modules.shorts;
    const ytEnabled = guildCfg.featureToggles.youtube && ytCfg.enabled;
    const shEnabled = guildCfg.featureToggles.shorts && shCfg.enabled;
    if (!ytEnabled && !shEnabled) continue;

    // Collect all unique YT channel IDs that need polling, with their targets
    const channelTargets = new Map(); // ytChannelId → { youtube: [announceIds], shorts: [announceIds] }
    if (ytEnabled) {
      for (const c of ytCfg.channels) {
        if (!channelTargets.has(c.id)) channelTargets.set(c.id, { youtube: [], shorts: [] });
        channelTargets.get(c.id).youtube.push(c.announceChannelId);
      }
    }
    if (shEnabled) {
      for (const c of shCfg.channels) {
        if (!channelTargets.has(c.id)) channelTargets.set(c.id, { youtube: [], shorts: [] });
        channelTargets.get(c.id).shorts.push(c.announceChannelId);
      }
    }

    // Ensure state exists for this guild before polling
    if (!state[guildId]) state[guildId] = { youtube: {}, twitch: {}, shorts: {} };
    if (!state[guildId].youtube) state[guildId].youtube = {};
    if (!state[guildId].shorts) state[guildId].shorts = {};

    for (const [ytChannelId, targets] of channelTargets) {
      try {
        // Use playlistItems (1 quota unit) instead of search (100 units)
        const playlistId = getUploadsPlaylistId(ytChannelId);
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=3&key=${apiKey}`,
        );
        if (!res.ok) {
          log(guildId, `Erreur API YouTube playlistItems: ${res.status}`);
          continue;
        }
        const data = await res.json();
        if (!data.items || data.items.length === 0) continue;

        // Check the most recent video
        const item = data.items[0];
        const videoId = item.snippet.resourceId.videoId;

        // Check if this video is new for either youtube or shorts state
        const lastYt = state[guildId].youtube[ytChannelId];
        const lastSh = state[guildId].shorts[ytChannelId];
        const isNewForYt = lastYt !== videoId;
        const isNewForSh = lastSh !== videoId;

        if (!isNewForYt && !isNewForSh) continue;

        // Fetch video details to get duration (1 quota unit)
        const vidRes = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoId}&key=${apiKey}`,
        );
        if (!vidRes.ok) {
          log(guildId, `Erreur API YouTube videos: ${vidRes.status}`);
          continue;
        }
        const vidData = await vidRes.json();
        if (!vidData.items || vidData.items.length === 0) continue;

        const videoInfo = vidData.items[0];
        const durationSec = parseISO8601Duration(videoInfo.contentDetails.duration);
        const isShort = durationSec <= 60;

        // Build a compatible item object for notification functions
        const notifItem = {
          snippet: videoInfo.snippet,
          id: { videoId },
        };

        const now = Date.now();

        if (isShort && isNewForSh && targets.shorts.length > 0) {
          // Handle first install for shorts
          const isFirstInstall = lastSh === undefined;
          state[guildId].shorts[ytChannelId] = videoId;
          if (isFirstInstall && shCfg.firstInstall !== 'notify') {
            persist();
          } else {
            for (const announceId of targets.shorts) {
              const spamKey = `${guildId}:sh:${announceId}`;
              if (guildCfg.antiSpam[spamKey] && now - guildCfg.antiSpam[spamKey] < shCfg.cooldown) continue;
              guildCfg.antiSpam[spamKey] = now;
              await sendShortsNotification(guildId, announceId, notifItem);
            }
            persist();
          }
        } else if (!isShort && isNewForYt && targets.youtube.length > 0) {
          // Handle first install for youtube
          const isFirstInstall = lastYt === undefined;
          state[guildId].youtube[ytChannelId] = videoId;
          if (isFirstInstall && ytCfg.firstInstall !== 'notify') {
            persist();
          } else {
            for (const announceId of targets.youtube) {
              const spamKey = `${guildId}:yt:${announceId}`;
              if (guildCfg.antiSpam[spamKey] && now - guildCfg.antiSpam[spamKey] < ytCfg.cooldown) continue;
              guildCfg.antiSpam[spamKey] = now;
              await sendYouTubeNotification(guildId, announceId, notifItem);
            }
            persist();
          }
        }

        // Update state for the type we don't target so we don't re-check
        if (isShort && isNewForYt) {
          state[guildId].youtube[ytChannelId] = videoId;
          persist();
        } else if (!isShort && isNewForSh) {
          state[guildId].shorts[ytChannelId] = videoId;
          persist();
        }
      } catch (err) {
        log(guildId, `Échec de la récupération des vidéos YouTube: ${err.message}`);
      }
    }
  }
}

/**
 * Send an embed notification for a YouTube video to a specific guild/channel.
 *
 * @param {string} guildId
 * @param {string|null} discordChannelId
 * @param {object} item YouTube API item with snippet and id
 */
async function sendYouTubeNotification(guildId, discordChannelId, item) {
  if (!discordChannelId) return;
  try {
    const channel = await client.channels.fetch(discordChannelId);
    const guild = client.guilds.cache.get(guildId);
    if (!channel || !guild || !canSendEmbeds(channel, guild)) {
      await log(guildId, "Impossible d'envoyer la notification YouTube (salon invalide ou permissions manquantes).");
      return;
    }
    const snippet = item.snippet;
    const videoId = item.id.videoId;
    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle(`▶️ Nouvelle vidéo : ${snippet.title}`)
      .setURL(`https://www.youtube.com/watch?v=${videoId}`)
      .setDescription(snippet.description ? snippet.description.slice(0, 200) : '')
      .setImage(snippet.thumbnails?.maxres?.url ?? snippet.thumbnails?.high?.url ?? null)
      .addFields({ name: 'Chaîne', value: snippet.channelTitle, inline: true })
      .setTimestamp(new Date(snippet.publishedAt));
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log(guildId, `Erreur lors de l'envoi de la notification YouTube: ${err.message}`);
  }
}

/**
 * Send an embed notification for a YouTube Short to a specific guild/channel.
 */
async function sendShortsNotification(guildId, discordChannelId, item) {
  if (!discordChannelId) return;
  try {
    const channel = await client.channels.fetch(discordChannelId);
    const guild = client.guilds.cache.get(guildId);
    if (!channel || !guild || !canSendEmbeds(channel, guild)) {
      await log(guildId, "Impossible d'envoyer la notification Short (salon invalide ou permissions manquantes).");
      return;
    }
    const snippet = item.snippet;
    const videoId = item.id.videoId;
    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle(`📱 Nouveau Short : ${snippet.title}`)
      .setURL(`https://www.youtube.com/shorts/${videoId}`)
      .setThumbnail(snippet.thumbnails?.high?.url ?? null)
      .addFields({ name: 'Chaîne', value: snippet.channelTitle, inline: true })
      .setTimestamp(new Date(snippet.publishedAt));
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log(guildId, `Erreur lors de l'envoi de la notification Short: ${err.message}`);
  }
}

/**
 * Poll all guilds for Twitch stream status.  For each configured streamer the
 * bot requests the helix streams endpoint.  According to Twitch staff on
 * their developer forums, if the channel is live a stream object is
 * returned, otherwise the `data` array is empty【38935646900982†L91-L96】.  When a
 * streamer transitions from offline to online the bot posts a notification,
 * and when going offline the state is updated.  A configurable number of
 * consecutive online checks can be required to reduce false positives.
 */
async function pollTwitch() {
  for (const [guildId, guildCfg] of Object.entries(config)) {
    const moduleCfg = guildCfg.modules.twitch;
    if (!guildCfg.featureToggles.twitch || !moduleCfg.enabled) continue;
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) continue;
    let token;
    try {
      token = await getTwitchAccessToken(clientId, clientSecret);
    } catch (err) {
      log(guildId, `Erreur d'authentification Twitch: ${err.message}`);
      continue;
    }
    for (const [login, streamerState] of Object.entries(moduleCfg.streamers)) {
      try {
        const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`, {
          headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const isLive = data.data && data.data.length > 0;
        if (isLive) {
          const stream = data.data[0];
          // update history of consecutive online checks
          streamerState.onlineChecks = (streamerState.onlineChecks || 0) + 1;
          if (!streamerState.isLive && streamerState.onlineChecks >= moduleCfg.consecutiveChecks) {
            // rate limit per channel
            const announceId = streamerState.announceChannelId;
            const spamKey = `${guildId}:${announceId}`;
            const now = Date.now();
            if (guildCfg.antiSpam[spamKey] && now - guildCfg.antiSpam[spamKey] < moduleCfg.cooldown) {
              continue;
            }
            guildCfg.antiSpam[spamKey] = now;
            streamerState.isLive = true;
            streamerState.onlineChecks = 0;
            persist();
            // Fetch user profile for avatar
            let userInfo = null;
            try {
              const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
                headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}` },
              });
              const userData = await userRes.json();
              if (userData.data && userData.data.length > 0) userInfo = userData.data[0];
            } catch (_) { /* avatar is optional */ }
            await sendTwitchNotification(guildId, announceId, stream, userInfo);
          }
        } else {
          // offline
          streamerState.onlineChecks = 0;
          if (streamerState.isLive) {
            streamerState.isLive = false;
            persist();
          }
        }
      } catch (err) {
        log(guildId, `Erreur lors de la vérification Twitch pour ${login}: ${err.message}`);
      }
    }
  }
}

/**
 * Send a Twitch live notification embed with streamer avatar and stream
 * preview image.
 *
 * @param {string} guildId
 * @param {string|null} channelId
 * @param {object} stream The stream object returned by the API
 * @param {object|null} userInfo The user object from the users endpoint (optional)
 */
async function sendTwitchNotification(guildId, channelId, stream, userInfo) {
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    const guild = client.guilds.cache.get(guildId);
    if (!channel || !guild || !canSendEmbeds(channel, guild)) {
      await log(guildId, "Impossible d'envoyer la notification Twitch (salon invalide ou permissions manquantes).");
      return;
    }
    const streamUrl = `https://twitch.tv/${stream.user_login}`;
    const thumbnail = stream.thumbnail_url
      ? stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720')
      : null;
    const fields = [
      { name: 'Jeu/Catégorie', value: stream.game_name || 'Inconnu', inline: true },
      { name: 'Spectateurs', value: `${stream.viewer_count}`, inline: true },
    ];
    if (stream.tags && stream.tags.length > 0) {
      fields.push({ name: 'Tags', value: stream.tags.slice(0, 5).join(', '), inline: false });
    }
    const embed = new EmbedBuilder()
      .setColor(0x9146ff)
      .setAuthor({
        name: stream.user_name,
        iconURL: userInfo?.profile_image_url ?? undefined,
        url: streamUrl,
      })
      .setTitle(`🔴 Live maintenant : ${stream.title || 'Sans titre'}`)
      .setURL(streamUrl)
      .addFields(...fields)
      .setImage(thumbnail)
      .setTimestamp(new Date(stream.started_at));
    if (userInfo?.profile_image_url) {
      embed.setThumbnail(userInfo.profile_image_url);
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Regarder le stream')
        .setStyle(ButtonStyle.Link)
        .setURL(streamUrl),
    );
    await channel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    log(guildId, `Erreur lors de l'envoi de la notification Twitch: ${err.message}`);
  }
}

/**
 * Send a message into the guild’s logs channel if logging is enabled.  Logs
 * are grouped to avoid spamming; identical messages are suppressed within
 * short windows.  When logs are disabled or the channel cannot be found
 * this function does nothing.  The antiSpam map is re‑used to throttle
 * repeated log entries.
 *
 * @param {string} guildId
 * @param {string} message
 */
async function log(guildId, message) {
  const guildCfg = ensureGuildConfig(guildId);
  const logsCfg = guildCfg.modules.logs;
  if (!guildCfg.featureToggles.logs || !logsCfg.enabled || !logsCfg.channelId) return;
  const spamKey = `${guildId}:log:${message}`;
  const now = Date.now();
  // Do not log identical messages more than once every minute
  if (guildCfg.antiSpam[spamKey] && now - guildCfg.antiSpam[spamKey] < 60000) {
    return;
  }
  guildCfg.antiSpam[spamKey] = now;
  try {
    const channel = await client.channels.fetch(logsCfg.channelId);
    if (channel) await channel.send(`📋 ${message}`);
  } catch (err) {
    console.error('Failed to write log:', err);
  }
}

/*
 * Backup scheduler
 *
 * The backup module exports the current server structure on a schedule
 * configured per guild.  Exports are posted into a designated backup channel
 * as a JSON attachment.  Backup retention is enforced by deleting older
 * backup messages posted by the bot when the number of backups exceeds the
 * retention limit.
 */

// Simple scheduler map keyed by guild ID storing interval handles
const backupIntervals = {};

/**
 * Start the backup schedule for a guild.  If a schedule already exists it is
 * cleared first.  The schedule may be 'daily' or 'weekly'.  Daily backups
 * run at 03:00 local server time; weekly backups run every Sunday at 03:00.
 *
 * @param {string} guildId
 */
function scheduleBackups(guildId) {
  // Clear any existing interval
  if (backupIntervals[guildId]) {
    clearInterval(backupIntervals[guildId]);
    delete backupIntervals[guildId];
  }
  const guildCfg = ensureGuildConfig(guildId);
  const backupsCfg = guildCfg.modules.backups;
  if (!guildCfg.featureToggles.backups || !backupsCfg.enabled || !backupsCfg.schedule || !backupsCfg.channelId) {
    return;
  }
  // Determine interval in milliseconds for schedule
  let intervalMs;
  if (backupsCfg.schedule === 'daily') intervalMs = 24 * 60 * 60 * 1000;
  else if (backupsCfg.schedule === 'weekly') intervalMs = 7 * 24 * 60 * 60 * 1000;
  else return;
  // Compute initial delay so backups run at 03:00 server time
  const now = new Date();
  const first = new Date(now);
  first.setHours(3, 0, 0, 0);
  if (now > first) first.setTime(first.getTime() + intervalMs);
  const delay = first.getTime() - now.getTime();
  backupIntervals[guildId] = setTimeout(() => {
    performBackup(guildId);
    backupIntervals[guildId] = setInterval(() => performBackup(guildId), intervalMs);
  }, delay);
}

/**
 * Perform a backup of the guild’s structure and post it into the configured
 * backup channel.  After posting, enforce the retention policy by deleting
 * older backup messages.
 *
 * @param {string} guildId
 */
async function performBackup(guildId) {
  const guild = client.guilds.cache.get(guildId);
  const guildCfg = ensureGuildConfig(guildId);
  const backupsCfg = guildCfg.modules.backups;
  if (!guild || !guildCfg.featureToggles.backups || !backupsCfg.enabled || !backupsCfg.channelId) return;
  try {
    const data = exportServerStructure(guild);
    const json = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(json, 'utf8');
    const fileName = `backup-${guild.id}-${Date.now()}.json`;
    const attachment = new AttachmentBuilder(buffer, { name: fileName });
    const channel = await client.channels.fetch(backupsCfg.channelId);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('Sauvegarde automatique')
      .setDescription(`Sauvegarde générée le <t:${Math.floor(Date.now() / 1000)}:F> pour **${guild.name}**.`)
      .setTimestamp();
    await channel.send({ embeds: [embed], files: [attachment] });
    // enforce retention: fetch messages sent by the bot in this channel
    const messages = await channel.messages.fetch({ limit: 100 });
    const backups = messages.filter(m => m.author.id === client.user.id && m.attachments.size > 0);
    if (backups.size > backupsCfg.retention) {
      const toDelete = backups
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .first(backups.size - backupsCfg.retention);
      for (const msg of toDelete) {
        await msg.delete().catch(() => {});
      }
    }
  } catch (err) {
    log(guildId, `Échec de la sauvegarde: ${err.message}`);
  }
}

/*
 * Template management
 *
 * Templates allow servers to predefine richly formatted embeds that can be
 * reused across announcements.  Each template stores a title and content
 * (description).  Variables such as {server}, {user}, {date} and {channel}
 * are substituted when the template is sent.  Templates are stored per
 * guild in the configuration under modules.templates.items.
 */

/**
 * Apply variable substitution to a template string.  Recognised variables:
 *  - {server}: the guild name
 *  - {user}: the command caller’s display name
 *  - {channel}: the channel where the command is invoked
 *  - {date}: ISO formatted date
 *
 * @param {string} text
 * @param {Guild} guild
 * @param {GuildMember} member
 * @param {TextBasedChannel} channel
 * @returns {string}
 */
function substituteTemplate(text, guild, member, channel) {
  return text
    .replace(/{server}/gi, guild.name)
    .replace(/{user}/gi, member.displayName)
    .replace(/{channel}/gi, channel.name)
    .replace(/{date}/gi, new Date().toLocaleDateString());
}

/*
 * Command definitions
 *
 * Commands are defined in an object keyed by the command name.  Each entry
 * specifies the minimum permission level required and a handler function
 * invoked with the message and an argument array.  When adding commands
 * here ensure you also update the help strings below.
 */

const PREFIX = '!';
const pendingPatches = new Map();
const PATCH_CONFIRM_TTL_MS = 10 * 60 * 1000;
const PATCH_MAX_ACTIONS = process.env.PATCH_MAX_ACTIONS ? parseInt(process.env.PATCH_MAX_ACTIONS, 10) : 500;
const PATCH_ALLOW_DELETES_DEFAULT = (process.env.PATCH_ALLOW_DELETES || '').toLowerCase() === 'true';

const POLL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SUGGEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const interactive = {
  polls: new Map(),
  suggestions: new Map(),
};
const autoPublishWindow = new Map();
const AUTOPUBLISH_MAX_PER_HOUR = 10;
const AUTOPUBLISH_WINDOW_MS = 60 * 60 * 1000;

function shortId(len = 8) {
  return Math.random().toString(36).slice(2, 2 + len).toUpperCase();
}

function cleanupInteractiveStore() {
  const now = Date.now();
  for (const [id, p] of interactive.polls.entries()) {
    if (now - (p.createdAt || now) > POLL_TTL_MS) interactive.polls.delete(id);
  }
  for (const [id, s] of interactive.suggestions.entries()) {
    if (now - (s.createdAt || now) > SUGGEST_TTL_MS) interactive.suggestions.delete(id);
  }
}
setInterval(cleanupInteractiveStore, 60 * 60 * 1000);

const commands = {};

function registerCommand(name, level, handler, options = {}) {
  commands[name] = { level, handler, wantsRaw: Boolean(options.wantsRaw) };
}

function canSendEmbeds(channel, guild) {
  if (!channel || typeof channel.permissionsFor !== 'function') return false;
  const perms = channel.permissionsFor(guild.members.me);
  return Boolean(
    perms
      && perms.has(PermissionsBitField.Flags.ViewChannel)
      && perms.has(PermissionsBitField.Flags.SendMessages)
      && perms.has(PermissionsBitField.Flags.EmbedLinks),
  );
}

function isAnnouncementChannel(channel) {
  return Boolean(channel && channel.type === ChannelType.GuildAnnouncement);
}

function canAutoPublish(channel, guild) {
  if (!channel || typeof channel.permissionsFor !== 'function') return false;
  const perms = channel.permissionsFor(guild.members.me);
  return Boolean(
    perms
      && perms.has(PermissionsBitField.Flags.ViewChannel)
      && perms.has(PermissionsBitField.Flags.SendMessages)
      && perms.has(PermissionsBitField.Flags.ManageMessages),
  );
}

function reserveAutoPublishSlot(guildId) {
  const now = Date.now();
  const timestamps = (autoPublishWindow.get(guildId) || []).filter(ts => now - ts < AUTOPUBLISH_WINDOW_MS);
  if (timestamps.length >= AUTOPUBLISH_MAX_PER_HOUR) {
    autoPublishWindow.set(guildId, timestamps);
    return false;
  }
  timestamps.push(now);
  autoPublishWindow.set(guildId, timestamps);
  return true;
}

async function maybeAutoPublishMessage(message) {
  if (!message?.guild || !message.channel) return;
  const guildCfg = ensureGuildConfig(message.guild.id);
  const autoCfg = guildCfg.modules.autopublish;
  if (!moduleEnabled(guildCfg, 'autopublish') || !autoCfg?.enabled) return;
  if (!isAnnouncementChannel(message.channel)) return;
  if (!message.crosspostable) return;
  if (!canAutoPublish(message.channel, message.guild)) return;
  if (!reserveAutoPublishSlot(message.guild.id)) {
    return log(message.guild.id, `[autopublish] Limite horaire atteinte pour ${message.channel.id}`);
  }

  try {
    await message.crosspost();
  } catch (err) {
    const code = err?.code;
    if (code === 40033 || code === 40094) return;
    if (code === 50013) {
      return log(message.guild.id, `[autopublish] Permissions insuffisantes dans ${message.channel.id}`);
    }
    return log(message.guild.id, `[autopublish] Échec de publication dans ${message.channel.id}: ${err.message}`);
  }
}

function makeBotEmbed(kind, guild, title, description, fields) {
  return buildEmbed(kind, { client, guild, title, description, fields });
}

async function replyBot(message, kind, title, description, fields) {
  return message.reply({ embeds: [makeBotEmbed(kind, message.guild, title, description, fields)] });
}

function moduleEnabled(guildCfg, name) {
  return Boolean(guildCfg?.featureToggles?.[name]);
}

function getTicketModule(guildId) {
  return ensureGuildConfig(guildId).modules.tickets;
}

function getTicketState(guildId) {
  ensureGuildConfig(guildId);
  if (!state[guildId].tickets) state[guildId].tickets = {};
  return state[guildId].tickets;
}

function getTicketType(typeId) {
  return SAWA_TICKET_TYPES[typeId] || null;
}

function slugifyTicketName(input) {
  return String(input || 'user')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'user';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTicketRoleMentions(roleIds) {
  return (roleIds || []).map(id => `<@&${id}>`).join(' ');
}

function ticketLogChannel(guild, ticketsCfg) {
  return guild.channels.cache.get(ticketsCfg.logsChannelId || ticketsCfg.transcriptsChannelId || '');
}

function buildTicketPanelEmbed(guild) {
  const lines = [
    '🌙 Choisis la categorie qui correspond le mieux a ta demande.',
    '',
    '🐾 Support: aide, bug, souci ou question',
    '🚨 Signalement: comportement, message ou situation a signaler',
    '🤝 Collab: proposition de collab ou partenariat',
    '🧸 Staff: candidature pour aider le serveur',
    '🌙 Autre: si rien ne correspond vraiment',
    '',
    '✨ Appuie sur le bouton qui te correspond.',
    'Une fois ouvert, le ticket reste prive entre toi et le staff concerne.',
  ];
  return new EmbedBuilder()
    .setColor(0x40449b)
    .setTitle('⌜★⌟────✦・🎫 TICKETS・✦────⌞★⌟')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `✦・${guild.name}・✦` });
}

function buildTicketPanelComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticketopen:sawa-support').setLabel('Support').setEmoji('🐾').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticketopen:sawa-report').setLabel('Signalement').setEmoji('🚨').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticketopen:sawa-collab').setLabel('Collab').setEmoji('🤝').setStyle(ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticketopen:sawa-staff').setLabel('Staff').setEmoji('🧸').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticketopen:sawa-other').setLabel('Autre').setEmoji('🌙').setStyle(ButtonStyle.Primary),
  );
  return [row1, row2];
}

function buildTicketActionRows(isClosed = false) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Fermer').setEmoji('🧯').setStyle(ButtonStyle.Danger).setDisabled(isClosed),
    new ButtonBuilder().setCustomId('ticket:claim').setLabel('Prendre').setEmoji('🧸').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket:reopen').setLabel('Rouvrir').setEmoji('✨').setStyle(ButtonStyle.Success).setDisabled(!isClosed),
  );
  return [row];
}

function buildTicketWelcomeEmbed(guild, ticketType, opener, answers) {
  const fields = answers.map(answer => ({
    name: answer.label,
    value: clampStr(answer.value || 'Non renseigne', 1024),
    inline: false,
  }));
  return new EmbedBuilder()
    .setColor(0x0455b8)
    .setTitle('⌜★⌟────✦・Ticket ouvert・✦────⌞★⌟')
    .setDescription(
      `🌙 Bonjour <@${opener.id}>, ton ticket **${ticketType.label}** est bien ouvert.\n`
      + '🐾 Merci de rester clair, patient et respectueux.\n'
      + '📎 Si tu dois envoyer une capture ou une image, poste-la directement dans ce salon juste apres ce message.\n'
      + '🧯 Utilise le bouton **Fermer** quand tout est regle.',
    )
    .addFields(fields)
    .setFooter({ text: `✦・${guild.name}・✦` })
    .setTimestamp();
}

function buildTicketDmEmbed(guild) {
  return new EmbedBuilder()
    .setColor(0x40449b)
    .setTitle('🌙 Ton ticket est ouvert')
    .setDescription('On arrive bientot, merci de patienter 🐾')
    .setFooter({ text: `✦・${guild.name}・✦` });
}

function buildTicketClosedEmbed(guild, member) {
  return new EmbedBuilder()
    .setColor(0x40449b)
    .setTitle('⌜★⌟────✦・Ticket ferme・✦────⌞★⌟')
    .setDescription(`🧯 Ticket ferme par <@${member.id}>.\n🌙 Le transcript a ete prepare pour le staff.`)
    .setFooter({ text: `✦・${guild.name}・✦` })
    .setTimestamp();
}

function buildTicketClaimEmbed(guild, member) {
  return new EmbedBuilder()
    .setColor(0x0455b8)
    .setTitle('⌜★⌟────✦・Ticket pris en charge・✦────⌞★⌟')
    .setDescription(`🧸 <@${member.id}> prend ce ticket en charge.`)
    .setFooter({ text: `✦・${guild.name}・✦` })
    .setTimestamp();
}

function buildTicketReopenEmbed(guild, member) {
  return new EmbedBuilder()
    .setColor(0x0455b8)
    .setTitle('⌜★⌟────✦・Ticket rouvert・✦────⌞★⌟')
    .setDescription(`✨ Ticket rouvert par <@${member.id}>.`)
    .setFooter({ text: `✦・${guild.name}・✦` })
    .setTimestamp();
}

function canManageTicket(member, ticketInfo) {
  if (!member || !ticketInfo) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (member.id === ticketInfo.ownerId) return true;
  return (ticketInfo.adminRoles || []).some(roleId => member.roles.cache.has(roleId));
}

function canModerateTicket(member, ticketInfo) {
  if (!member || !ticketInfo) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return (ticketInfo.adminRoles || []).some(roleId => member.roles.cache.has(roleId));
}

function canCreateTicket(member, ticketType, ticketsCfg) {
  if (!ticketType.requiresVerified) return { ok: true };
  if (!ticketsCfg.verifiedRoleId) return { ok: true };
  return member.roles.cache.has(ticketsCfg.verifiedRoleId)
    ? { ok: true }
    : { ok: false, reason: 'Ce ticket est reserve aux membres verifies.' };
}

function getOpenTicketsForUser(guildId, userId) {
  return Object.values(getTicketState(guildId)).filter(t => t.ownerId === userId && !t.closedAt);
}

async function sendTicketLog(guild, ticketsCfg, title, description) {
  const channel = ticketLogChannel(guild, ticketsCfg);
  if (!channel || !channel.isTextBased()) return;
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x40449b)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp(),
    ],
  }).catch(() => {});
}

async function sendTicketSupportAlert(guild, channel, opener, ticketType) {
  const logChannel = guild.channels.cache.get(SAWA_SUPPORT_ALERT_CHANNEL_ID);
  if (!logChannel || !logChannel.isTextBased()) return;
  await logChannel.send({
    content: '<@&1328310491038351471>',
    embeds: [
      new EmbedBuilder()
        .setColor(0x40449b)
        .setTitle('⌜★⌟────✦・Nouveau ticket・✦────⌞★⌟')
        .setDescription(
          `🎫 Un nouveau ticket **${ticketType.label}** vient d'etre cree.\n`
          + `🌙 Membre: <@${opener.id}>\n`
          + `🐾 Salon: ${channel}\n`
          + '✨ Merci de passer des que possible.',
        )
        .setFooter({ text: `✦・${guild.name}・✦` })
        .setTimestamp(),
    ],
    allowedMentions: { roles: ['1328310491038351471'] },
  }).catch(() => {});
}

async function fetchTicketMessages(channel) {
  let before;
  const out = [];
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    out.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return out.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function buildTranscriptHtml(guild, channel, ticketInfo, messages) {
  const rows = messages.map((message) => {
    const body = [
      message.content ? `<div class="content">${escapeHtml(message.content).replace(/\n/g, '<br>')}</div>` : '',
      message.attachments.size
        ? `<div class="attachments">${[...message.attachments.values()].map(a => `<a href="${escapeHtml(a.url)}">${escapeHtml(a.name || 'attachment')}</a>`).join('<br>')}</div>`
        : '',
    ].filter(Boolean).join('');
    return `<article class="msg">
<div class="meta"><strong>${escapeHtml(message.author.tag)}</strong> <span>${new Date(message.createdTimestamp).toLocaleString('fr-FR')}</span></div>
${body}
</article>`;
  }).join('\n');
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${escapeHtml(channel.name)}</title>
<style>
body{background:#0d122b;color:#f4f6ff;font-family:Arial,sans-serif;padding:24px}
.card{max-width:980px;margin:0 auto;background:#151c45;border:1px solid #40449B;border-radius:16px;padding:24px}
h1{margin:0 0 8px;color:#9fb6ff}
.meta-top{color:#cad4ff;margin-bottom:24px}
.msg{padding:14px 0;border-top:1px solid rgba(255,255,255,.08)}
.meta{font-size:13px;color:#aab7ff;margin-bottom:6px}
.content{white-space:normal;line-height:1.5}
.attachments a{color:#8dc7ff}
</style>
</head>
<body>
<div class="card">
<h1>⌜★⌟────✦・Transcript Ticket・✦────⌞★⌟</h1>
<div class="meta-top">Serveur: ${escapeHtml(guild.name)}<br>Salon: ${escapeHtml(channel.name)}<br>Type: ${escapeHtml(ticketInfo.typeId)}<br>Createur: ${escapeHtml(ticketInfo.ownerTag || ticketInfo.ownerId)}</div>
${rows || '<p>Aucun message.</p>'}
</div>
</body>
</html>`;
}

async function deliverTicketTranscript(guild, channel, ticketInfo, closedBy) {
  const ticketsCfg = getTicketModule(guild.id);
  const transcriptChannel = guild.channels.cache.get(ticketsCfg.transcriptsChannelId || '');
  const messages = await fetchTicketMessages(channel);
  const html = buildTranscriptHtml(guild, channel, ticketInfo, messages);
  const file = new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `${channel.name}-transcript.html` });

  if (transcriptChannel && transcriptChannel.isTextBased()) {
    await transcriptChannel.send({
      content: `🎫 Transcript pour <#${channel.id}> • createur <@${ticketInfo.ownerId}> • ferme par <@${closedBy.id}>`,
      files: [file],
    }).catch(() => {});
  }

  if (ticketsCfg.dmTranscript) {
    const user = await client.users.fetch(ticketInfo.ownerId).catch(() => null);
    if (user) {
      const dmFile = new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `${channel.name}-transcript.html` });
      await user.send({
        content: '🌙 Voici le transcript HTML de ton ticket.',
        files: [dmFile],
      }).catch(() => {});
    }
  }
}

async function createTicketChannel(guild, opener, typeId, answers) {
  const guildCfg = ensureGuildConfig(guild.id);
  const ticketsCfg = guildCfg.modules.tickets;
  const type = getTicketType(typeId);
  if (!type) throw new Error('Type de ticket inconnu');

  const userOpenTickets = getOpenTicketsForUser(guild.id, opener.id);
  if (userOpenTickets.length >= ticketsCfg.maxOpenPerUser) {
    throw new Error(`Tu as deja ${ticketsCfg.maxOpenPerUser} ticket(s) ouvert(s).`);
  }

  const stateTickets = getTicketState(guild.id);
  const lastOpenedAt = Math.max(0, ...Object.values(stateTickets).filter(t => t.ownerId === opener.id).map(t => t.createdAt || 0));
  if (Date.now() - lastOpenedAt < ticketsCfg.openCooldownMs) {
    throw new Error('Merci de patienter un peu avant douvrir un nouveau ticket.');
  }

  const typeSlug = typeId.replace(/^sawa-/, '');
  const baseName = slugifyTicketName(opener.username);
  let name = `ticket-${typeSlug}-${baseName}`;
  let index = 2;
  while (guild.channels.cache.find(ch => ch.name === name)) {
    name = `ticket-${typeSlug}-${baseName}-${index}`;
    index++;
  }

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: opener.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    },
  ];

  for (const roleId of new Set(type.adminRoles)) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ManageChannels,
      ],
    });
  }

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: ticketsCfg.openCategoryId || undefined,
    topic: `ticket:${typeId}:owner=${opener.id}`,
    permissionOverwrites: overwrites,
  });

  const ticketInfo = {
    typeId,
    ownerId: opener.id,
    ownerTag: opener.user.tag,
    adminRoles: [...new Set(type.adminRoles)],
    pingRoles: [...new Set(type.pingRoles)],
    answers,
    createdAt: Date.now(),
    createdByChannelId: channel.id,
    claimedBy: null,
    closedAt: null,
  };
  stateTickets[channel.id] = ticketInfo;
  persist();

  const mentionText = formatTicketRoleMentions(type.pingRoles);
  await channel.send({
    content: mentionText || undefined,
    embeds: [buildTicketWelcomeEmbed(guild, type, opener.user, answers)],
    components: buildTicketActionRows(false),
    allowedMentions: { roles: type.pingRoles },
  });

  const needsAttachmentHint = answers.some(answer => /capture|preuve|image|lien/i.test(answer.label));
  if (needsAttachmentHint) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x0455b8)
          .setTitle('⌜★⌟────✦・Capture / Image・✦────⌞★⌟')
          .setDescription('📎 Discord ne permet pas d’ajouter une image directement dans le formulaire.\nEnvoie simplement ta capture, image ou fichier ici dans le ticket, et le staff la verra.'),
      ],
    }).catch(() => {});
  }

  if (ticketsCfg.dmOnOpen) {
    await opener.send({ embeds: [buildTicketDmEmbed(guild)] }).catch(() => {});
  }

  await sendTicketLog(guild, ticketsCfg, '⌜★⌟────✦・Nouveau ticket・✦────⌞★⌟', `🎫 ${type.label} ouvert par <@${opener.id}> dans <#${channel.id}>.`);
  await sendTicketSupportAlert(guild, channel, opener.user, type);
  return channel;
}

async function closeTicket(channel, member) {
  const guild = channel.guild;
  const tickets = getTicketState(guild.id);
  const ticketInfo = tickets[channel.id];
  if (!ticketInfo) throw new Error('Ce salon nest pas un ticket connu.');
  if (!canManageTicket(member, ticketInfo)) throw new Error('Tu ne peux pas fermer ce ticket.');
  if (ticketInfo.closedAt) throw new Error('Ce ticket est deja ferme.');

  ticketInfo.closedAt = Date.now();
  await deliverTicketTranscript(guild, channel, ticketInfo, member);

  const ticketsCfg = getTicketModule(guild.id);
  await channel.setParent(ticketsCfg.closedCategoryId || null).catch(() => {});
  await channel.permissionOverwrites.edit(ticketInfo.ownerId, {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: false,
  }).catch(() => {});
  await channel.send({ embeds: [buildTicketClosedEmbed(guild, member.user)], components: buildTicketActionRows(true) }).catch(() => {});
  persist();
  await sendTicketLog(guild, ticketsCfg, '⌜★⌟────✦・Ticket ferme・✦────⌞★⌟', `🧯 <#${channel.id}> ferme par <@${member.id}>.`);
}

async function reopenTicket(channel, member) {
  const guild = channel.guild;
  const tickets = getTicketState(guild.id);
  const ticketInfo = tickets[channel.id];
  if (!ticketInfo) throw new Error('Ce salon nest pas un ticket connu.');
  if (!canModerateTicket(member, ticketInfo)) throw new Error('Tu ne peux pas rouvrir ce ticket.');
  if (!ticketInfo.closedAt) throw new Error('Ce ticket est deja ouvert.');

  ticketInfo.closedAt = null;
  const ticketsCfg = getTicketModule(guild.id);
  await channel.setParent(ticketsCfg.openCategoryId || null).catch(() => {});
  await channel.permissionOverwrites.edit(ticketInfo.ownerId, {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: true,
    AttachFiles: true,
    EmbedLinks: true,
  }).catch(() => {});
  await channel.send({ embeds: [buildTicketReopenEmbed(guild, member.user)], components: buildTicketActionRows(false) }).catch(() => {});
  persist();
  await sendTicketLog(guild, ticketsCfg, '⌜★⌟────✦・Ticket rouvert・✦────⌞★⌟', `✨ <#${channel.id}> rouvert par <@${member.id}>.`);
}

async function claimTicket(channel, member) {
  const guild = channel.guild;
  const tickets = getTicketState(guild.id);
  const ticketInfo = tickets[channel.id];
  if (!ticketInfo) throw new Error('Ce salon nest pas un ticket connu.');
  if (!canModerateTicket(member, ticketInfo)) throw new Error('Tu ne peux pas prendre ce ticket.');
  ticketInfo.claimedBy = member.id;
  persist();
  await channel.send({ embeds: [buildTicketClaimEmbed(guild, member.user)] }).catch(() => {});
  await sendTicketLog(guild, getTicketModule(guild.id), '⌜★⌟────✦・Ticket pris・✦────⌞★⌟', `🧸 <#${channel.id}> pris par <@${member.id}>.`);
}

function resolveTargetUser(message, token) {
  if (!token && message.mentions.users.size) return message.mentions.users.first();
  if (!token) return message.author;
  const id = token.replace(/[<@!>]/g, '');
  return message.client.users.cache.get(id) || null;
}

function buildPollEmbed(guild, poll) {
  const counts = poll.options.map((_, idx) => [...poll.votes.values()].filter(v => v === idx).length);
  const total = counts.reduce((a, b) => a + b, 0);
  return makeBotEmbed('info', guild, `${THEME.emoji.vote} Sondage`, clampStr(poll.question, 300), poll.options.map((opt, idx) => ({
    name: `${idx + 1}. ${clampStr(opt, 120)}`,
    value: `Votes: **${counts[idx]}**${total ? ` (${Math.round((counts[idx] / total) * 100)}%)` : ''}`,
    inline: true,
  })));
}

function buildSuggestionEmbed(guild, suggestion) {
  return makeBotEmbed('neutral', guild, `${THEME.emoji.idea} Suggestion`, clampStr(suggestion.content, 3000), [
    {
      name: 'Votes',
      value: `👍 ${suggestion.up.size} • 👎 ${suggestion.down.size}`,
      inline: false,
    },
  ]);
}

// Command: analyze / export
registerCommand('analyze', 1, async (message, args) => {
  const guild = message.guild;
  const data = exportServerStructure(guild);
  const json = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(json, 'utf8');
  const fileName = `structure-${guild.id}.json`;
  const attachment = new AttachmentBuilder(buffer, { name: fileName });
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('Analyse du serveur')
    .setDescription(`**Rôles**: ${data.roles.length}\n**Catégories**: ${data.categories.length}\n**Salons sans catégorie**: ${data.uncategorized.length}`)
    .setTimestamp();
  await message.reply({ embeds: [embed], files: [attachment] });
});
// alias export
commands['export'] = commands['analyze'];

// Command: import
registerCommand('import', 3, async (message, args) => {
  const flags = { dryRun: false, skipExisting: false, prefix: '', tolerant: true };
  // parse flags from args
  while (args.length > 0 && args[0].startsWith('--')) {
    const flag = args.shift();
    if (flag === '--dry-run') flags.dryRun = true;
    else if (flag === '--skip-existing') flags.skipExisting = true;
    else if (flag.startsWith('--prefix')) {
      const parts = flag.split('=');
      flags.prefix = parts[1] || args.shift() || '';
    } else if (flag === '--strict') flags.tolerant = false;
  }
  if (message.attachments.size === 0) {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Merci de joindre un fichier JSON contenant la structure du serveur.')] });
  }
  const attachment = message.attachments.first();
  try {
    const response = await fetch(attachment.url);
    const json = await response.json();
    const guild = message.guild;
    const summary = await importServerStructure(guild, json, flags);
    if (flags.dryRun) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setDescription(`Mode dry-run: **${summary.roles}** rôles, **${summary.categories}** catégories, **${summary.channels}** salons seraient créés.`)] });
    } else {
      const warnLines = summary.warnings.length > 0 ? '\n' + summary.warnings.join('\n') : '';
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Importation terminée: ${summary.rolesCreated} rôles, ${summary.categoriesCreated} catégories, ${summary.channelsCreated} salons créés.${warnLines}`)] });
    }
  } catch (err) {
    console.error(err);
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xff5555).setDescription('Échec de l\'importation. Vérifiez que le fichier est un JSON valide.')] });
  }
});

// Command: setlevel
registerCommand('setlevel', 3, async (message, args) => {
  if (args.length < 2) {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !setlevel @Rôle niveau')] });
  }
  const roleMention = args.shift();
  const levelStr = args.shift();
  const level = parseInt(levelStr, 10);
  if (isNaN(level) || level < 0) {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Le niveau doit être un nombre positif.')] });
  }
  const roleId = roleMention.replace(/<@&?(\d+)>/, '$1');
  const role = message.guild.roles.cache.get(roleId);
  if (!role) {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Rôle introuvable.')] });
  }
  setRoleLevel(message.guild.id, role.id, level);
  return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Le rôle **${role.name}** a été assigné au niveau **${level}**.`)] });
});

// Command: listlevels
registerCommand('listlevels', 1, async (message) => {
  const entries = listRoleLevels(message.guild);
  if (entries.length === 0) {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Aucun niveau de rôle configuré pour ce serveur.')] });
  }
  const lines = entries.map(e => `${e.name}: niveau ${e.level}`).join('\n');
  return message.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('Niveaux de rôles').setDescription(lines)] });
});

// Command: sendembed
registerCommand('sendembed', 1, async (message, args, rawArgs) => {
  if (args.length < 2) {
    return replyBot(message, 'warn', 'Utilisation', '!sendembed #salon <embedSpec>');
  }

  const [channelToken] = args;
  const channelId = parseChannelMention(channelToken);
  if (!channelId) return replyBot(message, 'warn', 'Salon invalide', 'Mentionne un salon avec `#salon`.');

  const channel = message.guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return replyBot(message, 'warn', 'Salon introuvable', 'Vérifie le salon cible.');
  if (!canSendEmbeds(channel, message.guild)) return replyBot(message, 'error', 'Permissions insuffisantes', "Je ne peux pas envoyer d'embed dans ce salon.");

  const spec = String(rawArgs || '').replace(/^\s*<#[0-9]+>\s*/, '');
  if (!spec.trim()) return replyBot(message, 'warn', 'Embed manquant', 'Ajoute un embedSpec après le salon.');

  const guildCfg = ensureGuildConfig(message.guild.id);
  const embedsCfg = guildCfg.modules.embeds;
  const built = buildEmbedsFromSpec(spec, {
    presets: embedsCfg.presets || {},
    defaultPreset: embedsCfg.defaultPreset || null,
  });
  if (built.error) return replyBot(message, 'error', "Impossible de parser l'embed", built.error);

  await channel.send({ embeds: built.embeds, allowedMentions: { parse: [] } });
  return replyBot(message, 'success', 'Message envoyé', 'Message envoyé ✅');
}, { wantsRaw: true });

registerCommand('editembed', 2, async (message, args, rawArgs) => {
  if (args.length < 2) return replyBot(message, 'warn', 'Utilisation', '!editembed <messageId|messageLink> <embedSpec>');

  const target = args[0];
  const link = parseMessageLink(target);
  let channel = message.channel;
  let messageId = target;

  if (link) {
    if (link.guildId !== message.guild.id) return replyBot(message, 'warn', 'Lien invalide', 'Le lien doit pointer sur ce serveur.');
    channel = message.guild.channels.cache.get(link.channelId);
    messageId = link.messageId;
  }

  if (!channel || !channel.isTextBased()) return replyBot(message, 'warn', 'Salon invalide', 'Impossible de récupérer ce message.');

  const targetMessage = await channel.messages.fetch(messageId).catch(() => null);
  if (!targetMessage) return replyBot(message, 'warn', 'Message introuvable', 'ID/lien incorrect.');
  if (targetMessage.author.id !== client.user.id) return replyBot(message, 'error', 'Refusé', 'Je peux éditer uniquement mes propres messages.');

  const spec = String(rawArgs || '').replace(/^\s*\S+\s*/, '');
  const guildCfg = ensureGuildConfig(message.guild.id);
  const embedsCfg = guildCfg.modules.embeds;
  const built = buildEmbedsFromSpec(spec, {
    presets: embedsCfg.presets || {},
    defaultPreset: embedsCfg.defaultPreset || null,
  });
  if (built.error) return replyBot(message, 'error', "Impossible de parser l'embed", built.error);

  await targetMessage.edit({ embeds: built.embeds, allowedMentions: { parse: [] } });
  return replyBot(message, 'success', 'Embed modifié', `Message ${targetMessage.id} modifié.`);
}, { wantsRaw: true });

registerCommand('embedpreset', 2, async (message, args, rawArgs) => {
  const sub = (args.shift() || '').toLowerCase();
  const guildCfg = ensureGuildConfig(message.guild.id);
  const embedsCfg = guildCfg.modules.embeds;
  embedsCfg.enabled = true;
  embedsCfg.presets = embedsCfg.presets || {};

  if (sub === 'set') {
    const name = (args.shift() || '').toLowerCase();
    if (!name) return replyBot(message, 'warn', 'Utilisation', '!embedpreset set <nom> || options...');
    const optionsRaw = String(rawArgs || '').replace(/^\s*set\s+\S+\s*\|\|?\s*/i, '');
    const options = parseOptions(optionsRaw);
    embedsCfg.presets[name] = {
      color: options.color,
      thumbnail: options.thumbnail,
      image: options.image,
      footer: options.footer,
      timestamp: parseBool(options.timestamp, null),
      author: options.author,
      authorIcon: options.authorIcon,
      authorUrl: options.authorUrl,
      url: options.url,
      fields: options.fields || [],
    };
    persist();
    return replyBot(message, 'success', 'Preset sauvegardé', `Preset **${name}** enregistré.`);
  }

  if (sub === 'show') {
    const name = (args.shift() || '').toLowerCase();
    const preset = embedsCfg.presets[name];
    if (!preset) return replyBot(message, 'warn', 'Introuvable', 'Preset absent.');
    return replyBot(message, 'info', `Preset ${name}`, '```json\n' + clampStr(JSON.stringify(preset, null, 2), 3800) + '\n```');
  }

  if (sub === 'list') {
    const names = Object.keys(embedsCfg.presets);
    if (!names.length) return replyBot(message, 'warn', 'Aucun preset', 'Crée-en avec `!embedpreset set`');
    return replyBot(message, 'info', 'Presets', names.join(', '));
  }

  if (sub === 'delete') {
    const name = (args.shift() || '').toLowerCase();
    if (!embedsCfg.presets[name]) return replyBot(message, 'warn', 'Introuvable', 'Preset absent.');
    delete embedsCfg.presets[name];
    if (embedsCfg.defaultPreset === name) embedsCfg.defaultPreset = null;
    persist();
    return replyBot(message, 'success', 'Preset supprimé', `Preset **${name}** supprimé.`);
  }

  if (sub === 'default') {
    const val = (args.shift() || '').toLowerCase();
    if (!val || val === 'off') {
      embedsCfg.defaultPreset = null;
      persist();
      return replyBot(message, 'success', 'Preset par défaut', 'Désactivé.');
    }
    if (!embedsCfg.presets[val]) return replyBot(message, 'warn', 'Introuvable', 'Preset absent.');
    embedsCfg.defaultPreset = val;
    persist();
    return replyBot(message, 'success', 'Preset par défaut', `Preset **${val}** défini par défaut.`);
  }

  return replyBot(message, 'warn', 'Utilisation', 'Sous-commandes: set, show, list, delete, default');
}, { wantsRaw: true });

/*
 * YouTube commands
 *
 * Commands to manage watched YouTube channels: add, remove and list.  When
 * adding a channel for the first time the bot records the most recent video
 * without sending a notification unless firstInstall is set to 'notify'.
 */
registerCommand('youtube', 1, async (message, args) => {
  const sub = args.shift();
  const guildCfg = ensureGuildConfig(message.guild.id);
  const ytCfg = guildCfg.modules.youtube;
  if (sub === 'add') {
    if (args.length < 2) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !youtube add <channelId ou @handle> #salon')] });
    }
    const rawInput = args.shift();
    const channelMention = args.shift();
    const announceId = channelMention.replace(/<#(\d+)>/, '$1');
    const resolved = await resolveYouTubeChannel(rawInput);
    if (!resolved) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription(`Chaîne YouTube introuvable pour **${rawInput}**. Vérifie l'ID (UCxxx) ou le handle (@nom).`)] });
    }
    const channelId = resolved.id;
    ytCfg.enabled = true;
    const exists = ytCfg.channels.some(c => c.id === channelId && c.announceChannelId === announceId);
    if (exists) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Cette chaîne YouTube est déjà configurée pour ce salon.')] });
    }
    ytCfg.channels.push({ id: channelId, announceChannelId: announceId });
    // Reset state so the next poll treats this as a fresh install and sends a notification
    delete state[message.guild.id].youtube[channelId];
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Chaîne YouTube **${resolved.title}** (\`${channelId}\`) ajoutée. Les notifications seront publiées dans <#${announceId}>.`)] });
  } else if (sub === 'remove') {
    if (args.length < 1) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !youtube remove <channelId>')] });
    }
    const channelId = args.shift();
    ytCfg.channels = ytCfg.channels.filter(c => c.id !== channelId);
    delete state[message.guild.id].youtube[channelId];
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Chaîne YouTube **${channelId}** supprimée.`)] });
  } else if (sub === 'list') {
    if (!ytCfg.channels || ytCfg.channels.length === 0) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Aucune chaîne YouTube suivie.')] });
    }
    const lines = ytCfg.channels.map(c => `• ${c.id} → <#${c.announceChannelId}>`).join('\n');
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('Chaînes YouTube suivies').setDescription(lines)] });
  } else {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Sous‑commandes: add, remove, list')] });
  }
});

/*
 * Shorts commands
 *
 * Commands to manage YouTube Shorts notifications separately from regular
 * videos.  Uses the same channel IDs but routes to a different announce
 * channel and only notifies for videos ≤60 seconds.
 */
registerCommand('shorts', 1, async (message, args) => {
  const sub = args.shift();
  const guildCfg = ensureGuildConfig(message.guild.id);
  const shCfg = guildCfg.modules.shorts;
  if (sub === 'add') {
    if (args.length < 2) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !shorts add <channelId ou @handle> #salon')] });
    }
    const rawInput = args.shift();
    const channelMention = args.shift();
    const announceId = channelMention.replace(/<#(\d+)>/, '$1');
    const resolved = await resolveYouTubeChannel(rawInput);
    if (!resolved) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription(`Chaîne YouTube introuvable pour **${rawInput}**. Vérifie l'ID (UCxxx) ou le handle (@nom).`)] });
    }
    const channelId = resolved.id;
    shCfg.enabled = true;
    const exists = shCfg.channels.some(c => c.id === channelId && c.announceChannelId === announceId);
    if (exists) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Cette chaîne est déjà configurée pour les Shorts dans ce salon.')] });
    }
    shCfg.channels.push({ id: channelId, announceChannelId: announceId });
    // Reset state so the next poll treats this as a fresh install and sends a notification
    delete state[message.guild.id].shorts[channelId];
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Shorts de **${resolved.title}** (\`${channelId}\`) ajoutés. Les notifications seront publiées dans <#${announceId}>.`)] });
  } else if (sub === 'remove') {
    if (args.length < 1) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !shorts remove <channelId>')] });
    }
    const channelId = args.shift();
    shCfg.channels = shCfg.channels.filter(c => c.id !== channelId);
    delete state[message.guild.id].shorts[channelId];
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Shorts de **${channelId}** supprimés.`)] });
  } else if (sub === 'list') {
    if (!shCfg.channels || shCfg.channels.length === 0) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Aucune chaîne YouTube suivie pour les Shorts.')] });
    }
    const lines = shCfg.channels.map(c => `• ${c.id} → <#${c.announceChannelId}>`).join('\n');
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('Chaînes YouTube suivies (Shorts)').setDescription(lines)] });
  } else {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Sous‑commandes: add, remove, list')] });
  }
});

/*
 * Twitch commands
 *
 * Commands to manage Twitch streamers: add, remove and list.  Streamers are
 * identified by their login names.  Each entry stores announcement channel
 * and status tracking information.  Configuring Twitch client credentials is
 * done via environment variables.
 */
registerCommand('twitch', 1, async (message, args) => {
  const sub = args.shift();
  const guildCfg = ensureGuildConfig(message.guild.id);
  const twCfg = guildCfg.modules.twitch;
  if (sub === 'add') {
    if (args.length < 2) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !twitch add <login> #salon')] });
    }
    const login = args.shift().toLowerCase();
    const channelMention = args.shift();
    const announceId = channelMention.replace(/<#(\d+)>/, '$1');
    twCfg.enabled = true;
    if (!twCfg.streamers[login]) twCfg.streamers[login] = { isLive: false, announceChannelId: announceId, onlineChecks: 0 };
    else twCfg.streamers[login].announceChannelId = announceId;
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Streamer **${login}** ajouté. Les notifications seront publiées dans <#${announceId}>.`)] });
  } else if (sub === 'remove') {
    if (args.length < 1) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !twitch remove <login>')] });
    }
    const login = args.shift().toLowerCase();
    delete twCfg.streamers[login];
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Streamer **${login}** supprimé.`)] });
  } else if (sub === 'list') {
    const keys = Object.keys(twCfg.streamers);
    if (keys.length === 0) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Aucun streamer suivi.')] });
    }
    const lines = keys.map(k => `• ${k} → <#${twCfg.streamers[k].announceChannelId}>`).join('\n');
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('Streamers Twitch suivis').setDescription(lines)] });
  } else {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Sous‑commandes: add, remove, list')] });
  }
});

/*
 * Backup commands
 *
 * Allows administrators to trigger backups immediately, set the backup
 * channel, schedule and retention.  Running !backup now performs a one‑off
 * export, !backup setchannel sets the destination, !backup schedule sets
 * daily or weekly backups, and !backup off disables the scheduler.
 */
registerCommand('backup', 3, async (message, args) => {
  const sub = args.shift();
  const guildCfg = ensureGuildConfig(message.guild.id);
  const backupsCfg = guildCfg.modules.backups;
  if (sub === 'now') {
    await performBackup(message.guild.id);
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('Sauvegarde effectuée.')] });
  } else if (sub === 'setchannel') {
    if (args.length < 1) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !backup setchannel #salon')] });
    const channelMention = args.shift();
    const channelId = channelMention.replace(/<#(\d+)>/, '$1');
    backupsCfg.enabled = true;
    backupsCfg.channelId = channelId;
    persist();
    scheduleBackups(message.guild.id);
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Salon de sauvegarde défini sur <#${channelId}>.`)] });
  } else if (sub === 'schedule') {
    if (args.length < 1) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !backup schedule daily|weekly')] });
    const freq = args.shift().toLowerCase();
    if (!['daily', 'weekly'].includes(freq)) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('La fréquence doit être daily ou weekly.')] });
    }
    backupsCfg.enabled = true;
    backupsCfg.schedule = freq;
    persist();
    scheduleBackups(message.guild.id);
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Sauvegarde automatique configurée (${freq}).`)] });
  } else if (sub === 'off') {
    backupsCfg.enabled = false;
    persist();
    if (backupIntervals[message.guild.id]) {
      clearInterval(backupIntervals[message.guild.id]);
      delete backupIntervals[message.guild.id];
    }
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('Sauvegarde automatique désactivée.')] });
  } else {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Sous‑commandes: now, setchannel, schedule, off')] });
  }
});

/*
 * Template commands
 */
registerCommand('template', 1, async (message, args, rawArgs) => {
  const sub = args.shift();
  const guildCfg = ensureGuildConfig(message.guild.id);
  const tplCfg = guildCfg.modules.templates;
  if (sub === 'save') {
    // Usage: !template save nom Titre | Contenu
    if (args.length < 2) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !template save <nom> Titre | Contenu')] });
    }
    const name = args.shift().toLowerCase();
    const text = String(rawArgs || '').replace(/^\s*save\s+\S+\s*/i, '');
    const parts = text.split('|');
    const title = parts[0].trim();
    const content = parts[1] ? parts[1].trim() : '';
    tplCfg.enabled = true;
    tplCfg.items[name] = { title, content };
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Template **${name}** sauvegardé.`)] });
  } else if (sub === 'send') {
    // Usage: !template send nom #salon
    if (args.length < 2) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !template send <nom> #salon')] });
    }
    const name = args.shift().toLowerCase();
    const channelMention = args.shift();
    const channelId = channelMention.replace(/<#(\d+)>/, '$1');
    const tpl = tplCfg.items[name];
    if (!tpl) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xff5555).setDescription('Template introuvable.')] });
    }
    const channel = message.guild.channels.cache.get(channelId);
    if (!channel) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Salon introuvable.')] });
    }
    const title = substituteTemplate(tpl.title, message.guild, message.member, message.channel);
    const content = substituteTemplate(tpl.content, message.guild, message.member, message.channel);
    const embed = new EmbedBuilder().setColor(0x1abc9c);
    if (title) embed.setTitle(title);
    if (content) embed.setDescription(content);
    await channel.send({ embeds: [embed] });
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('Template envoyé.')] });
  } else if (sub === 'list') {
    const names = Object.keys(tplCfg.items);
    if (names.length === 0) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Aucun template enregistré.')] });
    }
    const lines = names.join(', ');
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('Templates disponibles').setDescription(lines)] });
  } else if (sub === 'show') {
    if (args.length < 1) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !template show <nom>')] });
    const name = args.shift().toLowerCase();
    const tpl = tplCfg.items[name];
    if (!tpl) return message.reply({ embeds: [new EmbedBuilder().setColor(0xff5555).setDescription('Template introuvable.')] });
    const title = substituteTemplate(tpl.title, message.guild, message.member, message.channel);
    const content = substituteTemplate(tpl.content, message.guild, message.member, message.channel);
    const embed = new EmbedBuilder().setColor(0x1abc9c);
    if (title) embed.setTitle(title);
    if (content) embed.setDescription(content);
    return message.reply({ embeds: [embed] });
  } else if (sub === 'remove') {
    if (args.length < 1) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !template remove <nom>')] });
    const name = args.shift().toLowerCase();
    delete tplCfg.items[name];
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Template **${name}** supprimé.`)] });
  } else {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Sous‑commandes: save, send, list, show, remove')] });
  }
});

/*
 * Welcome commands
 */
registerCommand('welcome', 1, async (message, args, rawArgs) => {
  const sub = args.shift();
  const guildCfg = ensureGuildConfig(message.guild.id);
  const wCfg = guildCfg.modules.welcome;
  if (sub === 'setchannel') {
    if (args.length < 1) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !welcome setchannel #salon')] });
    const channelMention = args.shift();
    const channelId = channelMention.replace(/<#(\d+)>/, '$1');
    wCfg.enabled = true;
    wCfg.channelId = channelId;
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Salon d’accueil défini sur <#${channelId}>.`)] });
  } else if (sub === 'message') {
    // Usage: !welcome message "texte"
    const msg = String(rawArgs || '').replace(/^\s*message\s*/i, '').replace(/^"|"$/g, '');
    wCfg.message = msg;
    wCfg.enabled = true;
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('Message de bienvenue mis à jour.')] });
  } else if (sub === 'off') {
    wCfg.enabled = false;
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('Message de bienvenue désactivé.')] });
  } else if (sub === 'test') {
    // Simulate a join event
    const tempMember = message.member;
    await handleGuildMemberAdd(tempMember);
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('Message de bienvenue envoyé en test.')] });
  } else {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Sous‑commandes: setchannel, message, off, test')] });
  }
});

/*
 * Rules commands
 */
registerCommand('rules', 1, async (message, args, rawArgs) => {
  const sub = args.shift();
  const guildCfg = ensureGuildConfig(message.guild.id);
  const rulesCfg = guildCfg.modules.rules;
  if (!sub) {
    // Post rules in current channel
    if (!rulesCfg.enabled) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Aucune règle définie.')] });
    const embed = new EmbedBuilder().setColor(0xf1c40f).setTitle(rulesCfg.title).setDescription(rulesCfg.content);
    await message.channel.send({ embeds: [embed] });
    return;
  }
  if (sub === 'set') {
    // Usage: !rules set Titre | Contenu
    const text = String(rawArgs || '').replace(/^\s*set\s*/i, '');
    const parts = text.split('|');
    const title = parts[0].trim();
    const content = parts[1] ? parts[1].trim() : '';
    rulesCfg.enabled = true;
    rulesCfg.title = title;
    rulesCfg.content = content;
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('Règles mises à jour.')] });
  } else if (sub === 'post') {
    if (args.length < 1) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !rules post #salon')] });
    const channelMention = args.shift();
    const channelId = channelMention.replace(/<#(\d+)>/, '$1');
    const channel = message.guild.channels.cache.get(channelId);
    if (!channel) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Salon introuvable.')] });
    const embed = new EmbedBuilder().setColor(0xf1c40f).setTitle(rulesCfg.title).setDescription(rulesCfg.content);
    await channel.send({ embeds: [embed] });
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription('Règles postées.')] });
  } else {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Sous‑commandes: set, post')] });
  }
});

/*
 * Feature toggles commands
 */
registerCommand('feature', 3, async (message, args) => {
  const sub = args.shift();
  const guildCfg = ensureGuildConfig(message.guild.id);
  if (sub === 'list') {
    const toggles = Object.entries(guildCfg.featureToggles)
      .map(([k, v]) => `${k}: ${v ? 'ON' : 'OFF'}`)
      .join('\n');
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('Modules').setDescription(toggles)] });
  } else if (sub === 'enable' || sub === 'disable') {
    if (args.length < 1) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !feature enable|disable <module>')] });
    const mod = args.shift().toLowerCase();
    if (!(mod in guildCfg.featureToggles)) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Module inconnu.')] });
    guildCfg.featureToggles[mod] = sub === 'enable';
    // If disabling, also disable underlying module config
    if (!guildCfg.featureToggles[mod]) {
      if (guildCfg.modules[mod]) guildCfg.modules[mod].enabled = false;
    }
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Module **${mod}** ${sub === 'enable' ? 'activé' : 'désactivé'}.`)] });
  } else {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Sous‑commandes: list, enable, disable')] });
  }
});

registerCommand('autopublish', 2, async (message, args) => {
  const guildCfg = ensureGuildConfig(message.guild.id);
  const autoCfg = guildCfg.modules.autopublish;
  const sub = (args.shift() || 'status').toLowerCase();

  if (sub === 'status') {
    const active = moduleEnabled(guildCfg, 'autopublish') && autoCfg.enabled;
    return replyBot(
      message,
      active ? 'success' : 'info',
      'Auto Publish',
      active
        ? 'Activé pour tous les salons Announcement où le bot peut publier.'
        : 'Désactivé. Active avec `!autopublish on`.',
      [
        { name: 'Feature toggle', value: guildCfg.featureToggles.autopublish ? 'ON' : 'OFF', inline: true },
        { name: 'Module', value: autoCfg.enabled ? 'ON' : 'OFF', inline: true },
        { name: 'Limite', value: `${AUTOPUBLISH_MAX_PER_HOUR} publications / heure / serveur`, inline: false },
      ],
    );
  }

  if (sub === 'on') {
    guildCfg.featureToggles.autopublish = true;
    autoCfg.enabled = true;
    persist();
    return replyBot(message, 'success', 'Auto Publish activé', 'Les nouveaux messages des salons Announcement seront publiés automatiquement.');
  }

  if (sub === 'off') {
    autoCfg.enabled = false;
    persist();
    return replyBot(message, 'success', 'Auto Publish désactivé', 'Les salons Announcement ne seront plus publiés automatiquement.');
  }

  return replyBot(message, 'warn', 'Utilisation', '`!autopublish on`, `!autopublish off`, `!autopublish status`');
});

registerCommand('ticketpanel', 2, async (message) => {
  const guildCfg = ensureGuildConfig(message.guild.id);
  if (!moduleEnabled(guildCfg, 'tickets') || !guildCfg.modules.tickets.enabled) {
    return replyBot(message, 'warn', 'Module tickets desactive', 'Active-le avant de publier le panel.');
  }
  const ticketsCfg = guildCfg.modules.tickets;
  const targetChannel = message.guild.channels.cache.get(ticketsCfg.panelChannelId) || message.channel;
  if (!targetChannel || !targetChannel.isTextBased()) {
    return replyBot(message, 'error', 'Salon invalide', 'Impossible de publier le panel tickets.');
  }
  const posted = await targetChannel.send({
    embeds: [buildTicketPanelEmbed(message.guild)],
    components: buildTicketPanelComponents(),
  });
  ticketsCfg.panelMessageId = posted.id;
  persist();
  return replyBot(message, 'success', 'Panel tickets publie', `Le panel a ete envoye dans <#${targetChannel.id}>.`);
});

registerCommand('ticket', 0, async (message, args) => {
  const guildCfg = ensureGuildConfig(message.guild.id);
  if (!moduleEnabled(guildCfg, 'tickets') || !guildCfg.modules.tickets.enabled) {
    return replyBot(message, 'warn', 'Module tickets desactive', 'Active avec `!feature enable tickets`.');
  }
  const sub = (args.shift() || 'status').toLowerCase();
  const tickets = getTicketState(message.guild.id);
  const ticketInfo = tickets[message.channel.id];

  if (sub === 'status') {
    if (!ticketInfo) return replyBot(message, 'info', 'Tickets', 'Panel: utilise `!ticketpanel` pour republier le panneau.');
    return replyBot(message, 'info', 'Ticket', undefined, [
      { name: 'Type', value: ticketInfo.typeId, inline: true },
      { name: 'Createur', value: `<@${ticketInfo.ownerId}>`, inline: true },
      { name: 'Etat', value: ticketInfo.closedAt ? 'ferme' : 'ouvert', inline: true },
      { name: 'Pris par', value: ticketInfo.claimedBy ? `<@${ticketInfo.claimedBy}>` : 'personne', inline: true },
    ]);
  }

  if (!ticketInfo) return replyBot(message, 'warn', 'Hors ticket', 'Cette commande doit etre utilisee dans un salon ticket.');

  if (sub === 'close') {
    try {
      await closeTicket(message.channel, message.member);
      return;
    } catch (err) {
      return replyBot(message, 'error', 'Impossible de fermer', err.message);
    }
  }

  if (sub === 'reopen') {
    try {
      await reopenTicket(message.channel, message.member);
      return;
    } catch (err) {
      return replyBot(message, 'error', 'Impossible de rouvrir', err.message);
    }
  }

  if (sub === 'claim') {
    try {
      await claimTicket(message.channel, message.member);
      return;
    } catch (err) {
      return replyBot(message, 'error', 'Impossible de prendre', err.message);
    }
  }

  return replyBot(message, 'warn', 'Utilisation', '`!ticket status`, `!ticket close`, `!ticket claim`, `!ticket reopen`');
});

registerCommand('ping', 0, async (message) => {
  const guildCfg = ensureGuildConfig(message.guild.id);
  if (!moduleEnabled(guildCfg, 'utility')) {
    return replyBot(message, 'warn', 'Module utility désactivé', 'Active avec `!feature enable utility`.');
  }
  const sent = await message.reply({ embeds: [makeBotEmbed('info', message.guild, 'Pong...', 'Mesure en cours...')] });
  const latency = sent.createdTimestamp - message.createdTimestamp;
  return sent.edit({ embeds: [makeBotEmbed('success', message.guild, '🏓 Pong', undefined, [
    { name: 'Latence message', value: `${latency} ms`, inline: true },
    { name: 'Ping WebSocket', value: `${Math.round(client.ws.ping)} ms`, inline: true },
  ])] });
});

registerCommand('avatar', 0, async (message, args) => {
  const guildCfg = ensureGuildConfig(message.guild.id);
  if (!moduleEnabled(guildCfg, 'utility')) {
    return replyBot(message, 'warn', 'Module utility désactivé', 'Active avec `!feature enable utility`.');
  }
  const user = resolveTargetUser(message, args[0]) || message.author;
  const url = user.displayAvatarURL({ size: 4096, extension: 'png' });
  return message.reply({ embeds: [makeBotEmbed('info', message.guild, `Avatar de ${user.tag}`, `[Ouvrir en HD](${url})`).setImage(url)] });
});

registerCommand('userinfo', 0, async (message, args) => {
  const guildCfg = ensureGuildConfig(message.guild.id);
  if (!moduleEnabled(guildCfg, 'utility')) {
    return replyBot(message, 'warn', 'Module utility désactivé', 'Active avec `!feature enable utility`.');
  }
  const user = resolveTargetUser(message, args[0]) || message.author;
  const member = await message.guild.members.fetch(user.id).catch(() => null);
  const roles = member ? member.roles.cache.filter(r => r.id !== message.guild.id).map(r => `<@&${r.id}>`).slice(0, 20) : [];
  return replyBot(message, 'info', `Utilisateur: ${user.tag}`, undefined, [
    { name: 'ID', value: user.id, inline: true },
    { name: 'Compte créé le', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`, inline: true },
    { name: 'A rejoint le', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : 'N/A', inline: true },
    { name: 'Rôles', value: roles.join(', ') || 'Aucun', inline: false },
  ]);
});

registerCommand('serverinfo', 0, async (message) => {
  const guildCfg = ensureGuildConfig(message.guild.id);
  if (!moduleEnabled(guildCfg, 'utility')) {
    return replyBot(message, 'warn', 'Module utility désactivé', 'Active avec `!feature enable utility`.');
  }
  const g = message.guild;
  const text = g.channels.cache.filter(c => c.isTextBased()).size;
  const voice = g.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size;
  const category = g.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size;
  return replyBot(message, 'info', `Infos serveur: ${g.name}`, undefined, [
    { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
    { name: 'Membres', value: `${g.memberCount}`, inline: true },
    { name: 'Rôles', value: `${g.roles.cache.size}`, inline: true },
    { name: 'Salons', value: `Texte: ${text}\nVocal: ${voice}\nCatégories: ${category}`, inline: false },
  ]);
});

registerCommand('poll', 0, async (message, args) => {
  const guildCfg = ensureGuildConfig(message.guild.id);
  if (!moduleEnabled(guildCfg, 'polls')) {
    return replyBot(message, 'warn', 'Module polls désactivé', 'Active avec `!feature enable polls`.');
  }
  const raw = args.join(' ').split('|').map(s => s.trim()).filter(Boolean);
  if (raw.length < 3) return replyBot(message, 'warn', 'Utilisation', '`!poll Question | Option 1 | Option 2` (2 à 5 options).');
  const question = raw.shift();
  const options = raw.slice(0, 5);
  if (options.length < 2) return replyBot(message, 'warn', 'Sondage invalide', 'Il faut au moins 2 options.');
  const pollId = shortId();
  const poll = {
    messageId: null,
    channelId: message.channel.id,
    guildId: message.guild.id,
    question,
    options,
    votes: new Map(),
    createdAt: Date.now(),
  };
  const row = new ActionRowBuilder().addComponents(options.map((opt, idx) => new ButtonBuilder()
    .setCustomId(`poll:${pollId}:${idx}`)
    .setLabel(`${idx + 1}`)
    .setStyle(ButtonStyle.Primary)));
  const msg = await message.reply({ embeds: [buildPollEmbed(message.guild, poll)], components: [row] });
  poll.messageId = msg.id;
  interactive.polls.set(pollId, poll);
});

registerCommand('suggest', 0, async (message, args) => {
  const guildCfg = ensureGuildConfig(message.guild.id);
  if (!moduleEnabled(guildCfg, 'suggestions')) {
    return replyBot(message, 'warn', 'Module suggestions désactivé', 'Active avec `!feature enable suggestions`.');
  }
  const sub = (args[0] || '').toLowerCase();
  const userLevel = getUserLevel(message.member);
  if (sub === 'set') {
    if (userLevel < 2) return replyBot(message, 'error', 'Permission refusée', 'Niveau 2 requis.');
    const channelId = (args[1] || '').replace(/<#(\d+)>/, '$1');
    const channel = message.guild.channels.cache.get(channelId);
    if (!channel) return replyBot(message, 'warn', 'Salon invalide', 'Utilise `!suggest set #salon`.');
    guildCfg.modules.suggestions.enabled = true;
    guildCfg.modules.suggestions.channelId = channelId;
    persist();
    return replyBot(message, 'success', 'Suggestions configurées', `Salon défini sur <#${channelId}>.`);
  }
  if (sub === 'off') {
    if (userLevel < 2) return replyBot(message, 'error', 'Permission refusée', 'Niveau 2 requis.');
    guildCfg.modules.suggestions.enabled = false;
    guildCfg.modules.suggestions.channelId = null;
    persist();
    return replyBot(message, 'success', 'Suggestions désactivées', 'Le module suggestions est coupé.');
  }
  if (!guildCfg.modules.suggestions.enabled || !guildCfg.modules.suggestions.channelId) {
    return replyBot(message, 'warn', 'Suggestions non configurées', 'Configure un salon avec `!suggest set #salon`.');
  }
  const content = args.join(' ').trim();
  if (!content) return replyBot(message, 'warn', 'Utilisation', '`!suggest Mon idée...`');
  const targetChannel = message.guild.channels.cache.get(guildCfg.modules.suggestions.channelId);
  if (!targetChannel) return replyBot(message, 'error', 'Salon introuvable', 'Reconfigure avec `!suggest set #salon`.');
  const sugId = shortId();
  const sug = {
    messageId: null,
    channelId: targetChannel.id,
    guildId: message.guild.id,
    content: `${content}\n\n— proposé par <@${message.author.id}>`,
    up: new Set(),
    down: new Set(),
    createdAt: Date.now(),
  };
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`suggest:${sugId}:up`).setEmoji('👍').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`suggest:${sugId}:down`).setEmoji('👎').setStyle(ButtonStyle.Danger),
  );
  const posted = await targetChannel.send({ embeds: [buildSuggestionEmbed(message.guild, sug)], components: [row] });
  sug.messageId = posted.id;
  interactive.suggestions.set(sugId, sug);
  return replyBot(message, 'success', 'Suggestion envoyée', `Postée dans <#${targetChannel.id}>.`);
});

/*
 * Permission diagnostics command
 */
registerCommand('permissions', 1, async (message, args) => {
  const sub = args.shift();
  if (sub === 'check') {
    const target = args.shift();
    if (!target) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !permissions check #salon|import')] });
    if (target === 'import') {
      // Check manage roles/salons/permissions
      const perms = message.guild.members.me.permissions;
      const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle('Permissions requises pour import')
        .addFields(
          { name: 'Gérer rôles', value: perms.has(PermissionsBitField.Flags.ManageRoles) ? '✅' : '❌' },
          { name: 'Gérer salons', value: perms.has(PermissionsBitField.Flags.ManageChannels) ? '✅' : '❌' },
          { name: 'Gérer permissions de salons', value: perms.has(PermissionsBitField.Flags.ManageChannels) ? '✅' : '❌' },
        );
      return message.reply({ embeds: [embed] });
    } else {
      // Channel check
      const channelId = target.replace(/<#(\d+)>/, '$1');
      const channel = message.guild.channels.cache.get(channelId);
      if (!channel) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Salon introuvable.')] });
      const perms = channel.permissionsFor(message.guild.members.me);
      const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle(`Permissions pour #${channel.name}`)
        .addFields(
          { name: 'Voir le salon', value: perms.has(PermissionsBitField.Flags.ViewChannel) ? '✅' : '❌' },
          { name: 'Envoyer des messages', value: perms.has(PermissionsBitField.Flags.SendMessages) ? '✅' : '❌' },
          { name: 'Envoyer des embeds', value: perms.has(PermissionsBitField.Flags.EmbedLinks) ? '✅' : '❌' },
          { name: 'Joindre des fichiers', value: perms.has(PermissionsBitField.Flags.AttachFiles) ? '✅' : '❌' },
        );
      return message.reply({ embeds: [embed] });
    }
  } else {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Sous‑commandes: check')] });
  }
});

/*
 * Configuration diagnostic command
 */
registerCommand('config', 1, async (message, args) => {
  const sub = args.shift();
  if (sub === 'show') {
    const guildCfg = ensureGuildConfig(message.guild.id);
    const fields = [];
    fields.push({ name: 'Modules activés', value: Object.keys(guildCfg.featureToggles).filter(k => guildCfg.featureToggles[k]).join(', ') || 'Aucun' });
    fields.push({ name: 'YouTube', value: guildCfg.modules.youtube.enabled ? guildCfg.modules.youtube.channels.length + ' chaînes' : 'désactivé' });
    fields.push({ name: 'Shorts', value: guildCfg.modules.shorts.enabled ? guildCfg.modules.shorts.channels.length + ' chaînes' : 'désactivé' });
    fields.push({ name: 'Twitch', value: guildCfg.modules.twitch.enabled ? Object.keys(guildCfg.modules.twitch.streamers).length + ' streamers' : 'désactivé' });
    fields.push({ name: 'Auto Publish', value: guildCfg.modules.autopublish.enabled ? 'activé' : 'désactivé' });
    fields.push({ name: 'Tickets', value: guildCfg.modules.tickets.enabled ? `<#${guildCfg.modules.tickets.panelChannelId}>` : 'désactivé' });
    fields.push({ name: 'Logs', value: guildCfg.modules.logs.enabled ? `<#${guildCfg.modules.logs.channelId}>` : 'désactivé' });
    fields.push({ name: 'Backups', value: guildCfg.modules.backups.enabled ? (guildCfg.modules.backups.schedule || 'manuelle') : 'désactivé' });
    const embed = new EmbedBuilder().setColor(0x2980b9).setTitle('Configuration du serveur').addFields(fields).setTimestamp();
    return message.reply({ embeds: [embed] });
  } else {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Sous‑commandes: show')] });
  }
});

/*
 * Logs commands
 */
registerCommand('setlog', 3, async (message, args) => {
  if (args.length < 1) return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !setlog #salon')] });
  const channelMention = args.shift();
  const channelId = channelMention.replace(/<#(\d+)>/, '$1');
  const guildCfg = ensureGuildConfig(message.guild.id);
  const logsCfg = guildCfg.modules.logs;
  logsCfg.enabled = true;
  logsCfg.channelId = channelId;
  persist();
  return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Salon des logs défini sur <#${channelId}>. Les logs sont activés ✅`)] });
});

/*
 * Status command
 */
registerCommand('status', 1, async (message, args) => {
  const verbose = args[0] === 'verbose';
  const guildCfg = ensureGuildConfig(message.guild.id);
  const embed = new EmbedBuilder().setColor(0x34495e).setTitle('Statut du bot');
  embed.addFields(
    { name: 'Uptime', value: `<t:${Math.floor(botStartedAt / 1000)}:R>` },
    { name: 'Latency', value: `${Math.round(client.ws.ping)} ms` },
    { name: 'YouTube', value: guildCfg.featureToggles.youtube ? `${guildCfg.modules.youtube.channels.length} chaînes` : 'OFF' },
    { name: 'Shorts', value: guildCfg.featureToggles.shorts ? `${guildCfg.modules.shorts.channels.length} chaînes` : 'OFF' },
    { name: 'Twitch', value: guildCfg.featureToggles.twitch ? `${Object.keys(guildCfg.modules.twitch.streamers).length} streamers` : 'OFF' },
    { name: 'Auto Publish', value: guildCfg.featureToggles.autopublish ? (guildCfg.modules.autopublish.enabled ? 'ON' : 'configuré OFF') : 'OFF' },
    { name: 'Tickets', value: guildCfg.featureToggles.tickets ? (guildCfg.modules.tickets.enabled ? 'ON' : 'configuré OFF') : 'OFF' },
    { name: 'Backups', value: guildCfg.featureToggles.backups ? (guildCfg.modules.backups.schedule || 'manuel') : 'OFF' },
    { name: 'Logs', value: guildCfg.featureToggles.logs ? (guildCfg.modules.logs.channelId ? `<#${guildCfg.modules.logs.channelId}>` : 'non configuré') : 'OFF' },
  );
  if (verbose) {
    embed.addFields(
      { name: 'Chaînes YouTube suivies', value: guildCfg.modules.youtube.channels.map(c => c.id).join(', ') || 'aucune' },
      { name: 'Streamers Twitch suivis', value: Object.keys(guildCfg.modules.twitch.streamers).join(', ') || 'aucun' },
      { name: 'Cooldown YouTube', value: `${guildCfg.modules.youtube.cooldown / 1000}s` },
      { name: 'Cooldown Twitch', value: `${guildCfg.modules.twitch.cooldown / 1000}s` },
      { name: 'Limite Auto Publish', value: `${AUTOPUBLISH_MAX_PER_HOUR} / heure / serveur` },
      { name: 'Panel tickets', value: guildCfg.modules.tickets.panelChannelId ? `<#${guildCfg.modules.tickets.panelChannelId}>` : 'non configure' },
      { name: 'Version export', value: '1' },
    );
  }
  return message.reply({ embeds: [embed] });
});

/*
 * Reset configuration command
 */
registerCommand('resetconfig', 3, async (message) => {
  config[message.guild.id] = defaultGuildConfig();
  config[message.guild.id] = applyGuildPreset(message.guild.id, config[message.guild.id]);
  state[message.guild.id] = { youtube: {}, twitch: {}, shorts: {}, tickets: {} };
  persist();
  return message.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription('Configuration réinitialisée. Toutes les listes et paramètres ont été effacés.')] });
});

/*
 * Help command
 *
 * Generates a dynamic help listing based on the user’s permission level and
 * the currently enabled modules.  Each command includes a brief syntax
 * description and the required permission level.  For detailed help
 * invocation use !help <commande>.
 */

registerCommand('opsreload', 3, async (message) => {
  opsMap = loadOpsMap(OPS_PATH);
  await message.reply({ embeds: [new EmbedBuilder().setTitle('Ops reloaded').setDescription('ops.map rechargé.')] });
});

registerCommand('patch', 3, async (message, args) => {
  const guild = message.guild;
  const sub = (args[0] || '').toLowerCase();

  if (!sub || sub === 'help') {
    const txt = [
      '**Patch system**',
      '`!patch export` → génère un template .sawa',
      '`!patch plan` + fichier .sawa → dry-run + code de confirmation',
      '`!patch apply <CODE> [--allow-deletes]` → applique',
      '`!patch cancel` → annule le patch en attente',
    ].join('\n');
    return message.reply({ embeds: [new EmbedBuilder().setTitle('Patch Help').setDescription(txt)] });
  }

  if (sub === 'export') {
    const template = buildTemplateForGuild(guild);
    const buf = Buffer.from(template, 'utf8');
    const att = new AttachmentBuilder(buf, { name: `patch-template-${guild.id}.sawa` });
    return message.reply({
      embeds: [new EmbedBuilder().setTitle('Patch Template').setDescription('Télécharge, modifie, puis envoie avec `!patch plan`.')],
      files: [att],
    });
  }

  if (sub === 'cancel') {
    pendingPatches.delete(guild.id);
    return message.reply({ embeds: [new EmbedBuilder().setTitle('Patch annulé').setDescription('Aucun patch en attente.')] });
  }

  if (sub === 'plan') {
    const attachment = message.attachments.first();
    if (!attachment) {
      return message.reply({ embeds: [new EmbedBuilder().setTitle('Erreur').setDescription('Ajoute ton fichier `.sawa` en pièce jointe.')] });
    }

    const res = await fetch(attachment.url);
    const text = await res.text();

    const { actions, errors } = parsePatchScript(text, opsMap, { maxActions: PATCH_MAX_ACTIONS });
    if (errors.length) {
      const errTxt = errors.slice(0, 15).map(e => `• ${e}`).join('\n');
      return message.reply({ embeds: [new EmbedBuilder().setTitle('Patch invalide').setDescription(errTxt)] });
    }

    const hasDeletes = actions.some(a => a.handler === 'channel.delete' || a.handler === 'role.delete');
    const code = makeConfirmCode();

    pendingPatches.set(guild.id, {
      code,
      actions,
      createdAt: Date.now(),
      hasDeletes,
    });

    const summary = buildPlanSummary(actions);
    const warn = hasDeletes ? '\n\n⚠️ Ce patch contient des suppressions (delete). Pour autoriser: `!patch apply <CODE> --allow-deletes`' : '';
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Patch PLAN (dry-run)')
          .setDescription(`${summary}\n\n**CONFIRM CODE:** \`${code}\`${warn}`)
          .setFooter({ text: `Expire dans ${Math.floor(PATCH_CONFIRM_TTL_MS / 60000)} min` }),
      ],
    });
  }

  if (sub === 'apply') {
    const code = (args[1] || '').toUpperCase();
    const allowDeletes = args.includes('--allow-deletes') || PATCH_ALLOW_DELETES_DEFAULT;

    const pending = pendingPatches.get(guild.id);
    if (!pending) {
      return message.reply({ embeds: [new EmbedBuilder().setTitle('Erreur').setDescription('Aucun patch en attente. Fais `!patch plan` d’abord.')] });
    }

    if (Date.now() - pending.createdAt > PATCH_CONFIRM_TTL_MS) {
      pendingPatches.delete(guild.id);
      return message.reply({ embeds: [new EmbedBuilder().setTitle('Expiré').setDescription('Le patch a expiré. Refais `!patch plan`.')] });
    }

    if (pending.code !== code) {
      return message.reply({ embeds: [new EmbedBuilder().setTitle('Code invalide').setDescription('Mauvais confirm code.')] });
    }

    if (pending.hasDeletes && !allowDeletes) {
      return message.reply({
        embeds: [new EmbedBuilder().setTitle('Suppression bloquée').setDescription('Ce patch contient des delete. Relance avec `--allow-deletes`.')],
      });
    }

    const reason = `Patch apply by ${message.author.tag}`;
    const results = await applyActions(guild, pending.actions, { reason });

    pendingPatches.delete(guild.id);

    const ok = results.filter(r => r.ok).length;
    const ko = results.filter(r => !r.ok).length;

    const firstErrors = results.filter(r => !r.ok).slice(0, 10).map(r => `• L${r.line} ${r.handler}: ${r.error}`).join('\n');
    const desc = `✅ Réussites: **${ok}**\n❌ Échecs: **${ko}**${firstErrors ? `\n\n**Erreurs (extrait)**\n${firstErrors}` : ''}`;

    return message.reply({ embeds: [new EmbedBuilder().setTitle('Patch APPLY terminé').setDescription(desc)] });
  }

  return message.reply({ embeds: [new EmbedBuilder().setTitle('Erreur').setDescription('Sous-commande inconnue. `!patch help`')] });
});

function buildHelpCategoryEmbed(category, guild, userLevel, guildCfg) {
  const catalog = {
    all: ['help', 'ping', 'avatar', 'userinfo', 'serverinfo', 'youtube', 'shorts', 'twitch', 'autopublish', 'ticketpanel', 'ticket', 'backup', 'template', 'welcome', 'rules', 'sendembed', 'editembed', 'embedpreset', 'feature', 'setlog', 'status', 'poll', 'suggest', 'analyze', 'import', 'export', 'setlevel', 'listlevels', 'permissions', 'config', 'resetconfig', 'patch'],
    core: ['help', 'status', 'config', 'feature', 'setlevel', 'listlevels', 'permissions', 'resetconfig'],
    notifs: ['youtube', 'shorts', 'twitch', 'autopublish', 'ticketpanel', 'ticket', 'welcome', 'setlog'],
    patch: ['patch', 'analyze', 'import', 'export', 'backup', 'template', 'rules'],
    outils: ['ping', 'avatar', 'userinfo', 'serverinfo', 'poll', 'suggest', 'sendembed', 'editembed', 'embedpreset'],
    social: ['welcome', 'rules', 'suggest'],
  };
  const cmds = catalog[category] || catalog.all;
  const lines = cmds
    .filter((name) => commands[name] && commands[name].level <= userLevel)
    .filter((name) => {
      const modMap = {
        youtube: 'youtube', shorts: 'shorts', twitch: 'twitch', autopublish: 'autopublish', ticketpanel: 'tickets', ticket: 'tickets', backup: 'backups', template: 'templates', welcome: 'welcome',
        rules: 'rules', setlog: 'logs', poll: 'polls', suggest: 'suggestions', ping: 'utility', avatar: 'utility',
        userinfo: 'utility', serverinfo: 'utility', sendembed: 'embeds', editembed: 'embeds', embedpreset: 'embeds',
      };
      const mod = modMap[name];
      return !mod || moduleEnabled(guildCfg, mod);
    })
    .map(name => `• **${PREFIX}${name}**`);
  return makeBotEmbed('info', guild, `${THEME.emoji.list} Aide (${category})`, lines.join('\n') || 'Aucune commande visible.');
}

registerCommand('help', 0, async (message, args) => {
  const userLevel = getUserLevel(message.member);
  const guildCfg = ensureGuildConfig(message.guild.id);
  const embed = makeBotEmbed('info', message.guild, 'Aide – Commandes disponibles');
  if (args.length === 0) {
    embed.setDescription('Choisis une catégorie avec les boutons.\nOu tape `!help <commande>` pour le détail.');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`help:all:${message.author.id}`).setLabel('Tout').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`help:core:${message.author.id}`).setLabel('Core').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`help:notifs:${message.author.id}`).setLabel('Notifs').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`help:patch:${message.author.id}`).setLabel('Patch').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`help:outils:${message.author.id}`).setLabel('Outils').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`help:social:${message.author.id}`).setLabel('Social').setStyle(ButtonStyle.Secondary),
    );
    return message.reply({ embeds: [buildHelpCategoryEmbed('all', message.guild, userLevel, guildCfg)], components: [row, row2] });
  } else {
    const cmdName = args.shift().toLowerCase();
    const cmd = commands[cmdName];
    if (!cmd || cmd.level > userLevel) return message.reply({ embeds: [new EmbedBuilder().setColor(0xff5555).setDescription('Commande inconnue ou niveau insuffisant.')] });
    embed.setTitle(`Aide – ${PREFIX}${cmdName}`);
    let desc;
    switch (cmdName) {
      case 'analyze':
      case 'export':
        desc = 'Exporte la structure du serveur et envoie un fichier JSON. Utilisation: `!export`';
        break;
      case 'import':
        desc = 'Importe une structure depuis un fichier JSON. Options: --dry-run, --skip-existing, --prefix=<préfixe>, --strict. Joignez un fichier JSON.';
        break;
      case 'setlevel':
        desc = 'Assigne un niveau de permission à un rôle. Utilisation: `!setlevel @Rôle niveau`';
        break;
      case 'listlevels':
        desc = 'Affiche la liste des rôles configurés avec leur niveau.';
        break;
      case 'sendembed':
        desc = 'Envoie un embed personnalisé (multiline/JSON/options). Utilisation: `!sendembed #salon <embedSpec>`';
        break;
      case 'editembed':
        desc = 'Édite un message embed envoyé par le bot. Utilisation: `!editembed <messageId|messageLink> <embedSpec>`';
        break;
      case 'embedpreset':
        desc = "Gère les presets d'embed. Sous-commandes: set, show, list, delete, default.";
        break;
      case 'youtube':
        desc = 'Gère les notifications YouTube (vidéos longues uniquement). Sous‑commandes: add <channelId> #salon, remove <channelId>, list.';
        break;
      case 'shorts':
        desc = 'Gère les notifications YouTube Shorts (vidéos ≤60s). Sous‑commandes: add <channelId> #salon, remove <channelId>, list.';
        break;
      case 'twitch':
        desc = 'Gère les notifications Twitch. Sous‑commandes: add <login> #salon, remove <login>, list.';
        break;
      case 'autopublish':
        desc = 'Publie automatiquement les messages des salons Announcement. Sous-commandes: on, off, status.';
        break;
      case 'ticketpanel':
        desc = 'Publie le panel tickets avec menu deroulant dans le salon configure.';
        break;
      case 'ticket':
        desc = 'Commande de secours pour les tickets. Utilisation: `!ticket status`, `!ticket close`, `!ticket claim`, `!ticket reopen`.';
        break;
      case 'backup':
        desc = 'Gère les sauvegardes automatiques. Sous‑commandes: now, setchannel #salon, schedule daily|weekly, off.';
        break;
      case 'template':
        desc = 'Gère les templates d\'embeds. Sous‑commandes: save nom Titre | Contenu, send nom #salon, list, show nom, remove nom.';
        break;
      case 'welcome':
        desc = 'Configure un message de bienvenue. Sous‑commandes: setchannel #salon, message "texte", off, test.';
        break;
      case 'rules':
        desc = 'Gère les règles. Utilisation: `!rules set Titre | Contenu`, `!rules` pour poster ici, `!rules post #salon`.';
        break;
      case 'feature':
        desc = 'Active ou désactive des modules. Sous‑commandes: list, enable <module>, disable <module>.';
        break;
      case 'permissions':
        desc = 'Vérifie les permissions requises. Utilisation: `!permissions check #salon` ou `!permissions check import`.';
        break;
      case 'config':
        desc = 'Affiche la configuration du serveur. Utilisation: `!config show`.';
        break;
      case 'setlog':
        desc = 'Définit le salon des logs. Utilisation: `!setlog #salon`.';
        break;
      case 'status':
        desc = 'Affiche le statut du bot. Utilisation: `!status` ou `!status verbose`.';
        break;
      case 'resetconfig':
        desc = 'Réinitialise complètement la configuration du serveur. Utilisation: `!resetconfig`.';
        break;
      default:
        desc = 'Aucune description disponible.';
    }
    embed.setDescription(desc).setFooter({ text: `Niveau requis: ${cmd.level}` });
    return message.reply({ embeds: [embed] });
  }
});

/*
 * Event handlers
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

// ------------------------------------------------------------
// Clean shutdown (Render sends SIGTERM on deploy/stop)
// ------------------------------------------------------------
async function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing Discord client...`);
  try {
    healthServer.close();
  } catch (_) {}
  try {
    await client.destroy();
  } catch (_) {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Helpful diagnostics in hosted environments
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});



// ------------------------------------------------------------
// Slash command adapter helpers
// ------------------------------------------------------------

/**
 * Create an adapter object that makes an interaction look like a message
 * so existing prefix command handlers can be reused for slash commands.
 */
function createSlashAdapter(interaction) {
  let hasReplied = false;
  return {
    guild: interaction.guild,
    member: interaction.member,
    author: interaction.user,
    channel: interaction.channel,
    client: interaction.client,
    content: '',
    createdTimestamp: interaction.createdTimestamp,
    attachments: { size: 0, first() { return undefined; } },
    mentions: { users: { size: 0, first() { return undefined; } } },
    async reply(opts) {
      let result;
      if (!hasReplied) {
        hasReplied = true;
        result = await interaction.editReply(opts);
      } else {
        result = await interaction.followUp(opts);
      }
      return result;
    },
    get _hasReplied() { return hasReplied; },
  };
}

/**
 * Convert slash command options into the (args, rawArgs) format
 * that existing prefix command handlers expect.
 */
function buildSlashArgs(interaction) {
  const sub = interaction.options.getSubcommand(false);
  const args = [];
  const rawParts = [];
  if (sub) {
    args.push(sub);
    rawParts.push(sub);
  }
  const data = interaction.options.data;
  const opts = sub ? (data[0]?.options || []) : data;
  for (const opt of opts) {
    if (opt.type === 1 || opt.type === 2) continue; // SUB_COMMAND / SUB_COMMAND_GROUP
    let formatted;
    switch (opt.type) {
      case 6: formatted = `<@${opt.value}>`; break;   // USER
      case 7: formatted = `<#${opt.value}>`; break;   // CHANNEL
      case 8: formatted = `<@&${opt.value}>`; break;  // ROLE
      default: formatted = String(opt.value);
    }
    args.push(formatted);
    rawParts.push(formatted);
  }
  return { args, rawArgs: rawParts.join(' ') };
}

/**
 * Overrides for commands whose args/rawArgs format doesn't match
 * the generic mapper output.
 */
const SLASH_OVERRIDES = {
  'poll': (interaction) => {
    const question = interaction.options.getString('question');
    const opts = [
      interaction.options.getString('option1'),
      interaction.options.getString('option2'),
      interaction.options.getString('option3'),
      interaction.options.getString('option4'),
      interaction.options.getString('option5'),
    ].filter(Boolean);
    const combined = [question, ...opts].join(' | ');
    return { args: combined.split(/\s+/), rawArgs: combined };
  },
  'suggest:new': (interaction) => {
    const content = interaction.options.getString('content');
    return { args: content.split(/\s+/), rawArgs: content };
  },
  'rules:show': () => {
    return { args: [], rawArgs: '' };
  },
  'status': (interaction) => {
    const verbose = interaction.options.getBoolean('verbose');
    return { args: verbose ? ['verbose'] : [], rawArgs: verbose ? 'verbose' : '' };
  },
  'config': () => {
    return { args: ['show'], rawArgs: 'show' };
  },
};

// On ready, initialise watchers and backup schedules
client.once('ready', async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);

  // Register slash commands globally
  try {
    console.log('[slash] Enregistrement des commandes slash...');
    await client.application.commands.set(slashCommandDefs);
    console.log(`[slash] ${slashCommandDefs.length} commandes enregistrées.`);
  } catch (err) {
    console.error('[slash] Échec de l\'enregistrement:', err);
  }

  // Start periodic tasks with a configurable polling interval
  setInterval(pollYouTube, POLL_INTERVAL_MS);
  setInterval(pollTwitch, POLL_INTERVAL_MS);
  pollYouTube().catch(err => console.error('[pollYouTube] first run failed:', err));
  pollTwitch().catch(err => console.error('[pollTwitch] first run failed:', err));
  // Start backup schedules for all guilds
  for (const guild of client.guilds.cache.values()) {
    ensureGuildConfig(guild.id);
    scheduleBackups(guild.id);
  }
  persist();
});

// On guild member join, send welcome message if configured
async function handleGuildMemberAdd(member) {
  const guildCfg = ensureGuildConfig(member.guild.id);
  const wCfg = guildCfg.modules.welcome;
  if (!guildCfg.featureToggles.welcome || !wCfg.enabled || !wCfg.channelId) return;
  try {
    const channel = await member.guild.channels.fetch(wCfg.channelId);
    if (!channel) return;
    const content = wCfg.message
      .replace(/{server}/gi, member.guild.name)
      .replace(/{user}/gi, `<@${member.id}>`)
      .replace(/{date}/gi, new Date().toLocaleDateString());
    await channel.send(content);
  } catch (err) {
    log(member.guild.id, `Échec de l'envoi du message de bienvenue: ${err.message}`);
  }
}

client.on('guildMemberAdd', handleGuildMemberAdd);

client.on('interactionCreate', async (interaction) => {
  // ---- Slash command handling ----
  if (interaction.isChatInputCommand()) {
    const commandName = interaction.commandName;

    await interaction.deferReply();

    // Special: help command (has interactive buttons)
    if (commandName === 'help') {
      const category = interaction.options.getString('category') || 'all';
      const guildCfg = ensureGuildConfig(interaction.guild.id);
      const userLevel = getUserLevel(interaction.member);
      const embed = buildHelpCategoryEmbed(category, interaction.guild, userLevel, guildCfg);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`help:all:${interaction.user.id}`).setLabel('Tout').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`help:core:${interaction.user.id}`).setLabel('Core').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`help:notifs:${interaction.user.id}`).setLabel('Notifs').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`help:patch:${interaction.user.id}`).setLabel('Patch').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`help:outils:${interaction.user.id}`).setLabel('Outils').setStyle(ButtonStyle.Secondary),
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`help:social:${interaction.user.id}`).setLabel('Social').setStyle(ButtonStyle.Secondary),
      );
      return interaction.editReply({ embeds: [embed], components: [row, row2] });
    }

    // Look up existing prefix command handler
    const cmdEntry = commands[commandName];
    if (!cmdEntry) {
      return interaction.editReply({ content: 'Commande inconnue.' });
    }

    // Permission check
    const userLevel = getUserLevel(interaction.member);
    if (cmdEntry.level > userLevel) {
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xff5555).setDescription("Vous n'avez pas la permission d'utiliser cette commande.")],
      });
    }

    // Build args from slash options
    let { args, rawArgs } = buildSlashArgs(interaction);

    // Apply overrides for commands with non-standard arg formats
    const sub = interaction.options.getSubcommand(false);
    const overrideKey = sub ? `${commandName}:${sub}` : commandName;
    const override = SLASH_OVERRIDES[overrideKey] || SLASH_OVERRIDES[commandName];
    if (override) {
      ({ args, rawArgs } = override(interaction));
    }

    // Create adapter and call existing handler
    const adapter = createSlashAdapter(interaction);
    try {
      await cmdEntry.handler(adapter, args, rawArgs);
      if (!adapter._hasReplied) {
        await interaction.editReply({ content: '\u2705' });
      }
    } catch (err) {
      console.error('[slash]', err);
      const errorEmbed = new EmbedBuilder().setColor(0xe74c3c).setDescription('Une erreur inattendue est survenue.');
      if (!adapter._hasReplied) {
        await interaction.editReply({ embeds: [errorEmbed] }).catch(() => {});
      } else {
        await interaction.followUp({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:modal:')) {
    const guildCfg = ensureGuildConfig(interaction.guild.id);
    if (!moduleEnabled(guildCfg, 'tickets') || !guildCfg.modules.tickets.enabled) {
      return interaction.reply({ content: 'Le module tickets est desactive.', ephemeral: true });
    }
    const typeId = interaction.customId.split(':')[2];
    const ticketType = getTicketType(typeId);
    if (!ticketType) {
      return interaction.reply({ content: 'Type de ticket inconnu.', ephemeral: true });
    }
    const access = canCreateTicket(interaction.member, ticketType, guildCfg.modules.tickets);
    if (!access.ok) {
      return interaction.reply({ content: access.reason, ephemeral: true });
    }

    const answers = ticketType.questions.map(question => ({
      id: question.id,
      label: question.placeholder,
      value: interaction.fields.getTextInputValue(question.id) || '',
    }));
    await interaction.deferReply({ ephemeral: true });
    try {
      const channel = await createTicketChannel(interaction.guild, interaction.member, typeId, answers);
      return interaction.editReply({ content: `🎫 Ton ticket est pret dans ${channel}.` });
    } catch (err) {
      return interaction.editReply({ content: err.message || 'Impossible de creer le ticket.' });
    }
  }

  // ---- Button interaction handling ----
  if (!interaction.isButton()) return;
  const [kind, id, arg] = (interaction.customId || '').split(':');

  if (kind === 'ticketopen') {
    const guildCfg = ensureGuildConfig(interaction.guild.id);
    if (!moduleEnabled(guildCfg, 'tickets') || !guildCfg.modules.tickets.enabled) {
      return interaction.reply({ content: 'Le module tickets est desactive.', ephemeral: true });
    }
    const typeId = id;
    const ticketType = getTicketType(typeId);
    if (!ticketType) {
      return interaction.reply({ content: 'Type de ticket inconnu.', ephemeral: true });
    }
    const access = canCreateTicket(interaction.member, ticketType, guildCfg.modules.tickets);
    if (!access.ok) {
      return interaction.reply({ content: access.reason, ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`ticket:modal:${typeId}`)
      .setTitle(`Ticket ${ticketType.label}`.slice(0, 45));
    const rows = ticketType.questions.slice(0, 5).map((question) => {
      const input = new TextInputBuilder()
        .setCustomId(question.id)
        .setLabel(question.label.slice(0, 45))
        .setStyle(question.style)
        .setRequired(question.required)
        .setPlaceholder(question.placeholder.slice(0, 100));
      return new ActionRowBuilder().addComponents(input);
    });
    modal.addComponents(...rows);
    return interaction.showModal(modal);
  }

  if (kind === 'help') {
    const category = id;
    const authorId = arg;
    if (interaction.user.id !== authorId) {
      return interaction.reply({ content: 'Ce menu help n\'est pas pour toi.', ephemeral: true });
    }
    const guildCfg = ensureGuildConfig(interaction.guild.id);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const level = getUserLevel(member);
    return interaction.update({ embeds: [buildHelpCategoryEmbed(category, interaction.guild, level, guildCfg)] });
  }

  if (kind === 'ticket') {
    const tickets = getTicketState(interaction.guild.id);
    const ticketInfo = tickets[interaction.channel.id];
    if (!ticketInfo) {
      return interaction.reply({ content: 'Ce salon nest pas un ticket gere.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      if (id === 'close') await closeTicket(interaction.channel, interaction.member);
      else if (id === 'claim') await claimTicket(interaction.channel, interaction.member);
      else if (id === 'reopen') await reopenTicket(interaction.channel, interaction.member);
      else return interaction.editReply({ content: 'Action ticket inconnue.' });
      return interaction.editReply({ content: 'Action ticket executee.' });
    } catch (err) {
      return interaction.editReply({ content: err.message || 'Action ticket impossible.' });
    }
  }

  if (kind === 'poll') {
    const poll = interactive.polls.get(id);
    if (!poll) return interaction.reply({ content: 'Sondage expiré.', ephemeral: true });
    const idx = parseInt(arg, 10);
    if (Number.isNaN(idx)) return interaction.reply({ content: 'Vote invalide.', ephemeral: true });
    poll.votes.set(interaction.user.id, idx);
    const row = new ActionRowBuilder().addComponents(poll.options.map((opt, i) => new ButtonBuilder()
      .setCustomId(`poll:${id}:${i}`)
      .setLabel(`${i + 1}`)
      .setStyle(ButtonStyle.Primary)));
    await interaction.update({ embeds: [buildPollEmbed(interaction.guild, poll)], components: [row] });
    return interaction.followUp({ content: 'Vote enregistré.', ephemeral: true });
  }

  if (kind === 'suggest') {
    const sug = interactive.suggestions.get(id);
    if (!sug) return interaction.reply({ content: 'Suggestion expirée.', ephemeral: true });
    const action = arg;
    if (action === 'up') {
      if (sug.up.has(interaction.user.id)) sug.up.delete(interaction.user.id);
      else {
        sug.down.delete(interaction.user.id);
        sug.up.add(interaction.user.id);
      }
    } else if (action === 'down') {
      if (sug.down.has(interaction.user.id)) sug.down.delete(interaction.user.id);
      else {
        sug.up.delete(interaction.user.id);
        sug.down.add(interaction.user.id);
      }
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`suggest:${id}:up`).setEmoji('👍').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`suggest:${id}:down`).setEmoji('👎').setStyle(ButtonStyle.Danger),
    );
    await interaction.update({ embeds: [buildSuggestionEmbed(interaction.guild, sug)], components: [row] });
    return interaction.followUp({ content: 'Vote pris en compte !', ephemeral: true });
  }
});

// Process commands
client.on('messageCreate', async message => {
  if (!message.guild) return;
  await maybeAutoPublishMessage(message);
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const parsed = parseCommandContent(message.content, PREFIX);
  if (!parsed) return;

  const { command, args, rawArgs } = parsed;
  const cmdEntry = commands[command];
  if (!cmdEntry) return;

  const userLevel = getUserLevel(message.member);
  if (cmdEntry.level > userLevel) {
    return message.reply({ embeds: [new EmbedBuilder().setColor(0xff5555).setDescription("Vous n'avez pas la permission d'utiliser cette commande.")] });
  }
  try {
    if (cmdEntry.wantsRaw || cmdEntry.handler.length >= 3) {
      await cmdEntry.handler(message, args, rawArgs);
    } else {
      await cmdEntry.handler(message, args);
    }
  } catch (err) {
    console.error(err);
    await message.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription('Une erreur inattendue est survenue.')] });
  }
});

// Login to Discord
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN est manquant. Définissez la variable d\'environnement.');
  process.exit(1);
}
client.login(DISCORD_TOKEN).catch(err => console.error('Erreur de connexion:', err));
