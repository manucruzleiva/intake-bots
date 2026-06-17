"""
Cobblemon Picnic — Discord intake bot.

Adds /bug and /feature slash commands. Each one opens a GitHub Issue on the
configured repo so reports flow straight from the community Discord into the
project's issue tracker (and from there into commits/releases).

Env vars (see .env.example):
  DISCORD_TOKEN  – the Discord bot token
  GITHUB_TOKEN   – a GitHub token with "Issues: write" on the repo
  GITHUB_REPO    – "owner/name" (default: manucruzleiva/cobblemon-picnic)
  GUILD_ID       – optional; a server ID for instant slash-command registration
"""

import os
import logging

import aiohttp
import discord
from discord import app_commands

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("picnic-bot")

DISCORD_TOKEN = os.environ["DISCORD_TOKEN"]
GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]
GITHUB_REPO = os.environ.get("GITHUB_REPO", "manucruzleiva/cobblemon-picnic")
GUILD_ID = os.environ.get("GUILD_ID")

GH_API = f"https://api.github.com/repos/{GITHUB_REPO}"
GH_HEADERS = {
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

# label name -> (color, description); ensured on startup.
LABELS = {
    "bug": ("d73a4a", "Something isn't working"),
    "enhancement": ("a2eeef", "New feature or request"),
    "discord": ("5865F2", "Reported via the community Discord"),
}


class PicnicBot(discord.Client):
    def __init__(self) -> None:
        super().__init__(intents=discord.Intents.none())
        self.tree = app_commands.CommandTree(self)
        self.http_session: aiohttp.ClientSession | None = None

    async def setup_hook(self) -> None:
        self.http_session = aiohttp.ClientSession()
        await self._ensure_labels()
        if GUILD_ID:
            guild = discord.Object(id=int(GUILD_ID))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
            log.info("Slash commands synced to guild %s", GUILD_ID)
        else:
            await self.tree.sync()
            log.info("Slash commands synced globally (can take up to ~1h to appear)")

    async def close(self) -> None:
        if self.http_session:
            await self.http_session.close()
        await super().close()

    async def _ensure_labels(self) -> None:
        """Best-effort: create the labels we use if they don't exist yet."""
        for name, (color, desc) in LABELS.items():
            try:
                async with self.http_session.post(
                    f"{GH_API}/labels",
                    headers=GH_HEADERS,
                    json={"name": name, "color": color, "description": desc},
                ) as r:
                    if r.status not in (201, 422):  # 422 = already exists
                        log.warning("label %s: HTTP %s", name, r.status)
            except Exception as e:  # noqa: BLE001
                log.warning("could not ensure label %s: %s", name, e)

    async def create_issue(self, title: str, body: str, labels: list[str]) -> str:
        async with self.http_session.post(
            f"{GH_API}/issues",
            headers=GH_HEADERS,
            json={"title": title, "body": body, "labels": labels},
        ) as r:
            if r.status == 201:
                return (await r.json())["html_url"]
            raise RuntimeError(f"GitHub API returned HTTP {r.status}: {await r.text()}")


client = PicnicBot()


def _issue_body(kind: str, description: str, interaction: discord.Interaction,
                version: str | None) -> str:
    lines = [description, "", "---"]
    if version:
        lines.append(f"**Game/mod version:** {version}")
    lines.append(f"**Reported by:** {interaction.user} (`{interaction.user.id}`) via Discord")
    if interaction.guild:
        lines.append(f"**Server:** {interaction.guild.name}")
    lines.append(f"*Filed automatically by the Cobblemon Picnic Discord bot ({kind}).*")
    return "\n".join(lines)


@client.event
async def on_ready() -> None:
    log.info("Logged in as %s — filing issues to %s", client.user, GITHUB_REPO)


@client.tree.command(name="bug", description="Report a bug in Cobblemon Picnic (opens a GitHub issue).")
@app_commands.describe(
    title="Short summary of the bug",
    description="What happened? Steps to reproduce, what you expected, etc.",
    version="Optional: Minecraft / Cobblemon / mod version",
)
async def bug(interaction: discord.Interaction, title: str, description: str, version: str = "") -> None:
    await interaction.response.defer(ephemeral=True, thinking=True)
    try:
        url = await client.create_issue(
            f"[Bug] {title}",
            _issue_body("bug", description, interaction, version or None),
            ["bug", "discord"],
        )
        await interaction.followup.send(f"🐛 Thanks! Filed your bug report → {url}", ephemeral=True)
    except Exception as e:  # noqa: BLE001
        log.exception("failed to file bug")
        await interaction.followup.send(f"⚠️ Couldn't file the report: {e}", ephemeral=True)


@client.tree.command(name="feature", description="Request a feature for Cobblemon Picnic (opens a GitHub issue).")
@app_commands.describe(
    title="Short summary of the idea",
    description="Describe the feature and why it would be useful.",
)
async def feature(interaction: discord.Interaction, title: str, description: str) -> None:
    await interaction.response.defer(ephemeral=True, thinking=True)
    try:
        url = await client.create_issue(
            f"[Feature] {title}",
            _issue_body("feature request", description, interaction, None),
            ["enhancement", "discord"],
        )
        await interaction.followup.send(f"✨ Thanks! Filed your feature request → {url}", ephemeral=True)
    except Exception as e:  # noqa: BLE001
        log.exception("failed to file feature")
        await interaction.followup.send(f"⚠️ Couldn't file the request: {e}", ephemeral=True)


if __name__ == "__main__":
    client.run(DISCORD_TOKEN)
