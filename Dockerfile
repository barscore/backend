# Node 22+ required: @supabase/realtime-js needs the native WebSocket global —
# on Node 20 the client crashes at boot ("Node.js 20 detected without native
# WebSocket support").
FROM node:22-alpine

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# Lightweight healthcheck hitting /health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
