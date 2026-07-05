FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./
RUN npm ci --production 2>/dev/null || npm install --production

# Copy source
COPY . .

# Expose server port
EXPOSE 5577

# Default command (can be overridden in docker-compose)
CMD ["node", "square-agent-server/src/server.mjs"]
