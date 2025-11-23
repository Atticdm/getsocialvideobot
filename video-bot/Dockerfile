FROM node:20-slim

# Устанавливаем системные зависимости
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates python3 python3-pip ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем yt-dlp (фиксированная версия 2025.9.5 для совместимости с Instagram)
# Используем конкретную версию вместо latest, чтобы избежать проблем с требованиями cookies
# Версия 2025.9.5 работает без cookies для публичных Reels, в отличие от более новых версий (2025.11.12+)
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp==2025.9.5

# Устанавливаем Python-библиотеки (оставляем только лёгкие зависимости для анализатора)
# Сначала копируем requirements, чтобы использовать слой кеша
WORKDIR /app
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Копируем и устанавливаем Node.js зависимости
COPY package*.json ./
RUN npm ci

# Копируем исходный код
COPY . .

# Собираем TypeScript
RUN npm run build

# Устанавливаем права
RUN chown -R node:node /app
USER node

ENV NODE_OPTIONS=--enable-source-maps
EXPOSE 3000

ENV APP_MODE=bot
CMD ["sh","-lc","if [ \"$APP_MODE\" = \"web\" ]; then node dist/web/server.js; else node dist/bot/index.js; fi"]
