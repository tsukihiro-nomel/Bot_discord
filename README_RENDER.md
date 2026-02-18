# Déploiement Render (Free) – Bot Discord

## Point clé (Render Free)
Render met en veille un **Free Web Service** après ~15 minutes sans trafic HTTP entrant.
Ce repo expose donc un endpoint `/health` pour pouvoir le ping.

## Commandes
- Build : `npm install`
- Start : `npm start`

## Variables d'environnement à définir sur Render
- DISCORD_TOKEN
- (optionnel) HEALTH_PATH (défaut: /health)
- (si tu utilises les modules notifs) `YT_API_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`
- (optionnel) `POLL_INTERVAL_MS` (>= 60000, défaut 300000)

## Keep-alive
Configure un ping vers :
`https://<ton-service>.onrender.com/health`
toutes les 10–14 minutes.

## Limitation stockage
Le filesystem des Free Web Services est éphémère sur Render :
les fichiers `config.json` et `state.json` peuvent disparaître en cas de redéploiement/redémarrage.
