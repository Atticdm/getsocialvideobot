#!/bin/bash

# Video Bot Setup Script
echo "🎥 Setting up Video Bot..."

# Check if nvm is installed
if ! command -v nvm &> /dev/null; then
    echo "❌ nvm is not installed. Please install nvm first:"
    echo "   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
    echo "   Then restart your terminal and run this script again."
    exit 1
fi

# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use the correct Node.js version
echo "📦 Setting up Node.js environment..."
nvm use

# Check if Node.js version is correct
NODE_VERSION=$(node --version)
REQUIRED_VERSION="v20.10.0"

if [[ "$NODE_VERSION" != "$REQUIRED_VERSION" ]]; then
    echo "⚠️  Warning: Node.js version is $NODE_VERSION, but $REQUIRED_VERSION is recommended"
    echo "   Run: nvm install $REQUIRED_VERSION && nvm use $REQUIRED_VERSION"
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
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env file and set your BOT_TOKEN"
echo "2. Run: npm run dev (for development)"
echo "3. Or run: npm run build && npm start (for production)"
echo ""
echo "For more information, see README.md"
