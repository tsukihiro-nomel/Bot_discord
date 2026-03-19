const { SlashCommandBuilder } = require('discord.js');

module.exports = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Mesure la latence du bot'),

  new SlashCommandBuilder()
    .setName('avatar')
    .setDescription("Affiche l'avatar d'un utilisateur")
    .addUserOption(opt => opt.setName('user').setDescription('Utilisateur cible')),

  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription("Affiche les informations d'un utilisateur")
    .addUserOption(opt => opt.setName('user').setDescription('Utilisateur cible')),

  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Affiche les informations du serveur'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Affiche la liste des commandes')
    .addStringOption(opt => opt.setName('category').setDescription('Catégorie de commandes')
      .addChoices(
        { name: 'Tout', value: 'all' },
        { name: 'Core', value: 'core' },
        { name: 'Notifications', value: 'notifs' },
        { name: 'Patch', value: 'patch' },
        { name: 'Outils', value: 'outils' },
        { name: 'Social', value: 'social' },
      )),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Affiche le statut du bot')
    .addBooleanOption(opt => opt.setName('verbose').setDescription('Afficher les détails')),

  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Crée un sondage')
    .addStringOption(opt => opt.setName('question').setDescription('La question du sondage').setRequired(true))
    .addStringOption(opt => opt.setName('option1').setDescription('Option 1').setRequired(true))
    .addStringOption(opt => opt.setName('option2').setDescription('Option 2').setRequired(true))
    .addStringOption(opt => opt.setName('option3').setDescription('Option 3'))
    .addStringOption(opt => opt.setName('option4').setDescription('Option 4'))
    .addStringOption(opt => opt.setName('option5').setDescription('Option 5')),

  new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Gère les suggestions')
    .addSubcommand(sub => sub.setName('new').setDescription('Envoyer une suggestion')
      .addStringOption(opt => opt.setName('content').setDescription('Contenu de la suggestion').setRequired(true)))
    .addSubcommand(sub => sub.setName('set').setDescription('Définir le salon de suggestions')
      .addChannelOption(opt => opt.setName('channel').setDescription('Salon cible').setRequired(true)))
    .addSubcommand(sub => sub.setName('off').setDescription('Désactiver les suggestions')),

  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Gère les règles du serveur')
    .addSubcommand(sub => sub.setName('show').setDescription('Afficher les règles'))
    .addSubcommand(sub => sub.setName('set').setDescription('Définir les règles')
      .addStringOption(opt => opt.setName('content').setDescription('Titre | Contenu (séparés par |)').setRequired(true)))
    .addSubcommand(sub => sub.setName('post').setDescription('Poster les règles dans un salon')
      .addChannelOption(opt => opt.setName('channel').setDescription('Salon cible').setRequired(true))),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Affiche la configuration du serveur'),

  new SlashCommandBuilder()
    .setName('listlevels')
    .setDescription('Affiche les niveaux de rôles configurés'),

  new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Exporte la structure du serveur en JSON'),

  new SlashCommandBuilder()
    .setName('youtube')
    .setDescription('Gère les notifications YouTube')
    .addSubcommand(sub => sub.setName('add').setDescription('Ajouter une chaîne YouTube')
      .addStringOption(opt => opt.setName('channel_id').setDescription('ID (UCxxx) ou handle (@nom) de la chaîne').setRequired(true))
      .addChannelOption(opt => opt.setName('announce_channel').setDescription("Salon d'annonce").setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Supprimer une chaîne YouTube')
      .addStringOption(opt => opt.setName('channel_id').setDescription('ID de la chaîne YouTube').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('Lister les chaînes suivies')),

  new SlashCommandBuilder()
    .setName('shorts')
    .setDescription('Gère les notifications YouTube Shorts')
    .addSubcommand(sub => sub.setName('add').setDescription('Ajouter une chaîne pour les Shorts')
      .addStringOption(opt => opt.setName('channel_id').setDescription('ID (UCxxx) ou handle (@nom) de la chaîne').setRequired(true))
      .addChannelOption(opt => opt.setName('announce_channel').setDescription("Salon d'annonce").setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Supprimer une chaîne Shorts')
      .addStringOption(opt => opt.setName('channel_id').setDescription('ID de la chaîne YouTube').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('Lister les chaînes suivies pour les Shorts')),

  new SlashCommandBuilder()
    .setName('twitch')
    .setDescription('Gère les notifications Twitch')
    .addSubcommand(sub => sub.setName('add').setDescription('Ajouter un streamer')
      .addStringOption(opt => opt.setName('login').setDescription('Login Twitch du streamer').setRequired(true))
      .addChannelOption(opt => opt.setName('announce_channel').setDescription("Salon d'annonce").setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Supprimer un streamer')
      .addStringOption(opt => opt.setName('login').setDescription('Login Twitch du streamer').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('Lister les streamers suivis')),

  new SlashCommandBuilder()
    .setName('autopublish')
    .setDescription("Gère l'auto-publication des salons Announcement")
    .addSubcommand(sub => sub.setName('on').setDescription("Activer l'auto-publication"))
    .addSubcommand(sub => sub.setName('off').setDescription("Désactiver l'auto-publication"))
    .addSubcommand(sub => sub.setName('status').setDescription("Afficher l'état de l'auto-publication")),

  new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Publie le panel tickets dans le salon configure'),

  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Commande de secours pour les tickets')
    .addSubcommand(sub => sub.setName('status').setDescription("Afficher l'etat du ticket courant"))
    .addSubcommand(sub => sub.setName('close').setDescription('Fermer le ticket courant'))
    .addSubcommand(sub => sub.setName('claim').setDescription('Prendre le ticket courant'))
    .addSubcommand(sub => sub.setName('reopen').setDescription('Rouvrir le ticket courant')),

  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Gère les sauvegardes du serveur')
    .addSubcommand(sub => sub.setName('now').setDescription('Effectuer une sauvegarde immédiate'))
    .addSubcommand(sub => sub.setName('setchannel').setDescription('Définir le salon de sauvegarde')
      .addChannelOption(opt => opt.setName('channel').setDescription('Salon cible').setRequired(true)))
    .addSubcommand(sub => sub.setName('schedule').setDescription('Planifier les sauvegardes')
      .addStringOption(opt => opt.setName('frequency').setDescription('Fréquence')
        .setRequired(true)
        .addChoices(
          { name: 'Quotidien', value: 'daily' },
          { name: 'Hebdomadaire', value: 'weekly' },
        )))
    .addSubcommand(sub => sub.setName('off').setDescription('Désactiver les sauvegardes')),

  new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Configure le message de bienvenue')
    .addSubcommand(sub => sub.setName('setchannel').setDescription('Définir le salon de bienvenue')
      .addChannelOption(opt => opt.setName('channel').setDescription('Salon cible').setRequired(true)))
    .addSubcommand(sub => sub.setName('message').setDescription('Définir le message de bienvenue')
      .addStringOption(opt => opt.setName('text').setDescription('Le message ({server}, {user}, {date})').setRequired(true)))
    .addSubcommand(sub => sub.setName('off').setDescription('Désactiver le message de bienvenue'))
    .addSubcommand(sub => sub.setName('test').setDescription('Tester le message de bienvenue')),

  new SlashCommandBuilder()
    .setName('feature')
    .setDescription('Gère les modules du bot')
    .addSubcommand(sub => sub.setName('list').setDescription('Lister les modules'))
    .addSubcommand(sub => sub.setName('enable').setDescription('Activer un module')
      .addStringOption(opt => opt.setName('module').setDescription('Nom du module').setRequired(true)
        .addChoices(
          { name: 'YouTube', value: 'youtube' },
          { name: 'Shorts', value: 'shorts' },
          { name: 'Twitch', value: 'twitch' },
          { name: 'Auto Publish', value: 'autopublish' },
          { name: 'Tickets', value: 'tickets' },
          { name: 'Backups', value: 'backups' },
          { name: 'Templates', value: 'templates' },
          { name: 'Welcome', value: 'welcome' },
          { name: 'Rules', value: 'rules' },
          { name: 'Logs', value: 'logs' },
          { name: 'Suggestions', value: 'suggestions' },
          { name: 'Polls', value: 'polls' },
          { name: 'Embeds', value: 'embeds' },
          { name: 'Utility', value: 'utility' },
          { name: 'Fun', value: 'fun' },
        )))
    .addSubcommand(sub => sub.setName('disable').setDescription('Désactiver un module')
      .addStringOption(opt => opt.setName('module').setDescription('Nom du module').setRequired(true)
        .addChoices(
          { name: 'YouTube', value: 'youtube' },
          { name: 'Shorts', value: 'shorts' },
          { name: 'Twitch', value: 'twitch' },
          { name: 'Auto Publish', value: 'autopublish' },
          { name: 'Tickets', value: 'tickets' },
          { name: 'Backups', value: 'backups' },
          { name: 'Templates', value: 'templates' },
          { name: 'Welcome', value: 'welcome' },
          { name: 'Rules', value: 'rules' },
          { name: 'Logs', value: 'logs' },
          { name: 'Suggestions', value: 'suggestions' },
          { name: 'Polls', value: 'polls' },
          { name: 'Embeds', value: 'embeds' },
          { name: 'Utility', value: 'utility' },
          { name: 'Fun', value: 'fun' },
        ))),

  new SlashCommandBuilder()
    .setName('setlevel')
    .setDescription('Assigne un niveau de permission à un rôle')
    .addRoleOption(opt => opt.setName('role').setDescription('Le rôle').setRequired(true))
    .addIntegerOption(opt => opt.setName('level').setDescription('Niveau de permission (0+)').setRequired(true).setMinValue(0)),

  new SlashCommandBuilder()
    .setName('setlog')
    .setDescription('Définit le salon des logs')
    .addChannelOption(opt => opt.setName('channel').setDescription('Salon cible').setRequired(true)),

  new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('Vérifie les permissions du bot')
    .addSubcommand(sub => sub.setName('check').setDescription('Vérifier les permissions')
      .addStringOption(opt => opt.setName('target').setDescription('#salon ou "import"').setRequired(true))),

  new SlashCommandBuilder()
    .setName('sendembed')
    .setDescription('Envoie un embed personnalisé')
    .addChannelOption(opt => opt.setName('channel').setDescription('Salon cible').setRequired(true))
    .addStringOption(opt => opt.setName('spec').setDescription('Contenu: Titre | Description').setRequired(true)),

  new SlashCommandBuilder()
    .setName('template')
    .setDescription('Gère les templates')
    .addSubcommand(sub => sub.setName('save').setDescription('Sauvegarder un template')
      .addStringOption(opt => opt.setName('name').setDescription('Nom du template').setRequired(true))
      .addStringOption(opt => opt.setName('content').setDescription('Titre | Contenu').setRequired(true)))
    .addSubcommand(sub => sub.setName('send').setDescription('Envoyer un template')
      .addStringOption(opt => opt.setName('name').setDescription('Nom du template').setRequired(true))
      .addChannelOption(opt => opt.setName('channel').setDescription('Salon cible').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('Lister les templates'))
    .addSubcommand(sub => sub.setName('show').setDescription('Voir un template')
      .addStringOption(opt => opt.setName('name').setDescription('Nom du template').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Supprimer un template')
      .addStringOption(opt => opt.setName('name').setDescription('Nom du template').setRequired(true))),

  new SlashCommandBuilder()
    .setName('resetconfig')
    .setDescription('Réinitialise la configuration du serveur'),
].map(cmd => cmd.toJSON());
