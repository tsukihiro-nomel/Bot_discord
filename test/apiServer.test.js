const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../api/apiServer');

test('applyVariables replaces known tokens and leaves missing ones empty', () => {
  const result = _internal.applyVariables('Bonjour {user} sur {server} ({missing})', {
    user: 'Sawa',
    server: 'Le Carnet',
  });

  assert.equal(result, 'Bonjour Sawa sur Le Carnet ()');
});

test('safeAllowedMentions suppresses mentions by default', () => {
  const guild = {
    roles: {
      cache: {
        has: () => true,
      },
    },
  };

  assert.deepEqual(_internal.safeAllowedMentions(guild, {}), { parse: [] });
  assert.deepEqual(
    _internal.safeAllowedMentions(guild, {
      suppressMentions: false,
      allowedRoleIds: ['123'],
      allowedUserIds: ['456456456456456456'],
    }),
    { parse: [], roles: ['123'], users: ['456456456456456456'] },
  );
});

test('buildAnnouncement renders template embeds', () => {
  const built = _internal.buildAnnouncement({
    guild: {
      id: '1',
      name: 'Sawahiro',
      client: {
        user: { username: 'Bot' },
      },
      roles: {
        cache: { has: () => true },
      },
    },
    channel: {
      id: '10',
      name: 'annonces',
    },
    guildCfg: {
      modules: {
        templates: {
          items: {
            live: {
              title: 'Live {server}',
              content: 'Bonsoir {user}',
            },
          },
        },
        embeds: {
          presets: {},
          defaultPreset: null,
        },
      },
    },
    payload: {
      mode: 'template',
      templateName: 'live',
      templateVariables: {
        user: 'Tsuki',
      },
    },
    files: [],
    buildEmbedsFromSpec: () => ({ embeds: [] }),
  });

  assert.equal(built.preview.embeds[0].title, 'Live Sawahiro');
  assert.equal(built.preview.embeds[0].description, 'Bonsoir Tsuki');
});

test('normalizeAnnouncementPayload parses multipart-style JSON fields safely', () => {
  const normalized = _internal.normalizeAnnouncementPayload({
    channelId: '42',
    mode: 'embedSpec',
    payload: JSON.stringify({
      idempotencyKey: 'publish-001',
      suppressMentions: false,
      allowedRoleIds: ['123'],
      embedSpec: {
        title: 'Carnet',
        description: 'Preview',
      },
    }),
    embedSpec: JSON.stringify({
      title: 'Live de test',
      description: 'Rendu final',
    }),
  });

  assert.equal(normalized.channelId, '42');
  assert.equal(normalized.mode, 'embedSpec');
  assert.equal(normalized.idempotencyKey, 'publish-001');
  assert.equal(normalized.suppressMentions, false);
  assert.deepEqual(normalized.allowedRoleIds, ['123']);
  assert.deepEqual(normalized.embedSpec, {
    title: 'Carnet',
    description: 'Preview',
  });
});
