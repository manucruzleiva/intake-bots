# Cobblemon Picnic — Discord bot (serverless)

A tiny **Vercel Edge Function** ([`api/interactions.js`](api/interactions.js)) that lets players
file reports from Discord with slash commands, opening a **GitHub issue** for each:

- **`/bug title description [version]`** → issue labelled `bug`, `discord`
- **`/feature title description`** → issue labelled `enhancement`, `discord`

It runs **serverless** — Discord POSTs each interaction to the function, which verifies the
Ed25519 signature and creates the issue. No always-on server, free, zero maintenance. Issues land in
[`manucruzleiva/cobblemon-picnic`](https://github.com/manucruzleiva/cobblemon-picnic/issues).

```
Discord ──(slash command)──▶ Vercel function ──▶ GitHub issue
        ◀──(ephemeral reply with the link)──
```

## Deploy (one-time)

### 1. Import into Vercel
[vercel.com/new](https://vercel.com/new) → **Import** this repo (`cobblemon-picnic-bot`).
Framework preset: **Other**. Deploy.

### 2. Set Environment Variables
Project → **Settings → Environment Variables** (Production), then **redeploy**:

| Name | Value |
|------|-------|
| `DISCORD_PUBLIC_KEY` | Discord Developer Portal → your app → **General Information → Public Key** |
| `GITHUB_TOKEN` | a fine-grained PAT with **Issues: Read and write** on the repo |
| `GITHUB_REPO` | `manucruzleiva/cobblemon-picnic` |

### 3. Point Discord at it
Developer Portal → **General Information → Interactions Endpoint URL** =
`https://<your-project>.vercel.app/api/interactions` → **Save**. Discord sends a test PING; the
function answers and the URL is accepted.

### 4. Register the slash commands (once)
```bash
DISCORD_TOKEN=<your bot token> bash register-commands.sh
# add GUILD_ID=<server id> before the command to register instantly in one server
```

Then try `/bug` in your server. Every push to this repo auto-redeploys.

## Notes

- Secrets (`GITHUB_TOKEN`) live **only** in Vercel env vars — never committed.
- The labels `bug` / `enhancement` / `discord` must exist on the repo (already created).
- App ID is baked into `register-commands.sh` (`1516859986414932070`); override with `DISCORD_APP_ID`.
