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
//
// The same call brings Modrinth's revenue, and sponsorsMonthly() builds GitHub Sponsors' from the
// sponsorship events. writeRevenue() keeps both as stats/revenue-fetched.json, one month per line:
// { generated, months: { "2026-10": { modrinth, sponsors } } }, in USD. CurseForge has no API for
// its rewards: its months are kept by hand in revenue.json at the repo root, which the page reads.

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

// A project's `dir` that changed: its old rows are moved to the new key on the next write, so the
// page (which matches rows to projects.json by `dir`) keeps the mod's whole history.
// modrinth-daily.json needs nothing: it is rewritten whole each run under the current `dir`.
export const RENAMED = { "ditto-hms": "cobblemon-hms" };

/** Appends the rows `current` adds to `file` (created on the first run), and returns them. */
export function record(file, current, at = new Date().toISOString()) {
	const stored = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
	const prior = stored.map((r) => (RENAMED[r.mod] ? { ...r, mod: RENAMED[r.mod] } : r));
	const added = nextRows(prior, current, at);
	if (added.length || stored.some((r) => RENAMED[r.mod])) {
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
			// Without project_id in bucket_by, source_project comes back empty. Revenue needs the
			// PAT's "Read payouts" on top of "Read analytics": without it the whole call is a 401.
			return_metrics: { project_downloads: { bucket_by: ["project_id"] }, project_revenue: { bucket_by: ["project_id"] } },
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
 * `revenue` is the USD per UTC month of every project of the token's owner, as Modrinth's own
 * revenue page sums it, listed or not in `mods`.
 */
export async function modrinthDaily(token, mods, first, now = Date.now()) {
	const start = Math.floor(first / DAY) * DAY, end = Math.floor(now / DAY) * DAY;
	const days = {}, releases = new Map(), dirOf = new Map(), revenue = {};
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
				// A decimal string ("200.00"); rounded to the cent once the month is summed.
				if (row.metric_kind === "revenue") {
					const month = monthOf(from + i * DAY);
					revenue[month] = (revenue[month] ?? 0) + Number(row.revenue);
					continue;
				}
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
		revenue: cents(revenue),
	};
}

/** "2026-10", the UTC month of a timestamp (ms or ISO). */
const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
const nextMonth = (m) => monthOf(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1));
/** Each month's sum rounded to the cent; an empty month is left out. */
const cents = (months) => Object.fromEntries(Object.entries(months).map(([m, v]) => [m, Math.round(v * 100) / 100]).filter(([, v]) => v));

const GRAPHQL = "https://api.github.com/graphql";
const ACTIVITIES = `query($after: String) {
  viewer {
    sponsorsActivities(first: 100, after: $after, period: ALL, includePrivate: true, orderBy: { field: TIMESTAMP, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        action timestamp
        sponsor { ... on User { login } ... on Organization { login } }
        sponsorsTier { monthlyPriceInDollars isOneTime }
      }
    }
  }
}`;

/**
 * The months a sponsorship's events put money in. A one-time tier counts once, in its month. A
 * monthly tier counts its price every month from the one it starts in to the one before it is
 * cancelled — GitHub cancels at the end of the paid month — or to `now` while it runs; a tier change
 * moves the price from its month on. Refunds and pending changes are not counted.
 */
export function sponsorsMonths(events, now = Date.now()) {
	const out = {}, running = new Map();
	const add = (m, usd) => (out[m] = (out[m] ?? 0) + usd);
	const close = (who, until) => {
		const r = running.get(who);
		if (!r) return;
		// At least the starting month: it was paid even when cancelled within it.
		for (let m = r.from; m === r.from || m < until; m = nextMonth(m)) add(m, r.usd);
		running.delete(who);
	};
	for (const e of events) {
		const who = e.sponsor?.login ?? "(private)", month = monthOf(e.timestamp), tier = e.sponsorsTier;
		if (e.action === "NEW_SPONSORSHIP" && tier?.isOneTime) add(month, tier.monthlyPriceInDollars);
		else if (e.action === "NEW_SPONSORSHIP" || e.action === "TIER_CHANGE") {
			// A tier change in the starting month replaces the price instead of paying it twice.
			if (running.get(who)?.from === month) running.delete(who);
			close(who, month);
			if (tier && !tier.isOneTime) running.set(who, { from: month, usd: tier.monthlyPriceInDollars });
		} else if (e.action === "CANCELLED_SPONSORSHIP") close(who, month);
	}
	for (const who of [...running.keys()]) close(who, nextMonth(monthOf(now)));
	return cents(out);
}

/** GitHub Sponsors' USD per month for the owner of `token`, from every sponsorship event. */
export async function sponsorsMonthly(token, now = Date.now()) {
	const events = [];
	for (let after = null; ; ) {
		const res = await fetch(GRAPHQL, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": UA },
			body: JSON.stringify({ query: ACTIVITIES, variables: { after } }),
		});
		if (!res.ok) throw new Error(`GitHub Sponsors → ${res.status} ${(await res.text()).slice(0, 200)}`);
		const { data, errors } = await res.json();
		if (errors?.length) throw new Error(`GitHub Sponsors → ${errors.map((e) => e.message).join("; ")}`);
		const page = data.viewer.sponsorsActivities;
		events.push(...page.nodes);
		if (!page.pageInfo.hasNextPage) break;
		after = page.pageInfo.endCursor;
	}
	return sponsorsMonths(events, now);
}

