# Cobblemon Picnic — Discord intake

This **public** repo runs the Discord → GitHub issue intake for
[Cobblemon Picnic](https://github.com/manucruzleiva/cobblemon-picnic). It lives here (not in the mod
repo) on purpose: **public repos get unlimited GitHub Actions minutes**, so the poller can run every
**5 minutes** for free — about as real-time as a scheduled job gets.

```
#bugs / #features  ──(every 5 min)──▶  poll-channels.mjs (Actions)  ──▶  issues in the mod repo
```

- [`poll-channels.mjs`](poll-channels.mjs) — the poller (Node, no dependencies).
- [`.github/workflows/intake.yml`](.github/workflows/intake.yml) — the 5-minute cron.
- [`intake-state.json`](intake-state.json) — last imported message id per channel (committed by the job).
- [`reporters.json`](reporters.json) — per-reporter tallies; the mod's **wiki** reads this to build its
  community credits page.

## Setup

In **Settings → Secrets and variables → Actions**:

| Type | Name | Value |
|------|------|-------|
| Secret | `DISCORD_TOKEN` | bot token (read access to the channels) |
| Secret | `MOD_REPO_TOKEN` | a PAT with **Issues: write** on the mod repo |
| Variable | `MOD_REPO` | `manucruzleiva/cobblemon-picnic` |
| Variable | `BUG_CHANNEL_ID` | the #bugs channel id |
| Variable | `FEATURE_CHANNEL_ID` | the #features channel id |

The bot must be in the server with **View Channel + Read Message History** on both channels.

## Behaviour

- First run per channel records the latest message id and imports nothing (no backfill flood);
  later runs import messages posted since.
- Each message becomes an issue labelled `bug`/`discord` or `enhancement`/`discord`, with author,
  jump-link and timestamp. The bot adds a ✅ reaction so players see it was logged.
