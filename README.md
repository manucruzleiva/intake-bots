# Cobblemon Routes — Discord → GitHub Issues intake

A tiny zero-dependency poller (Node ≥ 20) that watches the **#bug-reports forum** on Discord and files a
GitHub issue for each new forum post, then replies "tracked ✅" in the thread. It dedups via `state.json`,
inlines image attachments, and folds `.txt`/`.log`/`.json` (crash reports) into a `<details>` block before
the Discord CDN link expires. It **never links the private code repo** in Discord.

## Why a separate public repo
GitHub Actions cron is **free/unlimited on public repos** but metered on private ones. Host this poller in a
**public** repo (the wiki repo, or a new `cobblemon-routes-intake` repo) and point it at the code repo for
issues. Copy `intake.workflow.yml` to that repo's `.github/workflows/discord-intake.yml`.

## One-time setup
1. **Discord application/bot** (https://discord.com/developers/applications):
   - New Application → Bot → copy the **token**.
   - Enable the **Message Content Intent** (Bot → Privileged Gateway Intents). Required to read post text.
   - Invite the bot to the server with **View Channels**, **Read Message History**, **Send Messages**, and
     **Send Messages in Threads** on the bug-reports forum.
2. **Find the forum channel id**: enable Developer Mode in Discord, right-click the forum → Copy Channel ID.
   The server (guild) id is optional but recommended (right-click the server → Copy Server ID).
3. **GitHub PAT** with `repo` (or fine-grained: Issues = Read/Write) scope on the **code** repo.
4. In the **public host repo**:
   - Secrets: `DISCORD_BOT_TOKEN`, `DISCORD_FORUM_CHANNEL_ID`, `DISCORD_GUILD_ID` (optional),
     `ISSUES_REPO_TOKEN`.
   - Variable: `GH_ISSUES_REPO` = `owner/code-repo`.
   - Add `discord-intake/` (this folder) + the workflow.

## Run locally (test)
```bash
cd discord-intake
DISCORD_BOT_TOKEN=... DISCORD_FORUM_CHANNEL_ID=... DISCORD_GUILD_ID=... \
GH_TOKEN=... GH_ISSUES_REPO=owner/repo \
node poll.mjs
```
It prints each issue it files and writes `state.json`. Re-running is idempotent (already-seen threads are
skipped).

## Not yet wired (next steps from the playbook)
- **Auto-resolve**: a second workflow that, when a version is published on Modrinth, comments "fixed in vX"
  and locks the matching threads (or relays a maintainer `RESOLUTION:` note for client-side issues).
- Mapping a closed GitHub issue back to its Discord thread (store the thread id on the issue body/label).
