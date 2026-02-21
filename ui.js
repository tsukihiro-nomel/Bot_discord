// ui.js - tiny UI helpers (embeds + styling)
const { EmbedBuilder } = require('discord.js');

const THEME = {
  name: 'Sawachi',
  colors: {
    info: 0x5865F2,
    success: 0x57F287,
    warn: 0xFEE75C,
    error: 0xED4245,
    youtube: 0xFF0000,
    twitch: 0x9146FF,
    neutral: 0x2B2D31,
  },
  emoji: {
    info: 'ℹ️',
    success: '✅',
    warn: '⚠️',
    error: '❌',
    youtube: '📺',
    twitch: '🟣',
    gear: '⚙️',
    magic: '🪄',
    spark: '✨',
    list: '🧾',
    vote: '🗳️',
    idea: '💡',
  },
};

const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
};

function clampStr(s, max) {
  if (s == null) return '';
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + '…';
}

function buildEmbed(kind, { client, guild, title, description, fields, footer } = {}) {
  const color = THEME.colors[kind] ?? THEME.colors.info;
  const e = new EmbedBuilder().setColor(color).setTimestamp();

  if (client?.user) e.setAuthor({ name: THEME.name, iconURL: client.user.displayAvatarURL() });
  else e.setAuthor({ name: THEME.name });

  if (title) e.setTitle(clampStr(title, LIMITS.title));
  if (description) e.setDescription(clampStr(description, LIMITS.description));

  if (Array.isArray(fields) && fields.length) {
    e.addFields(
      fields.slice(0, 25).map((f) => ({
        name: clampStr(f.name ?? '', LIMITS.fieldName),
        value: clampStr(f.value ?? '', LIMITS.fieldValue) || '—',
        inline: Boolean(f.inline),
      })),
    );
  }

  const footerText = footer ?? (guild ? `${THEME.name} • ${guild.name}` : THEME.name);
  e.setFooter({ text: clampStr(footerText, LIMITS.footerText), iconURL: guild?.iconURL?.() ?? undefined });

  return e;
}

module.exports = { THEME, LIMITS, clampStr, buildEmbed };
