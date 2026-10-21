# Project Goal — Intake Bots (Computah)

## Mission
Run the community side of every mod from one place. Computah turns player reports posted in Discord
into actionable, correctly routed development issues and keeps the reporter in the loop; it also keeps
the Discord server itself in the declared shape, announces every new mod version, and keeps each mod's
store pages (Modrinth and CurseForge) in step with the text and media the mod repo declares. Every
player-facing surface outside the game is either written by this bot or checked by it.

## Pillars

### 1. Intake (feedback → development loop)
A scheduled poller discovers new reports, identifies the intended project from explicit tags, and
creates or updates the corresponding issue in the appropriate repository. Maintainer replies reach the
original discussion, and reporters receive meaningful release notifications when fixes ship. Unrouted
reports receive a helpful request for the missing classification rather than disappear.

### 2. Discord server management
The whole guild — roles, categories, channels, permission overwrites, forum tags, the bot's fixed
messages, AutoMod, welcome screen and onboarding — is declared in the repository and reconciled from
it. Layout changes are reviewed commits, not clicks nobody remembers. Drift between the declaration and
the live server is detected and reported; community roles the bot owns (release pings, Bug Catcher)
are granted from data; read-only channels such as the mod catalog are kept current by the bot.

### 3. Release publication
When a mod's stores accept a new version, the mod repository signals the bot, and the bot publishes the
announcement: one card per version in `#announcements`, built from the mod's changelog at that tag,
pinging only the mod's opt-in role. Mod repositories never talk to Discord themselves. The same
release closes the loop with the reporters whose fixes shipped in it.

### 4. Store pages
Each mod repository is the single source of its store presence: long description, short summary,
links, license and gallery. The bot pushes that source to every store that has an API for it and
reports, with an actionable checklist, what must be updated by hand where no API exists (CurseForge).
A store page that drifted from its source is detected, not discovered by a player.

## Product Scope
A lightweight, reliable automation service, running on GitHub Actions, that polls Discord ticket
forums, routes reports to project repositories, handles maintainer replies, tracks release follow-up,
reconciles the Discord server, publishes release announcements, syncs store pages, collects intake and
download metrics, and maintains an optional planning mirror. Project-specific behavior is data-driven
(`projects.json`, `server.json`, and the files each mod repo owns) so a new project or a new surface
is added without rewriting the workflow.

## Quality Principles
- Avoid duplicate issues, replies, announcements and store writes across retries.
- Preserve reporter context and link discussions to the resulting work item.
- Treat external content as untrusted input — including dispatch payloads from mod repositories — and
  use narrowly scoped credentials, one per surface where the platform allows it.
- Pace polling and writes to respect API limits and prevent automation loops.
- Dry run by default for anything that changes a public surface; destructive changes (deleting a
  channel, a role, a store image) need an explicit opt-in.
- Make failures, skipped projects, unrouted posts, drift and operational metrics observable.
- Keep automation idempotent and safe to rerun.
- One copy of each format: a message, a card or a store text has exactly one producer.

## Success Criteria
- Valid reports are routed to the intended project with their context intact.
- Missing or invalid tags are handled visibly and respectfully.
- Maintainer replies and release notifications reach the right conversation.
- The live Discord server matches `server.json`, and any drift is reported within a day.
- Every published version gets exactly one announcement card, from every mod, through the same path.
- Every mod's Modrinth page matches its repository's source; CurseForge differences are listed as a
  to-do, never silently left behind.
- Scheduled runs can recover from transient failures without duplicating work.
- Operators can see project-level activity and diagnose failures quickly.
- Adding a project is a controlled configuration change rather than a code fork.

## Boundaries
This system automates intake, community operations and publication; it does not decide whether a
report is valid, prioritize engineering work autonomously, moderate members on its own judgment, write
marketing copy, or replace human support judgment. It never uploads mod jars: building and uploading
versions stays in each mod's own `publish.yml`, which holds the store upload credentials. Reliability,
traceability, and respectful communication matter more than maximizing polling frequency.
