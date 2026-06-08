# ── Stage 1 : dépendances ──────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copie uniquement les fichiers de dépendances
# (optimise le cache Docker : npm install ne relance que si package.json change)
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2 : image finale ─────────────────────────
FROM node:20-alpine AS runner

# Métadonnées
LABEL maintainer="IANLP 2026"
LABEL description="Modrex — Modérateur virtuel IA"

# Utilisateur non-root pour la sécurité
RUN addgroup -S modrex && adduser -S modrex -G modrex

WORKDIR /app

# Copie les dépendances depuis le stage précédent
COPY --from=deps /app/node_modules ./node_modules

# Copie le code source
COPY server.js ./
COPY public/   ./public/
COPY conference-data.json ./

# Propriétaire des fichiers = utilisateur non-root
RUN chown -R modrex:modrex /app

USER modrex

# Port exposé (doit correspondre à PORT dans .env)
EXPOSE 3022

# Healthcheck : vérifie que le serveur répond
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3022/ || exit 1

# Démarrage
CMD ["node", "server.js"]
