// The mod catalog in #mods: one card per project of ../projects.json, kept live by catalog.yml.
//
//   node lib/catalog.mjs [--dry-run] [--prune] [--stats <file>]
//
// The n-th project is the bot's n-th oldest post in #mods (the channel id pinned in ../server.json),
// the same rule as `messages` in lib/server.mjs: a card is edited in place when what it shows
// changed, posted when it is missing, and never reposted. A bot post past the last project is an
// extra, deleted only with --prune. server.json declares #mods WITHOUT `messages`, so server.mjs
// never touches the cards.
//
// A card is an embed — the project's emoji (its tag in #tickets), name, pitch, color and icon, and
// fields for status, version, Minecraft, loaders and downloads — over the link buttons of
// lib/announce.mjs, from the project's `announce.links`.
//
// Where each piece comes from:
//   pitch      DESCRIPTION_SHORT.txt of the mod repo (<PREFIX>_GH_REPO), read with GH_TOKEN — the
//              repos are private. A repo without the file falls back to the store summary.
//   Modrinth   api.modrinth.com, the project named by `announce.links.modrinth`: version, Minecraft,
//              loaders, downloads, icon. A 404 is a project still in review (or a draft).
//   CurseForge api.cfwidget.com, keyless (the Core API needs a key the CURSEFORGE_TOKEN is not):
//              downloads, and version/Minecraft/loaders/icon when Modrinth has none.
//
// Status: Released when either store has it, plus "Modrinth: in review" — and no Modrinth button,
// which would open a 404 — while Modrinth answers 404. Downloads are compact (21.1K, as Modrinth
// shows them), so a card is edited when the visible number moves, not on every download. A mod on
// both stores gets a total above the split, compacted from the raw sum (never from two rounded
// numbers); a mod on one store keeps its single line, which already is the total.
//
// Any other failure (5xx, a cfwidget fetch still queued, a missing token) leaves that card as it is
// for this run: half-fetched data would flip it back and forth. It is a warning, and the exit code
// says it: 1 when any card was skipped or a Discord write failed.
//
// --stats appends this run's download totals to <file> (lib/stats.mjs), from the same fetches the
// cards used; catalog.yml points it at the `stats` branch. Next to it, modrinth-daily.json gets
// each mod's Modrinth downloads per day from Modrinth's analytics, and revenue-fetched.json the
// Modrinth and GitHub Sponsors revenue per month. A dry run writes no stats.
//
// Env: DISCORD_TOKEN, REPO_VARS (toJSON(vars)) and GH_TOKEN, the PAT the intake rows share, which
// reads every mod repo and, being the author's, their sponsorships. MODRINTH_ANALYTICS_TOKEN (Read
// analytics + Read payouts) for the Modrinth series and revenue; without it both are skipped with a
// warning.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projects } from "./gates.mjs";
import { appEmojis, buttonRows, pinnedChannelId, SOURCES } from "./announce.mjs";
import { client, covers, richEmbeds } from "./server.mjs";
import { modrinthDaily, record, sponsorsMonthly, writeModrinthDaily, writeRevenue } from "./stats.mjs";

export const CATALOG_CHANNEL = "mods";
const UA = "intake-bots-catalog (+https://github.com/manucruzleiva/intake-bots)";
const LOADERS = { fabric: "Fabric", neoforge: "NeoForge", forge: "Forge", quilt: "Quilt" };
const MC_VERSION = /^\d+\.\d+(\.\d+)?$/;

/** A failure that is not an answer: the card is left alone this run. */
class Transient extends Error {}

/** 21108 → "21.1K", 926 → "926": Modrinth's own rounding, one decimal, no trailing ".0". */
export function compact(n) {
	if (n < 1000) return String(n);
	const [div, unit] = n < 1e6 ? [1e3, "K"] : [1e6, "M"];
	return (Math.floor((n / div) * 10) / 10).toFixed(1).replace(/\.0$/, "") + unit;
}

/** "1.21.1" or "1.21.9 – 1.21.11": a list of Minecraft versions, as one short span. */
export function mcSpan(versions) {
	const key = (v) => v.split(".").map((p) => p.padStart(4, "0")).join(".");
	const list = [...new Set(versions)].filter((v) => MC_VERSION.test(v)).sort((a, b) => key(a).localeCompare(key(b)));
	if (!list.length) return null;
	return list.length === 1 ? list[0] : `${list[0]} – ${list.at(-1)}`;
}

