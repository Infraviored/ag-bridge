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
if command -v antigravity &> /dev/null; then
    antigravity --install-extension ag-bridge-extension.vsix --force
    antigravity --user-data-dir /home/schneider/.config/Antigravity-B --install-extension ag-bridge-extension.vsix --force
fi

if [ -f "/opt/Antigravity-IDE/bin/antigravity-ide" ]; then
    /opt/Antigravity-IDE/bin/antigravity-ide --install-extension ag-bridge-extension.vsix --force
    /opt/Antigravity-IDE/bin/antigravity-ide --user-data-dir /home/schneider/.config/Antigravity-IDE-B --install-extension ag-bridge-extension.vsix --force
    /opt/Antigravity-IDE/bin/antigravity-ide --user-data-dir /home/schneider/.config/Antigravity-IDE-C --install-extension ag-bridge-extension.vsix --force
elif [ -f "/opt/Antigravity-IDE/antigravity-ide" ]; then
    /opt/Antigravity-IDE/antigravity-ide --install-extension ag-bridge-extension.vsix --force
    /opt/Antigravity-IDE/antigravity-ide --user-data-dir /home/schneider/.config/Antigravity-IDE-B --install-extension ag-bridge-extension.vsix --force
    /opt/Antigravity-IDE/antigravity-ide --user-data-dir /home/schneider/.config/Antigravity-IDE-C --install-extension ag-bridge-extension.vsix --force
fi

echo "✨ SUCCESS: Antigravity Bridge updated!"
