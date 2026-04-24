#!/bin/bash
# Antigravity Bridge - Environment-Proof Build Script
# This script handles the "Node 18 Undici Patch" automatically.

set -e

# Change to script directory
cd "$(dirname "$0")"

echo "🚀 Starting Antigravity Bridge Build (v$(node -p "require('./package.json').version"))..."

# 1. Compile TypeScript
echo "🔨 Compiling TypeScript..."
npm run compile

# 2. Apply the Node 18 Hotpatch (Fixes 'ReferenceError: File is not defined' in undici)
echo "🩹 Applying environment patches (undici fix)..."
UNDICI_FILE="node_modules/undici/lib/web/webidl/index.js"
if [ -f "$UNDICI_FILE" ]; then
    sed -i 's/webidl.is.File = webidl.util.MakeTypeAssertion(File)/webidl.is.File = webidl.util.MakeTypeAssertion(typeof File !== "undefined" ? File : undefined)/' "$UNDICI_FILE"
    echo "✅ Patch applied to $UNDICI_FILE"
else
    echo "⚠️ undici library not found in node_modules. Skipping patch."
fi

# 3. Package to VSIX
# We use the local vsce version to avoid 'npx' environment drift
echo "📦 Packaging VSIX..."
./node_modules/.bin/vsce package --out ag-bridge-extension.vsix

# 4. Install to Antigravity (Profile A)
echo "🚚 Installing to Profile A..."
antigravity --install-extension ag-bridge-extension.vsix

# 5. Install to Antigravity (Profile B)
echo "🚚 Installing to Profile B..."
antigravity --user-data-dir /home/schneider/.config/Antigravity-B --install-extension ag-bridge-extension.vsix

echo "✨ SUCCESS: Antigravity Bridge updated in both profiles!"
