#!/bin/zsh
# Double-click this file in Finder to start MVR Presets.
# Keep the window open while you use the app. Close it (or press Ctrl+C) to stop.

cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and try again."
  read -k1 "?Press any key to close."
  exit 1
fi
if [ ! -f .env ]; then cp .env.example .env; fi
exec node --env-file=.env server.js
