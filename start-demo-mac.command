#!/bin/bash
# Double-click this file in Finder to try Mugibot with the dummy stores.
# It checks Node.js, creates .env the first time, starts Mugibot and opens
# the dashboard. Leave the window open while you use it.

cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"

finish() {
  echo
  read -r -p "Press Return to close this window. " _
  exit "$1"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Mugibot needs Node.js, and it isn't installed on this Mac yet."
  echo "Opening nodejs.org: download the LTS version, install it,"
  echo "then double-click start-demo-mac.command again."
  open "https://nodejs.org/en/download"
  finish 1
fi

if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; then
  echo "Mugibot needs Node.js 22.13 or newer, and this Mac has $(node -v)."
  echo "Opening nodejs.org: download the LTS version, install it,"
  echo "then double-click start-demo-mac.command again."
  open "https://nodejs.org/en/download"
  finish 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env (the admin username is jamie; change ADMIN_USERNAMES in .env to use another)."
fi

node scripts/demo.js
finish $?
