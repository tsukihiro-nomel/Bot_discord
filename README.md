# Sawachi Discord Bot

Bot Discord (discord.js v14) orienté gestion serveur + notifications + patching, compatible **Render (Node 20)**.

## Démarrage

```bash
npm install
npm start
```

Variables importantes:

- `DISCORD_TOKEN` (obligatoire)
- `PORT` (pour le serveur health Render)
- `HEALTH_PATH` (par défaut `/health`)
- `DATA_DIR` (optionnel, fichiers `config.json` / `state.json`)
- `YT_API_KEY` (optionnel, module YouTube)
- `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` (optionnel, module Twitch)

## Santé / Render

Le bot expose une route HTTP de santé:

- `GET /health` (ou valeur de `HEALTH_PATH`)

Utile pour pinger le service et limiter le spin-down sur Render Free.

## Système de permissions

Niveaux basés rôles:

- `!setlevel @Role <niveau>`
- `!listlevels`
- Les admins Discord bypassent les niveaux.

## Feature toggles

- `!feature list`
- `!feature enable <module>`
- `!feature disable <module>`

Modules: `youtube`, `twitch`, `backups`, `templates`, `welcome`, `rules`, `logs`, `suggestions`, `polls`, `utility`, `fun`.

## Aide UI modernisée

- `!help` affiche un embed + boutons catégories:
  - Tout / Core / Notifs / Patch / Outils / Social
- `!help <commande>` affiche le détail d’usage.

## Commandes utilitaires

- `!ping`
- `!avatar [@user|id]`
- `!userinfo [@user|id]`
- `!serverinfo`

> Si `utility` est OFF: message explicite pour activer `!feature enable utility`.

## Polls (RAM, non persistants)

- `!poll Question | Option 1 | Option 2 | ...`
- 2 à 5 options max.
- Vote via boutons; un nouveau vote remplace l’ancien.
- Compteurs mis à jour en live.
- Données en mémoire (perdues au redémarrage Render), avec nettoyage TTL.

## Suggestions (RAM, non persistants)

Configuration (niveau >= 2):

- `!suggest set #salon`
- `!suggest off`

Publication:

- `!suggest <ton idée>`

Votes:

- Boutons 👍/👎
- Toggle up/down (jamais les deux simultanément)
- Compteurs live dans l’embed

## Commandes existantes conservées

- Notifications YouTube/Twitch
- Backups
- Templates
- Welcome
- Rules
- Patch `.sawa`
- `/health`
- système de toggles `!feature`
- système de niveaux (`getUserLevel`)

## Notes persistance

- `config.json` / `state.json` persistés selon ton `DATA_DIR`.
- Polls/Suggestions interactifs: **mémoire volatile** (v1, Render Free friendly).


## Embeds: syntaxe avancée

### `!sendembed #salon <embedSpec>`

Modes supportés:

1. **Texte**: `Titre | Description` (multiline supporté).
2. **JSON** dans codeblock:
   ````
   !sendembed #annonces ```json
   { "title": "X", "description": "A\nB", "color": "#FFB7DE" }
   ```
   ````

Options avancées via `||`:

```
!sendembed #annonces Titre | Desc
|| --color #FFB7DE --footer "Le Carnet" --timestamp off
|| --author "Sawa" --authorIcon https://... --authorUrl https://...
|| --thumbnail https://... --image https://... --url https://...
|| --field "CPU::30%::true" --field "RAM::2GB::true"
```

- `--preset <nom>` applique un preset.
- `--timestamp on|off`
- Les descriptions > 4096 caractères sont automatiquement découpées en plusieurs embeds.
- Les publications utilisent `allowedMentions: { parse: [] }` (pas de ping `@everyone/@here`).

### `!editembed`

- `!editembed <messageId> <embedSpec>`
- `!editembed <messageLink> <embedSpec>`

Le bot refuse d'éditer un message qui ne lui appartient pas.

### `!embedpreset`

- `!embedpreset set <nom> || options...`
- `!embedpreset show <nom>`
- `!embedpreset list`
- `!embedpreset delete <nom>`
- `!embedpreset default <nom|off>`
