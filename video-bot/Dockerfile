FROM node:20-slim

# Install system dependencies (python3 required for yt-dlp zipapp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    python3 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp static binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
# Install all dependencies (including dev) for build
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Create logs directory and set ownership to built-in 'node' user
RUN mkdir -p logs && chown -R node:node /app
USER node

# Enable source maps for better stack traces and debugging in production
ENV NODE_OPTIONS=--enable-source-maps

# Expose port (if needed for health checks)
EXPOSE 3000

# Start mode (bot by default). Set APP_MODE=web to run web server
ENV APP_MODE=bot
CMD ["sh","-lc","if [ \"$APP_MODE\" = \"web\" ]; then node dist/web/server.js; else node dist/bot/index.js; fi"]
