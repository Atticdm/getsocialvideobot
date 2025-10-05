FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    python3 \
    python3-pip \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Install Python dependencies for gender detection
RUN pip3 install librosa==0.9.2

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Set ownership
RUN chown -R node:node /app
USER node

ENV NODE_OPTIONS=--enable-source-maps
EXPOSE 3000

ENV APP_MODE=bot
CMD ["sh","-lc","if [ \"$APP_MODE\" = \"web\" ]; then node dist/web/server.js; else node dist/bot/index.js; fi"]
