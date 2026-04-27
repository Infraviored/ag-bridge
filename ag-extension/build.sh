#!/bin/bash
set -e
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
echo "🚀 Starting Antigravity Bridge Build (v$VERSION)..."

# 1. Compile TypeScript
echo "🔨 Compiling TypeScript..."
npm run compile

# 2. Force Copy bridge.js and assets to dist
echo "📂 Syncing assets to dist..."
mkdir -p dist
cp src/bridge.js dist/bridge.js
cp assets/icon.png dist/icon.png
cp assets/agbridge-icon.png dist/agbridge-icon.png

# 3. Apply the Node 18 Hotpatch
echo "🩹 Applying environment patches (undici fix)..."
UNDICI_FILE="node_modules/undici/lib/web/webidl/index.js"
if [ -f "$UNDICI_FILE" ]; then
    sed -i 's/webidl.is.File = webidl.util.MakeTypeAssertion(File)/webidl.is.File = webidl.util.MakeTypeAssertion(typeof File !== "undefined" ? File : undefined)/' "$UNDICI_FILE"
    echo "✅ Patch applied to $UNDICI_FILE"
fi

# 4. Package to VSIX
echo "📦 Packaging VSIX..."
rm -f ag-bridge-extension.vsix
./node_modules/.bin/vsce package --out ag-bridge-extension.vsix

# 5. Install
echo "🚚 Installing to Profiles..."
antigravity --install-extension ag-bridge-extension.vsix
antigravity --user-data-dir /home/schneider/.config/Antigravity-B --install-extension ag-bridge-extension.vsix

echo "✨ SUCCESS: Antigravity Bridge updated!"
