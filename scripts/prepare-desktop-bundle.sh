#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ;;
  *) echo "unsupported desktop bundle platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

fish -ic "cd '$root/frontend'; nvm use lts; npm ci; npm run build"

# Vite empties dist before each build; keep the tracked placeholder so a
# packaging run does not leave the worktree with a deleted file.
touch "$root/frontend/dist/.gitkeep"
