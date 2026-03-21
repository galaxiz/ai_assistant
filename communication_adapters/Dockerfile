# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output from the build stage
COPY --from=builder /app/dist ./dist

# Drop root privileges
USER node

# Health endpoint (HEALTH_PORT env var, default 3000)
EXPOSE 3000
# Telegram webhook (TELEGRAM_WEBHOOK_PORT env var, default 8443)
EXPOSE 8443
# Slack HTTP mode (SLACK_PORT env var, default 3001)
EXPOSE 3001

CMD ["node", "dist/index.js"]
