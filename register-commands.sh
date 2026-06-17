#!/usr/bin/env bash
# Registers the /bug and /feature slash commands for the Cobblemon Picnic bot.
# Run once (or after editing commands.json). Global commands take up to ~1h to appear; pass a
# GUILD_ID to register them instantly in one server instead.
#
#   DISCORD_TOKEN=... [DISCORD_APP_ID=...] [GUILD_ID=...] bash discord-bot/register-commands.sh
set -euo pipefail

APP_ID="${DISCORD_APP_ID:-1516859986414932070}"
: "${DISCORD_TOKEN:?set DISCORD_TOKEN (the bot token)}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${GUILD_ID:-}" ]; then
  URL="https://discord.com/api/v10/applications/$APP_ID/guilds/$GUILD_ID/commands"
else
  URL="https://discord.com/api/v10/applications/$APP_ID/commands"
fi

curl -sS -X PUT "$URL" \
  -H "Authorization: Bot $DISCORD_TOKEN" \
  -H "Content-Type: application/json" \
  --data @"$HERE/commands.json"
