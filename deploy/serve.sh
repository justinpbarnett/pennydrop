#!/bin/bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
live="$HOME/.local/share/pennydrop/live"

if [ ! -e "$live/.git" ]; then
  git -C "$repo" worktree add --detach "$live" main
  ln -s "$repo/.env" "$live/.env"
  ln -s "$repo/data" "$live/data"
fi
git -C "$live" checkout --quiet --detach --force main
echo "$(date '+%F %T') deploying $(git -C "$live" log -1 --format='%h %s')"

cd "$live"
uv sync --frozen --quiet
(cd player && pnpm install --frozen-lockfile --prefer-offline --reporter=silent && pnpm build)
exec .venv/bin/pd serve
