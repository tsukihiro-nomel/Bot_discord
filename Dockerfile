# Dockerfile pour exécuter le bot Discord sur Fly.io ou toute autre plate‑forme
FROM node:22-alpine

# Crée un répertoire de travail dans l'image
WORKDIR /app

# Copie le fichier package.json et installe uniquement les dépendances de production
COPY package.json ./
RUN npm install --production

# Copie le reste du code source dans l'image
COPY . .

# Le conteneur démarre le bot via la commande suivante
CMD ["node", "index.js"]