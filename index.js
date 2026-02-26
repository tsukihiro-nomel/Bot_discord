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
      youtube: { enabled: false, channels: [], cooldown: 5 * 60 * 1000, firstInstall: 'skip' },
      twitch: { enabled: false, streamers: {}, cooldown: 5 * 60 * 1000, consecutiveChecks: 1 },
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
      twitch: true,
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
  if (!state[guildId]) {
    state[guildId] = { youtube: {}, twitch: {} };
  }
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
 * Poll all guilds for new YouTube videos.  For each guild that has the
 * YouTube module enabled, iterate through its list of watched channels and
 * check for the most recent video using the search.list endpoint of the
 * YouTube Data API.  The `order` parameter set to `date` sorts resources
 * in reverse chronological order【755683164106593†L330-L339】 and the `channelId` parameter
 * restricts results to the specified channel【755683164106593†L257-L263】.  When a new video is
 * found an embed is posted and the lastVideoId is updated.
 */
async function pollYouTube() {
  for (const [guildId, guildCfg] of Object.entries(config)) {
    const moduleCfg = guildCfg.modules.youtube;
    if (!guildCfg.featureToggles.youtube || !moduleCfg.enabled) continue;
    const apiKey = process.env.YT_API_KEY;
    if (!apiKey) continue;
    for (const channelCfg of moduleCfg.channels) {
      const { id: ytChannelId, announceChannelId } = channelCfg;
      try {
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(ytChannelId)}&maxResults=1&order=date&type=video&key=${apiKey}`,
        );
        if (!res.ok) {
          log(guildId, `Erreur API YouTube: ${res.status}`);
          continue;
        }
        const data = await res.json();
        if (data.items && data.items.length > 0) {
          const item = data.items[0];
          const videoId = item.id.videoId;
          const last = state[guildId].youtube[ytChannelId];
          // Determine whether to notify
          const isFirstInstall = last === undefined;
          if (isFirstInstall) {
            // On first install, decide whether to skip or notify
            state[guildId].youtube[ytChannelId] = videoId;
            if (moduleCfg.firstInstall === 'notify') {
              await sendYouTubeNotification(guildId, announceChannelId, item);
            }
            persist();
            continue;
          }
          if (last === videoId) continue;
          // anti‑spam: check cooldown per announce channel
          const now = Date.now();
          const spamKey = `${guildId}:${announceChannelId}`;
          if (guildCfg.antiSpam[spamKey] && now - guildCfg.antiSpam[spamKey] < moduleCfg.cooldown) {
            continue;
          }
          state[guildId].youtube[ytChannelId] = videoId;
          guildCfg.antiSpam[spamKey] = now;
          persist();
          await sendYouTubeNotification(guildId, announceChannelId, item);
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
      .setTitle(snippet.title)
      .setURL(`https://www.youtube.com/watch?v=${videoId}`)
      .setDescription(snippet.description || '')
      .setThumbnail(snippet.thumbnails?.high?.url ?? null)
      .addFields({ name: 'Chaîne', value: snippet.channelTitle })
      .setTimestamp(new Date(snippet.publishedAt));
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log(guildId, `Erreur lors de l'envoi de la notification YouTube: ${err.message}`);
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
            await sendTwitchNotification(guildId, announceId, stream);
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
 * Send a Twitch live notification embed.  The embed contains basic stream
 * metadata: title, game, viewer count, thumbnail and timestamp.  The
 * thumbnail URL returned by the Helix API contains placeholders for width
 * and height which are replaced with 1280 and 720 respectively.
 *
 * @param {string} guildId
 * @param {string|null} channelId
 * @param {object} stream The stream object returned by the API
 */
async function sendTwitchNotification(guildId, channelId, stream) {
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    const guild = client.guilds.cache.get(guildId);
    if (!channel || !guild || !canSendEmbeds(channel, guild)) {
      await log(guildId, "Impossible d'envoyer la notification Twitch (salon invalide ou permissions manquantes).");
      return;
    }
    const thumbnail = stream.thumbnail_url
      ? stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720')
      : null;
    const embed = new EmbedBuilder()
      .setColor(0x9146ff)
      .setTitle(`🔴 Live maintenant : ${stream.title || 'Sans titre'}`)
      .setURL(`https://twitch.tv/${stream.user_login}`)
      .setDescription(`Stream par **${stream.user_name}**`)
      .addFields(
        { name: 'Jeu/Catégorie', value: stream.game_name || 'Inconnu', inline: true },
        { name: 'Spectateurs', value: `${stream.viewer_count}`, inline: true },
      )
      .setThumbnail(thumbnail)
      .setTimestamp(new Date(stream.started_at));
    await channel.send({ embeds: [embed] });
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

function makeBotEmbed(kind, guild, title, description, fields) {
  return buildEmbed(kind, { client, guild, title, description, fields });
}

async function replyBot(message, kind, title, description, fields) {
  return message.reply({ embeds: [makeBotEmbed(kind, message.guild, title, description, fields)] });
}

function moduleEnabled(guildCfg, name) {
  return Boolean(guildCfg?.featureToggles?.[name]);
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
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Utilisation: !youtube add <channelId> #salon')] });
    }
    const channelId = args.shift();
    const channelMention = args.shift();
    const announceId = channelMention.replace(/<#(\d+)>/, '$1');
    ytCfg.enabled = true;
    const exists = ytCfg.channels.some(c => c.id === channelId && c.announceChannelId === announceId);
    if (exists) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setDescription('Cette chaîne YouTube est déjà configurée pour ce salon.')] });
    }
    ytCfg.channels.push({ id: channelId, announceChannelId: announceId });
    persist();
    return message.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setDescription(`Chaîne YouTube **${channelId}** ajoutée. Les notifications seront publiées dans <#${announceId}>.`)] });
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
    const text = String(rawArgs || '').replace(/^\s*set\s*/i, '');
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
    fields.push({ name: 'Twitch', value: guildCfg.modules.twitch.enabled ? Object.keys(guildCfg.modules.twitch.streamers).length + ' streamers' : 'désactivé' });
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
    { name: 'Twitch', value: guildCfg.featureToggles.twitch ? `${Object.keys(guildCfg.modules.twitch.streamers).length} streamers` : 'OFF' },
    { name: 'Backups', value: guildCfg.featureToggles.backups ? (guildCfg.modules.backups.schedule || 'manuel') : 'OFF' },
    { name: 'Logs', value: guildCfg.featureToggles.logs ? (guildCfg.modules.logs.channelId ? `<#${guildCfg.modules.logs.channelId}>` : 'non configuré') : 'OFF' },
  );
  if (verbose) {
    embed.addFields(
      { name: 'Chaînes YouTube suivies', value: guildCfg.modules.youtube.channels.map(c => c.id).join(', ') || 'aucune' },
      { name: 'Streamers Twitch suivis', value: Object.keys(guildCfg.modules.twitch.streamers).join(', ') || 'aucun' },
      { name: 'Cooldown YouTube', value: `${guildCfg.modules.youtube.cooldown / 1000}s` },
      { name: 'Cooldown Twitch', value: `${guildCfg.modules.twitch.cooldown / 1000}s` },
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
  state[message.guild.id] = { youtube: {}, twitch: {} };
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
    all: ['help', 'ping', 'avatar', 'userinfo', 'serverinfo', 'youtube', 'twitch', 'backup', 'template', 'welcome', 'rules', 'sendembed', 'editembed', 'embedpreset', 'feature', 'setlog', 'status', 'poll', 'suggest', 'analyze', 'import', 'export', 'setlevel', 'listlevels', 'permissions', 'config', 'resetconfig', 'patch'],
    core: ['help', 'status', 'config', 'feature', 'setlevel', 'listlevels', 'permissions', 'resetconfig'],
    notifs: ['youtube', 'twitch', 'welcome', 'setlog'],
    patch: ['patch', 'analyze', 'import', 'export', 'backup', 'template', 'rules'],
    outils: ['ping', 'avatar', 'userinfo', 'serverinfo', 'poll', 'suggest', 'sendembed', 'editembed', 'embedpreset'],
    social: ['welcome', 'rules', 'suggest'],
  };
  const cmds = catalog[category] || catalog.all;
  const lines = cmds
    .filter((name) => commands[name] && commands[name].level <= userLevel)
    .filter((name) => {
      const modMap = {
        youtube: 'youtube', twitch: 'twitch', backup: 'backups', template: 'templates', welcome: 'welcome',
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
        desc = 'Gère les notifications YouTube. Sous‑commandes: add <channelId> #salon, remove <channelId>, list.';
        break;
      case 'twitch':
        desc = 'Gère les notifications Twitch. Sous‑commandes: add <login> #salon, remove <login>, list.';
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



// On ready, initialise watchers and backup schedules
client.once('ready', () => {
  console.log(`Connecté en tant que ${client.user.tag}`);
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
  if (!interaction.isButton()) return;
  const [kind, id, arg] = (interaction.customId || '').split(':');

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
  if (message.author.bot) return;
  if (!message.guild) return;
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
