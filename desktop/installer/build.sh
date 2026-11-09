#!/usr/bin/env bash
# Builds Paragon-Attendance-Setup.exe on Linux (needs: node/npm, makensis)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
NODE_VER="${NODE_VER:-22.23.4}"

echo "1/4 Building frontend"
(cd "$ROOT/frontend" && npm install --no-audit --no-fund --loglevel=error && REACT_APP_BACKEND_URL= npx react-scripts build)

echo "2/4 Server dependencies"
(cd "$ROOT/desktop/server" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

echo "3/4 Windows Node.js runtime $NODE_VER (official OpenJS build from npm)"
TMP="$(mktemp -d)"
(cd "$TMP" && npm pack "node-win-x64@$NODE_VER" --silent >/dev/null && tar -xzf node-win-x64-*.tgz)

echo "4/4 Staging + NSIS"
rm -rf "$HERE/stage" && mkdir -p "$HERE/stage/bin" "$HERE/stage/app/server" "$HERE/stage/app/public"
cp "$TMP/package/bin/node.exe" "$HERE/stage/bin/paragon-server.exe"
cp "$ROOT/desktop/server/index.js" "$ROOT/desktop/server/package.json" "$HERE/stage/app/server/"
cp -r "$ROOT/desktop/server/node_modules" "$HERE/stage/app/server/"
cp -r "$ROOT/frontend/build/." "$HERE/stage/app/public/"
cp "$HERE/README.txt" "$HERE/stage/README.txt"
(cd "$HERE" && makensis -V2 paragon.nsi)
rm -rf "$TMP"
echo "Done: $HERE/Paragon-Attendance-Setup.exe"
