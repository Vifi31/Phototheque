#!/bin/sh
# Photothèque — lanceur macOS / Linux (paquet multiplateforme : Node.js 24 ou plus récent requis).
cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then echo "Node.js 24 introuvable : https://nodejs.org/"; exit 1; fi
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund || exit 1
exec node scripts/lancer.mjs "$@"
