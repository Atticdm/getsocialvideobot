FROM node:20-slim

# Устанавливаем системные зависимости
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates python3 python3-pip ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# Устанавливаем Python-библиотеки для аудиоанализа
# PyTorch устанавливается отдельно для лучшего контроля версий
RUN pip3 install torch torchaudio --index-url https://download.pytorch.org/whl/cpu --break-system-packages
RUN pip3 install "numpy<2.0" --break-system-packages
RUN pip3 install librosa==0.9.2 pydub==0.25.1 pyannote.audio==3.1.1 --break-system-packages

# Создаем директорию приложения
WORKDIR /app

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