/**
 * Writes the fetched revenue to `file`: `sources` is { modrinth, sponsors }, each { month: usd } or
 * null when it could not be fetched this run, in which case the file keeps that source's last
 * months — a missing scope must not read as a month with no income. Unchanged numbers are not
 * rewritten, as in writeModrinthDaily. Says what it did.
 */
export function writeRevenue(file, sources, generated = new Date().toISOString()) {
	const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).months : {};
	const months = {};
	for (const source of ["modrinth", "sponsors"]) {
		const got = sources[source] ?? Object.fromEntries(Object.entries(prior).map(([m, v]) => [m, v[source]]).filter(([, v]) => v));
		for (const [m, usd] of Object.entries(got)) (months[m] ??= { modrinth: 0, sponsors: 0 })[source] = usd;
	}
	const sorted = Object.fromEntries(Object.entries(months).sort(([a], [b]) => a.localeCompare(b)));
	if (JSON.stringify(sorted) === JSON.stringify(prior)) return "unchanged";
	mkdirSync(dirname(file), { recursive: true });
	const lines = Object.entries(sorted).map(([m, v]) => `${JSON.stringify(m)}: ${JSON.stringify(v)}`);
	writeFileSync(file, `{\n"generated": ${JSON.stringify(generated)},\n"months": {\n${lines.join(",\n")}\n}\n}\n`);
	const total = (s) => Object.values(sorted).reduce((n, v) => n + v[s], 0).toFixed(2);
	return `${lines.length} month(s): modrinth $${total("modrinth")}, sponsors $${total("sponsors")}`;
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

// The apps of projects.json (an `app` block: PAB, OTO, CCV, TCGKB) have no store. Their numbers are
// GitHub's: the downloads of every release asset, which the catalog already reads for the #apps card,
// and the repo's traffic (views and unique visitors per UTC day). GitHub keeps the traffic 14 days
// only, so each run merges what it answers into stats/apps-daily.json on the stats branch:
// { generated, apps: { <dir>: { downloads: { "2026-11-10": total }, kinds: { "2026-11-10": { exe, portable, update } },
//   versions: { "1.4.2": { exe, portable, update } }, views: { "2026-11-09": [views, uniques] } } } }.
// downloads[day] and kinds[day] are running totals at that day's last run: the page takes deltas.
// kinds splits them by asset kind (lib/catalog.mjs assetKind), "update" being the updater's checks;
// versions is the latest split per release, rewritten each run.

/**
 * A repo's views per UTC day for the last 14 days, as { "2026-11-09": [views, uniques] }. The token
 * needs push access to the repo (a fine-grained PAT: "Administration: read"); without it GitHub
 * answers 403 and this throws.
 */
export async function fetchTraffic(repo, token) {
	const res = await fetch(`https://api.github.com/repos/${repo}/traffic/views?per=day`, {
		headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": UA },
	});
	if (!res.ok) throw new Error(`${repo} traffic → ${res.status} ${(await res.text()).slice(0, 120)}`);
	const { views = [] } = await res.json();
	return Object.fromEntries(views.map((v) => [v.timestamp.slice(0, 10), [v.count, v.uniques]]));
}

/**
 * The apps file after this run: `current` is [{ dir, downloads, versions, views }], where downloads is
 * the release total and versions its split (both null: no releases, or the fetch failed), and views
 * what fetchTraffic answered (null:
 * not fetched). A null keeps the app's prior days: a failed fetch must not read as a quiet day.
 * Pure: writeApps writes it.
 */
export function mergeApps(prior, current, at) {
	const day = at.slice(0, 10), apps = structuredClone(prior);
	for (const { dir, downloads, versions, views } of current) {
		const app = (apps[dir] ??= { downloads: {}, views: {} });
		if (downloads != null) app.downloads[day] = downloads;
		if (versions) {
			const kinds = {};
			for (const v of Object.values(versions)) for (const [k, n] of Object.entries(v)) kinds[k] = (kinds[k] ?? 0) + n;
			(app.kinds ??= {})[day] = kinds;
			app.versions = versions;
		}
		if (views) Object.assign(app.views, views);
		app.views = Object.fromEntries(Object.entries(app.views).sort(([a], [b]) => a.localeCompare(b)));
	}
	return apps;
}

/** Merges `current` into `file` (see mergeApps) unless nothing moved, and says what it did. */
export function writeApps(file, current, generated = new Date().toISOString()) {
	const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).apps : {};
	const apps = mergeApps(prior, current, generated);
	if (JSON.stringify(apps) === JSON.stringify(prior)) return "unchanged";
	mkdirSync(dirname(file), { recursive: true });
	const lines = Object.entries(apps).map(([dir, a]) => `${JSON.stringify(dir)}: ${JSON.stringify(a)}`);
	writeFileSync(file, `{\n"generated": ${JSON.stringify(generated)},\n"apps": {\n${lines.join(",\n")}\n}\n}\n`);
	return current.map((c) => `${c.dir} ${c.downloads ?? "—"} dl${c.views ? `, ${Object.keys(c.views).length} day(s) of views` : ""}`).join(", ");
}
