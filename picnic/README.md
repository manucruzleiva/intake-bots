# Picnic — Discord → GitHub Issues intake

Zero-dependency poller (Node ≥ 20) that watches the **tickets forum** of Cobblemon Picnic on Discord
and files an issue in `manucruzleiva/cobblemon-picnic` for each new post, replying in the thread. It
is the **same `poll.mjs`** as the other three bots — only the `User-Agent` differs.

## What changed

Until 2026-07-31 this bot had its own script, `poll-channels.mjs`, from back when the Discord had a
`#bugs` channel and a `#features` channel and a ticket's **type came from the channel it was posted
in**. There is one tickets forum per project now, and the type comes from the post's tag — **Bug**,
**Crash**, **Idea** or **Feedback** — so that design no longer applied: everything arrived labelled
`bug` and got re-triaged by hand.

Two things were carried over rather than dropped:

- **`reporters.json`**, the per-reporter tally the wiki's community-credits page reads. The shared
  poller maintains it now, so all four mods get credits instead of just this one.
- The old state. `intake-state.json` kept a **high-water mark** (`lastId`) rather than the list of
  posts, so it cannot be converted into the list `poll.mjs` uses. The workflow passes that id as
  `SKIP_BEFORE_ID` instead: snowflakes are chronological, so everything below it was already filed.
  Without it, the first run would file every archived post in the forum a second time.

What was lost is small: the old script pulled **every message** of a thread into the issue body,
where the shared one takes the opening post and its attachments. The rest of the thread is usually
discussion, and it stays one click away in Discord.

## Configuration

Everything lives in the `intake-bots` repo; there is nothing to install here.

| | |
|---|---|
| Secrets | `PICNIC_DISCORD_TOKEN`, `PICNIC_GH_TOKEN` |
| Variables | `PICNIC_TICKETS_CHANNEL_ID`, `PICNIC_GH_REPO`, `DISCORD_GUILD_ID` (shared) |
| State | `state.json` and `reporters.json`, committed by the workflow itself |

`DISCORD_GUILD_ID` is not optional in practice: without it the bot only sees archived threads, so a
fresh report waits for Discord to archive it.

## Running it by hand

```bash
gh workflow run intake-picnic.yml --repo manucruzleiva/intake-bots
```