const loaderNames = (list) => [...new Set(list.map((l) => LOADERS[l.toLowerCase()]).filter(Boolean))].sort().join(", ") || null;

/** The version a jar name carries: `routes-neoforge-2.0.0-beta.2.jar` → `2.0.0-beta.2`. */
export function jarVersion(name) {
	return name?.match(/-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?)(?:\+[^-]*)?\.jar$/)?.[1] ?? null;
}

async function getJson(url, headers = {}) {
	let res;
	try {
		res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
	} catch (e) {
		throw new Transient(`${url}: ${e.message}`);
	}
	if (res.status === 404) return null;
	if (!res.ok) throw new Transient(`${url} → ${res.status}`);
	return res;
}

/** The last path segment of a store link: a Modrinth slug or id, a CurseForge slug or project id. */
const lastSegment = (url) => url?.replace(/\/+$/, "").split("/").pop() || null;

/** Modrinth's project and its newest version (every loader's file of it), or null on a 404. */
export async function fetchModrinth(link) {
	const id = lastSegment(link);
	if (!id) return null;
	const res = await getJson(`https://api.modrinth.com/v2/project/${id}`);
	if (!res) return null;
	const project = await res.json();
	const versions = await (await getJson(`https://api.modrinth.com/v2/project/${id}/version?include_changelog=false`))?.json() ?? [];
	const newest = [...versions].sort((a, b) => b.date_published.localeCompare(a.date_published));
	const base = (v) => v.version_number.replace(/\+.*$/, "");
	const latest = newest.length ? newest.filter((v) => base(v) === base(newest[0])) : [];
	return {
		downloads: project.downloads,
		published: project.published,
		summary: project.description,
		body: project.body,
		links: { discord: project.discord_url ?? null, wiki: project.wiki_url ?? null, donations: (project.donation_urls ?? []).map((d) => d.url) },
		icon: project.icon_url,
		version: latest.length ? base(latest[0]) : null,
		version_at: latest[0]?.date_published ?? null,
		type: latest[0]?.version_type ?? null,
		mc: mcSpan(latest.flatMap((v) => v.game_versions)),
		loaders: loaderNames(latest.flatMap((v) => v.loaders)),
	};
}

/** cfwidget's view of the CurseForge project, or null when it does not exist. */
export async function fetchCurseForge(link) {
	const m = link?.match(/curseforge\.com\/(?:minecraft\/mc-mods\/([a-z0-9-]+)|projects\/(\d+))/);
	if (!m) return null;
	const res = await getJson(`https://api.cfwidget.com/${m[1] ? `minecraft/mc-mods/${m[1]}` : m[2]}`);
	if (!res) return null;
	// cfwidget answers 202 while it fetches a project it has not seen yet.
	if (res.status !== 200) throw new Transient(`cfwidget ${lastSegment(link)} → ${res.status}`);
	const p = await res.json();
	const files = [...(p.files ?? [])].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
	const version = jarVersion(files[0]?.name);
	const latest = files.filter((f) => jarVersion(f.name) === version);
	return {
		downloads: p.downloads?.total ?? 0,
		summary: p.summary,
		description: p.description ?? null,
		icon: p.thumbnail,
		version,
		type: files[0]?.type ?? null,
		mc: mcSpan(latest.flatMap((f) => f.versions)),
		loaders: loaderNames(latest.flatMap((f) => f.versions)),
		live: files.length > 0,
	};
}

/** DESCRIPTION_SHORT.txt from the mod repo's default branch, or null when the repo has none. */
export async function fetchPitch(repo, token) {
	if (!repo) throw new Transient("no <PREFIX>_GH_REPO");
	if (!token) throw new Transient("no GH_TOKEN");
	const res = await getJson(`https://api.github.com/repos/${repo}/contents/DESCRIPTION_SHORT.txt`, {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github.raw+json",
	});
	return res ? (await res.text()).trim() : null;
}

