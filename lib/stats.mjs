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
//
// Modrinth does keep the history, in its analytics: modrinthDaily() asks for it (the one fetch here)
// and writeModrinthDaily() keeps it as stats/modrinth-daily.json on the same branch, the whole file
// rewritten each run: { generated, start, days: { <dir>: [n, …] }, releases: [{ mod, at, version }] }.
// days[dir][i] is the downloads of the UTC day start + i, up to yesterday. The route, its body and
// its limits are in the vault (intake-bots — Technical Notes, "Las analytics de Modrinth").

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

const ANALYTICS = "https://api.modrinth.com/v3/analytics";
const UA = "intake-bots-stats (+https://github.com/manucruzleiva/intake-bots)";
const DAY = 86400000;
// Modrinth's cap per call; past it the call is a 400.
const MAX_SLICES = 1024;

async function analytics(token, start, end) {
	const res = await fetch(ANALYTICS, {
		method: "POST",
		headers: { Authorization: token, "Content-Type": "application/json", "User-Agent": UA },
		body: JSON.stringify({
			time_range: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), resolution: { minutes: 1440 } },
			// Without project_id in bucket_by, source_project comes back empty.
			return_metrics: { project_downloads: { bucket_by: ["project_id"] } },
			// Empty: every project of the token's owner.
			project_ids: [],
		}),
	});
	if (!res.ok) throw new Error(`Modrinth analytics → ${res.status} ${(await res.text()).slice(0, 200)}`);
	return res.json();
}

/**
 * Each mod's Modrinth downloads per UTC day, from the day of `first` (the oldest project's publish
 * date) to yesterday, plus the versions uploaded in that span. `mods` is [{ dir, modrinth }], where
 * `modrinth` is the last segment of the store link: a slug or an id, both of which the reply names.
 */
export async function modrinthDaily(token, mods, first, now = Date.now()) {
	const start = Math.floor(first / DAY) * DAY, end = Math.floor(now / DAY) * DAY;
	const days = {}, releases = new Map(), dirOf = new Map();
	const n = Math.max(0, (end - start) / DAY);
	for (let from = start; from < end; from += MAX_SLICES * DAY) {
		const reply = await analytics(token, from, Math.min(end, from + MAX_SLICES * DAY));
		// Only the projects with data in this span are named, so the map grows chunk by chunk.
		for (const p of Object.values(reply.projects ?? {})) {
			const mod = mods.find((m) => m.modrinth && (m.modrinth === p.id || m.modrinth === p.slug));
			if (mod) dirOf.set(p.id, mod.dir);
		}
		reply.metrics.forEach((slice, i) => {
			for (const row of slice) {
				const dir = dirOf.get(row.source_project);
				if (!dir || row.metric_kind !== "downloads") continue;
				(days[dir] ??= new Array(n).fill(0))[(from - start) / DAY + i] += row.downloads;
			}
		});
		// One upload per loader of the same version: keep the first, under the version without +loader.
		for (const e of reply.project_events ?? []) {
			const mod = dirOf.get(e.project_id);
			if (!mod || e.kind !== "version_uploaded") continue;
			const version = e.version_number.replace(/\+.*$/, ""), key = `${mod} ${version}`;
			if (!releases.has(key) || e.timestamp < releases.get(key).at) releases.set(key, { mod, at: e.timestamp, version });
		}
	}
	return {
		start: new Date(start).toISOString(),
		days,
		releases: [...releases.values()].sort((a, b) => a.at.localeCompare(b.at)),
	};
}

/** One series per line, so the branch's diffs stay readable. */
function serializeDaily({ generated, start, days, releases }) {
	const series = Object.entries(days).map(([dir, s]) => `${JSON.stringify(dir)}: ${JSON.stringify(s)}`);
	return [
		"{",
		`"generated": ${JSON.stringify(generated)},`,
		`"start": ${JSON.stringify(start)},`,
		`"days": {\n${series.join(",\n")}\n},`,
		`"releases": [\n${releases.map((r) => JSON.stringify(r)).join(",\n")}\n]`,
		"}",
		"",
	].join("\n");
}

/**
 * Writes `daily` to `file` unless only `generated` would change: the file is rewritten whole each
 * run, and a commit per run with the same numbers would bury the ones that moved. Says what it did.
 */
export function writeModrinthDaily(file, daily, generated = new Date().toISOString()) {
	const same = (a) => JSON.stringify({ start: a.start, days: a.days, releases: a.releases });
	if (existsSync(file) && same(JSON.parse(readFileSync(file, "utf8"))) === same(daily)) return "unchanged";
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, serializeDaily({ generated, ...daily }));
	const sums = Object.entries(daily.days).map(([dir, s]) => `${dir} ${s.reduce((a, b) => a + b, 0)}`);
	return `${Object.keys(daily.days).length} series since ${daily.start.slice(0, 10)} (${sums.join(", ")})`;
}
