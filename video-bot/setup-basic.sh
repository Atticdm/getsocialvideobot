#!/bin/bash

# Video Bot Basic Setup Script (without nvm)
echo "🎥 Setting up Video Bot (basic setup)..."

# Check Node.js version
NODE_VERSION=$(node --version 2>/dev/null)
if [ $? -ne 0 ]; then
    echo "❌ Node.js is not installed. Please install Node.js 20.10.0+ first."
    exit 1
fi

echo "📦 Node.js version: $NODE_VERSION"

# Check if Node.js version is sufficient
REQUIRED_MAJOR=20
CURRENT_MAJOR=$(echo $NODE_VERSION | sed 's/v\([0-9]*\).*/\1/')

if [ "$CURRENT_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
    echo "⚠️  Warning: Node.js version $NODE_VERSION is too old. Please upgrade to 20.10.0+"
fi

# Install dependencies
echo "📥 Installing dependencies..."
npm install

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚙️  Creating .env file from template..."
    cp .env.example .env
    echo "✅ .env file created. Please edit it and set your BOT_TOKEN."
else
    echo "✅ .env file already exists."
fi

# Check for required system dependencies
echo "🔍 Checking system dependencies..."

# Check yt-dlp
if command -v yt-dlp &> /dev/null; then
    echo "✅ yt-dlp is installed: $(yt-dlp --version)"
else
    echo "❌ yt-dlp is not installed. Please install it:"
    echo "   pip install yt-dlp"
    echo "   or"
    echo "   brew install yt-dlp"
fi

# Check ffmpeg
if command -v ffmpeg &> /dev/null; then
    echo "✅ ffmpeg is installed: $(ffmpeg -version | head -n1)"
else
    echo "⚠️  ffmpeg is not installed (optional but recommended)"
    echo "   Install with: brew install ffmpeg"
fi

echo ""
echo "🎉 Basic setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env file and set your BOT_TOKEN"
echo "2. Run: npm run dev (for development)"
echo "3. Or run: npm run build && npm start (for production)"
echo ""
echo "For more information, see README.md"