/** The project's emoji: the one on its tag in #tickets. */
export function tagEmoji(spec, tag) {
	const channels = [...(spec.channels ?? []), ...(spec.categories ?? []).flatMap((c) => c.channels ?? [])];
	return channels.flatMap((c) => c.available_tags ?? []).find((t) => t.name === tag)?.emoji_name ?? null;
}

/**
 * The card for one project, from what the stores answered (null = not there). Pure: everything it
 * shows is in its arguments, so the same data builds the same card and a rerun edits nothing.
 */
export function buildCard(project, { emoji, pitch, modrinth, curseforge, emojis }) {
	const links = { ...project.announce?.links };
	const onCurseForge = !!curseforge?.live;
	if (!modrinth) delete links.modrinth;
	const main = modrinth ?? (onCurseForge ? curseforge : null);

	const status = modrinth ? "Released" : onCurseForge ? "Released\nModrinth: in review" : "In review";
	const version = main?.version ? `${main.version}${main.type && main.type !== "release" ? ` (${main.type})` : ""}` : null;
	const downloads = [
		modrinth && onCurseForge && `${compact(modrinth.downloads + curseforge.downloads)} total`,
		modrinth && `${compact(modrinth.downloads)} on Modrinth`,
		onCurseForge && `${compact(curseforge.downloads)} on CurseForge`,
	].filter(Boolean).join("\n");
	const fields = [
		["Status", status],
		["Version", version],
		["Minecraft", main?.mc],
		["Loaders", main?.loaders],
		["Downloads", downloads],
	]
		.filter(([, value]) => value)
		.map(([name, value]) => ({ name, value, inline: true }));

	const description = pitch ?? modrinth?.summary ?? curseforge?.summary ?? null;
	const embed = {
		title: emoji ? `${emoji} ${project.name}` : project.name,
		...(links.modrinth || links.curseforge ? { url: links.modrinth ?? links.curseforge } : {}),
		...(description ? { description } : {}),
		...(project.announce?.color != null ? { color: project.announce.color } : {}),
		...(main?.icon ? { thumbnail: { url: main.icon } } : {}),
		fields,
	};
	return { content: "", embeds: [embed], components: buttonRows(links, { mod: project.dir, src: SOURCES.catalog, emojis }) };
}

/** Whether a live message already shows `card`: Discord adds fields of its own, never drops ours. */
export function shows(message, card) {
	return (message.content ?? "") === card.content && covers(card.embeds, richEmbeds(message)) && covers(card.components, message.components ?? []);
}

async function cardFor(project, spec, vars, emojis) {
	const links = project.announce?.links ?? {};
	const [pitch, modrinth, curseforge] = await Promise.all([
		fetchPitch(vars[`${project.prefix}_GH_REPO`], process.env.GH_TOKEN),
		fetchModrinth(links.modrinth),
		fetchCurseForge(links.curseforge),
	]);
	return {
		card: buildCard(project, { emoji: tagEmoji(spec, project.tag), pitch, modrinth, curseforge, emojis }),
		total: { mod: project.dir, modrinth: modrinth?.downloads ?? null, curseforge: curseforge?.live ? curseforge.downloads : null },
		published: modrinth?.published ? Date.parse(modrinth.published) : null,
	};
}

/**
 * Rewrites the Modrinth series next to the snapshots, from the oldest project's publish date, and
 * returns its line with the revenue per month the same call brought (null when it did not run).
 * Any failure here is a warning: the cards and the snapshot are already done, and stay green.
 */
async function modrinthSeries(file, first) {
	const token = (process.env.MODRINTH_ANALYTICS_TOKEN || "").trim();
	if (!token) {
		console.log("::warning::MODRINTH_ANALYTICS_TOKEN is not set: the Modrinth series is not updated");
		return { line: "skipped (no MODRINTH_ANALYTICS_TOKEN)", revenue: null };
	}
	if (first === Infinity) return { line: "skipped (no project answered on Modrinth)", revenue: null };
	try {
		const mods = projects.map((p) => ({ dir: p.dir, modrinth: lastSegment(p.announce?.links?.modrinth) }));
		const daily = await modrinthDaily(token, mods, first);
		return { line: writeModrinthDaily(file, daily), revenue: daily.revenue };
	} catch (e) {
		console.log(`::warning::Modrinth series: ${e.message}`);
		return { line: `failed (${e.message})`, revenue: null };
	}
}

