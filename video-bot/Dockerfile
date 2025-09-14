FROM node:20-slim

# Install system dependencies (use apt for yt-dlp to avoid PEP 668)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    python3 \
    ffmpeg \
    yt-dlp \
    && rm -rf /var/lib/apt/lists/*

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

# Create logs directory
RUN mkdir -p logs

# Create non-root user
RUN useradd -m -u 1000 botuser && chown -R botuser:botuser /app
USER botuser

# Expose port (if needed for health checks)
EXPOSE 3000

# Start the application
CMD ["node", "dist/bot/index.js"]
