# Private API

API HTTP privee pour piloter le bot Discord depuis les apps locales Sawahiro.

## Activation

Variables d'environnement:

- `BOT_API_ENABLED=true`
- `BOT_API_TOKEN=<secret>`
- `BOT_API_HOST=0.0.0.0`
- `BOT_API_PORT=3000`
- `HEALTH_PATH=/health`
- `DATA_DIR=<path>`

Auth requise sur toutes les routes privees:

- header `x-bot-admin-token: <BOT_API_TOKEN>`

## Fichiers generes

Dans `DATA_DIR`:

- `api-jobs.json`
  - historique de publications et patch plans
- `api-audit.log`
  - journal JSONL des appels API
- `api-snapshots/<guildId>/*.json`
  - snapshots avant import et avant patch apply

## Health

- `GET /health`

## Lecture

- `GET /api/v1/guilds`
- `GET /api/v1/jobs`
- `GET /api/v1/guilds/:guildId/meta`
- `GET /api/v1/guilds/:guildId/config`
- `GET /api/v1/guilds/:guildId/roles`
- `GET /api/v1/guilds/:guildId/channels`
- `GET /api/v1/guilds/:guildId/modules`
- `GET /api/v1/guilds/:guildId/templates`
- `GET /api/v1/guilds/:guildId/rules`
- `GET /api/v1/guilds/:guildId/welcome`
- `GET /api/v1/guilds/:guildId/tickets`
- `GET /api/v1/guilds/:guildId/snapshot`

## Publication

- `POST /api/v1/guilds/:guildId/announcements/preview`
- `POST /api/v1/guilds/:guildId/announcements/publish`
- `POST /api/v1/guilds/:guildId/messages/test`

Payload JSON ou multipart:

```json
{
  "channelId": "123",
  "mode": "embedSpec",
  "idempotencyKey": "campaign-001",
  "suppressMentions": true,
  "embedSpec": {
    "title": "Live ce soir",
    "description": "Rendez-vous dans le Carnet."
  }
}
```

Modes supportes:

- `plain`
- `template`
- `embedSpec`

## Structure serveur

- `POST /api/v1/guilds/:guildId/import/dry-run`
- `POST /api/v1/guilds/:guildId/import/apply`
- `POST /api/v1/guilds/:guildId/patch/plan`
- `POST /api/v1/guilds/:guildId/patch/apply`
- `POST /api/v1/guilds/:guildId/patch/cancel`

Flux recommande:

1. creer un patch plan
2. verifier le `confirmCode`
3. appeler `patch/apply`
4. recuperer le `backupPath` si besoin de rollback manuel

## Modules pilotables

- `PUT /api/v1/guilds/:guildId/modules/:module`
- `PUT /api/v1/guilds/:guildId/rules`
- `POST /api/v1/guilds/:guildId/rules/post`
- `PUT /api/v1/guilds/:guildId/welcome`
- `POST /api/v1/guilds/:guildId/welcome/test`
- `PUT /api/v1/guilds/:guildId/tickets`
- `POST /api/v1/guilds/:guildId/tickets/panel/publish`
- `PUT /api/v1/guilds/:guildId/templates/:name`
- `DELETE /api/v1/guilds/:guildId/templates/:name`

## Notes de securite

- ne jamais exposer `BOT_API_TOKEN` dans les apps packagées ou dans le chat
- preferer une exposition locale, VPN, Tailscale ou reverse proxy protege
- la prod doit idealement avoir un serveur Discord de test pour les `import/apply`