/**
 * Rewrites the fetched revenue: Modrinth's from modrinthSeries, GitHub Sponsors' read with GH_TOKEN,
 * whose owner is the sponsored account. A source that failed keeps its last months, with a warning.
 */
async function revenueSeries(file, modrinth) {
	let sponsors = null;
	const token = (process.env.GH_TOKEN || "").trim();
	if (!token) console.log("::warning::GH_TOKEN is not set: the GitHub Sponsors revenue is not updated");
	else {
		try {
			sponsors = await sponsorsMonthly(token);
		} catch (e) {
			console.log(`::warning::GitHub Sponsors revenue: ${e.message}`);
		}
	}
	try {
		return writeRevenue(file, { modrinth, sponsors });
	} catch (e) {
		console.log(`::warning::Revenue: ${e.message}`);
		return `failed (${e.message})`;
	}
}

async function main(argv) {
	const dryRun = argv.includes("--dry-run");
	const prune = argv.includes("--prune");
	const statsAt = argv.indexOf("--stats");
	const statsFile = statsAt >= 0 ? argv[statsAt + 1] : null;
	if (statsAt >= 0 && !statsFile) throw new Error("--stats needs a file");
	const token = process.env.DISCORD_TOKEN;
	if (!token) throw new Error("DISCORD_TOKEN is required");
	const vars = JSON.parse(process.env.REPO_VARS || "{}");
	const spec = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
	const channelId = pinnedChannelId(CATALOG_CHANNEL, spec);
	const api = client(token, { apply: !dryRun });

	const me = await api.get("/users/@me");
	const recent = await api.get(`/channels/${channelId}/messages?limit=100`);
	const have = recent.filter((m) => m.author.id === me.id).reverse();
	const emojis = await appEmojis(token);

	const lines = [];
	const totals = [];
	let first = Infinity;
	let failed = 0;
	for (const [i, project] of projects.entries()) {
		const cur = have[i];
		let card, total, published;
		try {
			({ card, total, published } = await cardFor(project, spec, vars, emojis));
			if (published) first = Math.min(first, published);
		} catch (e) {
			if (!(e instanceof Transient)) throw e;
			failed++;
			lines.push(`! ${project.name}: left as it is (${e.message})`);
			console.log(`::warning::${project.name}: ${e.message}`);
			continue;
		}
		totals.push(total);
		const sign = !cur ? "+" : shows(cur, card) ? "=" : "~";
		lines.push(`${sign} ${project.name}: ${card.embeds[0].fields.map((f) => `${f.name} ${f.value.replace(/\n/g, " / ")}`).join(" · ")}`);
		if (sign === "=" || dryRun) continue;
		const body = { ...card, allowed_mentions: { parse: [] } };
		try {
			if (cur) await api.write("PATCH", `/channels/${channelId}/messages/${cur.id}`, body);
			else await api.write("POST", `/channels/${channelId}/messages`, body);
		} catch (e) {
			failed++;
			lines.push(`! ${project.name}: ${e.message}`);
		}
	}
	for (const x of have.slice(projects.length)) {
		lines.push(`${prune ? "-" : "?"} extra bot message ${x.id}${prune ? "" : " (kept; --prune deletes it)"}`);
		if (prune && !dryRun) await api.write("DELETE", `/channels/${channelId}/messages/${x.id}`);
	}

	if (statsFile && !dryRun) {
		const added = record(statsFile, totals);
		lines.push(`  stats: ${added.length ? added.map((r) => r.mod).join(", ") : "no total moved"}`);
		const series = await modrinthSeries(join(dirname(statsFile), "modrinth-daily.json"), first);
		lines.push(`  modrinth daily: ${series.line}`);
		lines.push(`  revenue: ${await revenueSeries(join(dirname(statsFile), "revenue-fetched.json"), series.revenue)}`);
	}

	const changes = lines.filter((l) => "+~-".includes(l[0])).length;
	const head = `#${CATALOG_CHANNEL} [${dryRun ? "dry run" : "apply"}]: ${changes ? `${changes} change(s)` : "nothing to do"}`;
	console.log(head);
	for (const l of lines) console.log(l);
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### ${head}`, "", "```diff", ...lines, "```", ""].join("\n") + "\n");
	}
	if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
}
