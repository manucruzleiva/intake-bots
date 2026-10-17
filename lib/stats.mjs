// The download snapshots: each catalog run's store totals, kept so a chart over time has data.
// Neither store gives that history for free (cfwidget only answers the current total).
//
// lib/catalog.mjs calls record() with what it already fetched for the cards; nothing here fetches.
// The file lives on the orphan branch `stats` of this repo, never on main: catalog.yml mounts that
// branch as a worktree, this writes stats/downloads.json in it, and the workflow pushes it.
//
// One row per mod per run, { at, mod, modrinth, curseforge }: `mod` is the project's `dir`, a store
// the mod is not on is null. A row is written only when one of the mod's numbers moved since its
// last row, so a quiet mod adds nothing and the file grows by a few rows a day. A mod whose fetch
// failed this run brings no row: half a snapshot would read as a store going to null.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The rows `current` adds to `prior`: one per mod whose numbers differ from its last row. */
export function nextRows(prior, current, at) {
	const last = new Map(prior.map((r) => [r.mod, r]));
	return current
		.filter(({ mod, modrinth, curseforge }) => {
			const was = last.get(mod);
			return !was || was.modrinth !== modrinth || was.curseforge !== curseforge;
		})
		.map(({ mod, modrinth, curseforge }) => ({ at, mod, modrinth, curseforge }));
}

/** A JSON array with one row per line: the branch's diffs show the rows a run added. */
export const serialize = (rows) => (rows.length ? `[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n` : "[]\n");

/** Appends the rows `current` adds to `file` (created on the first run), and returns them. */
export function record(file, current, at = new Date().toISOString()) {
	const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
	const added = nextRows(prior, current, at);
	if (added.length) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, serialize([...prior, ...added]));
	}
	return added;
}
