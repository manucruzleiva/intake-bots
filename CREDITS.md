# Community credits — the record

Who has reported bugs or suggested features, per project. **This file and the `reporters.json` next
to each bot are the memory**; the wiki pages under `/mod-wiki/<project>/credits/` are the display copy.

No script generates anything. The tallies used to be rendered into each wiki at build time by a
`gen_credits.py`; that was dropped (see `Reference/Publishing Standard` in the project notes). Keeping
the record in git instead means it survives, has history, and does not depend on a build step reaching
a raw GitHub URL at the right moment.

## How to update

When a release goes out, or whenever you notice the tally moved:

1. Read the project's `reporters.json` (the bots keep it current — the pollers write it).
2. Add any new names to the table below **and** to that project's `docs/credits.md`.
3. Commit. That commit is the historical record.

Do not delete names. A count can only go up, and someone who reported once stays credited.

## The bugs/features split is historical

The Discord moved to a **single tickets thread per project** — there is no separate features channel
any more. The `bugs` / `features` columns below are kept because that is how the existing tallies were
recorded; new entries just count as reports. Do not try to back-fill the distinction.

## Routes

Source: [`routes/reporters.json`](routes/reporters.json)

| Reporter | Reports | Bugs | Features |
|---|---|---|---|
| wizardcloth2 | 1 | 1 | 0 |
| phexides1999 | 1 | 1 | 0 |
| kyuilol | 1 | 0 | 1 |

> `kyuilol` was missing from the wiki page while the tally already had them — the committed page had
> drifted from the JSON. Fixed 2026-07-29.

## Picnic

Source: [`picnic/reporters.json`](picnic/reporters.json)

| Reporter | Reports | Bugs | Features |
|---|---|---|---|
| xed3355 | 4 | 2 | 2 |
| kurosock | 1 | 1 | 0 |
| airierurchin | 1 | 1 | 0 |
| shiero | 1 | 0 | 1 |

## Ditto HMs

No reports yet. That bot (`ditto-hms/bot/intake.js`) does not keep a `reporters.json` — it is the
simplest of the three pollers. If credit tracking is wanted there, it needs the tally logic the
picnic poller already has.

## Nuzlocke & Soul Link

Not released yet, so no reports. Its bot does not exist yet either — see
[`nuzlocke/README.md`](nuzlocke/README.md).
