# Cobblemon Ditto HM — Community Bot

Discord → GitHub Issues intake for [Cobblemon Ditto HM](https://modrinth.com/mod/cobblemon-ditto-hms).

Polls configured Discord forum channels every 5 minutes and creates GitHub Issues in the private mod repo for new threads.

## Required GitHub Secrets

Set these in **Settings → Secrets and variables → Actions** of THIS repo:

| Secret | Description |
|---|---|
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Your Discord server ID |
| `DISCORD_BUG_CHANNEL_ID` | Forum channel for bug reports |
| `DISCORD_FEATURE_CHANNEL_ID` | Forum channel for feature requests |
| `INTAKE_GITHUB_TOKEN` | PAT with `repo` scope on the private mod repo |
