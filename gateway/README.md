# Cobblemon Picnic — Discord intake bot

A tiny [discord.py](https://discordpy.readthedocs.io/) bot that lets players file reports from your
Discord with slash commands, opening a **GitHub Issue** for each:

- **`/bug title description [version]`** → issue labelled `bug`, `discord`
- **`/feature title description`** → issue labelled `enhancement`, `discord`

Reports land in [`manucruzleiva/cobblemon-picnic`](https://github.com/manucruzleiva/cobblemon-picnic/issues),
so they tie straight into commits and releases (e.g. `closes #12` in a commit closes the report).
Replies are **ephemeral** (only the reporter sees them) and include the new issue's link.

## 1. Create the Discord bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy it → this is `DISCORD_TOKEN`. (No privileged intents needed.)
3. **Installation** (or OAuth2 → URL Generator) → scopes **`bot`** + **`applications.commands`** →
   open the generated URL to add the bot to your server.

## 2. Create the GitHub token

- A **fine-grained PAT** ([github.com/settings/tokens](https://github.com/settings/tokens?type=beta)):
  - **Repository access:** only `manucruzleiva/cobblemon-picnic`
  - **Permissions → Issues:** **Read and write**
- Copy it → this is `GITHUB_TOKEN`.

## 3. Configure

```bash
cp .env.example .env
# edit .env and fill DISCORD_TOKEN, GITHUB_TOKEN (GUILD_ID optional but recommended)
```

Setting **`GUILD_ID`** (your server's ID — enable Developer Mode in Discord, right-click the server →
Copy Server ID) makes the slash commands appear **instantly** in that server. Without it, global
commands can take up to ~1 hour to show up.

## 4. Run

=== "Locally"

    ```bash
    python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
    pip install -r requirements.txt
    python bot.py
    ```

=== "Docker"

    ```bash
    docker build -t picnic-bot .
    docker run --env-file .env picnic-bot
    ```

=== "Railway / Fly.io"

    Deploy this folder; set `DISCORD_TOKEN`, `GITHUB_TOKEN`, `GITHUB_REPO`, (`GUILD_ID`) as service
    variables. Start command: `python bot.py`. Both have free tiers that suit a small bot.

The bot **ensures the labels** (`bug`, `enhancement`, `discord`) exist on the repo at startup, so you
don't have to create them by hand.

## Security

- The **`.env` is gitignored** — never commit real tokens.
- Use a **least-privilege** GitHub token (Issues-only, single repo).
- If a token leaks, rotate it (Discord: Reset Token; GitHub: revoke the PAT).
