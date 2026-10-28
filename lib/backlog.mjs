// The open tickets of every repo, counted for the status page: one row per entry of
// ../projects.json, with or without intake (a repo in development, this bot, the wiki), its icon, and how many open issues its repo has by type, by status, by priority
// and by source. health.mjs writes it next to status.json as backlog.json; the page draws the table.
//
// Counts only, never a title: the page is public and the mod repos are private.
//
// Where each column comes from:
//   type      the GitHub issue (the authority): `crash` and `bug` labels, RESEARCH in the title,
//             `documentation`, `enhancement`. Most tickets filed by hand carry no label, so an
//             unlabeled one falls back to its Priority in the GitHub Project, which the workspace sets
//             by type (1 crash · 2 bug · 3 cosmetic, perf, tooling · 4 feature, polish, docs, store)
//   status    the Status of the issue's item in the Project (lib/projects.mjs), matched by repo and
//             number. `needs-info` or `blocked` on the issue wins over it. An open issue that is not in
//             the Project is "Not in Project"
//   priority  the item's Priority; not in the Project, or none set, is "No priority"
//   source    `discord` label (filed by intake) or not
//   repo      `repo` in projects.json, else the <PREFIX>_GH_REPO variable intake files into
//   icon      Modrinth's icon_url, CurseForge's thumbnail for a project Modrinth has not approved
//             yet, the repo's placeholder (art/branding/icon.png, inlined as a data URI: the repo
//             is private) for one in no store, and the project's tag emoji in #mod-tickets
//             (server.json), or its `emoji`, when none of those has one
//
// Nothing here may fail the health check: each source that cannot be read is left out, and the
// reason goes into `errors`, which the page shows under the table.

import { readFileSync } from "node:fs";
import { configured, listItems, issueKey } from "./projects.mjs";
import { fetchCurseForge, tagEmoji } from "./catalog.mjs";

const UA = "intake-health (+https://github.com/manucruzleiva/intake-bots)";

/** The buckets of each dimension, in the order the page draws them. */
export const DIMENSIONS = {
	type: [
		["crash", "Crash"],
		["bug", "Bug"],
		["research", "Research"],
		["improvement", "Improvement"],
		["feature", "Feature"],
		["docs", "Docs"],
		["untriaged", "Untriaged"],
	],
	status: [
		["needs-info", "Needs info"],
		["blocked", "Blocked"],
		["in-progress", "In progress"],
		["in-review", "In review"],
		["todo", "Todo"],
		["backlog", "Backlog"],
		["triage", "Triage"],
		["unlinked", "Not in Project"],
	],
	priority: [
		["urgent", "Urgent"],
		["high", "High"],
		["medium", "Medium"],
		["low", "Low"],
		["none", "No priority"],
	],
	source: [
		["discord", "Discord"],
		["internal", "Internal"],
	],
};

// The Project's Priority options open with their number ("2 High"): the number is what is read.
const PRIORITY_KEY = ["none", "urgent", "high", "medium", "low"];
const TYPE_BY_PRIORITY = [null, "crash", "bug", "improvement", "feature"];
const priorityNumber = (name) => Number.parseInt(name || "", 10) || 0;
// The Project's Status options. An item with none yet counts as Triage: nobody has looked at it. Any
// other name (`Done` on an issue that was reopened) counts as Backlog.
const STATUS_BY_NAME = { Triage: "triage", Backlog: "backlog", Todo: "todo", "In Progress": "in-progress", "In Review": "in-review" };

async function getJson(url, headers = {}) {
	const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
	if (!res.ok) throw new Error(`${url.replace(/\?.*/, "")} -> ${res.status}`);
	return res.json();
}

/** Every open issue (no pull requests) of `repo`: labels, title, created_at. */
async function openIssues(repo, token) {
	const all = [];
	for (let page = 1; ; page++) {
		const batch = await getJson(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`, {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
		});
		all.push(...batch.filter((i) => !i.pull_request));
		if (batch.length < 100) return all;
	}
}

/** The Project's items keyed by the issue each holds (`owner/repo#N`, lowercase). */
async function projectItems() {
	const byIssue = new Map();
	for (const item of await listItems()) if (item.issue) byIssue.set(issueKey(item.issue.repo, item.issue.number), item);
	return byIssue;
}

/** Modrinth's icon per slug or id, in one request. A project still in review is missing from it. */
async function modrinthIcons(ids) {
	if (!ids.length) return new Map();
	const list = await getJson(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
	const icons = new Map();
	for (const p of list) {
		if (!p.icon_url) continue;
		icons.set(p.id, p.icon_url);
		icons.set(p.slug, p.icon_url);
	}
	return icons;
}

/** The workspace's placeholder icon, the one every mod repo carries before its store art. */
const PLACEHOLDER_ICON = "art/branding/icon.png";

/** `repo`'s placeholder icon as a data URI, or null when the repo has none. */
async function repoIcon(repo, token) {
	const res = await fetch(`https://api.github.com/repos/${repo}/contents/${PLACEHOLDER_ICON}`, {
		headers: { "User-Agent": UA, Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json" },
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`${PLACEHOLDER_ICON} -> ${res.status}`);
	return `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
}

const lastSegment =(url) => url?.replace(/\/+$/, "").split("/").pop() || null;

/** The type, status, priority and source bucket of one open issue; `item` its Project item, or null. */
export function classify(issue, item) {
	const labels = new Set((issue.labels || []).map((l) => (typeof l === "string" ? l : l.name).toLowerCase()));
	const priority = priorityNumber(item?.priority);

	let type;
	if (labels.has("crash")) type = "crash";
	else if (labels.has("bug")) type = "bug";
	else if (/\bRESEARCH\b/.test(issue.title)) type = "research";
	else if (labels.has("documentation")) type = "docs";
	else if (labels.has("enhancement")) type = "feature";
	else type = TYPE_BY_PRIORITY[priority] || "untriaged";

	let status;
	if (labels.has("needs-info")) status = "needs-info";
	else if (labels.has("blocked")) status = "blocked";
	else if (!item) status = "unlinked";
	else status = STATUS_BY_NAME[item.status] || (item.status ? "backlog" : "triage");

	return { type, status, priority: PRIORITY_KEY[priority] || "none", source: labels.has("discord") ? "discord" : "internal" };
}

const emptyCounts = () => Object.fromEntries(Object.entries(DIMENSIONS).map(([dim, buckets]) => [dim, Object.fromEntries(buckets.map(([k]) => [k, 0]))]));

/**
 * backlog.json: `projects` every entry of projects.json, `vars` the repo variables (for the ones
 * without `repo`), `token` a PAT that reads the mod repos. The Project is read with PROJECTS_TOKEN.
 */
export async function collectBacklog(projects, vars, { token }) {
	const errors = [];
	const settle = async (what, fn, fallback) => {
		try {
			return await fn();
		} catch (e) {
			errors.push(`${what}: ${e.message}`);
			return fallback;
		}
	};

	const items = configured()
		? await settle("Project", () => projectItems(), null)
		: (errors.push("Project: PROJECTS_TOKEN is not set, so status and priority are unknown"), null);

	const modrinthIds = projects.map((p) => lastSegment(p.announce?.links?.modrinth)).filter(Boolean);
	const icons = await settle("Modrinth icons", () => modrinthIcons(modrinthIds), new Map());
	let spec = {};
	try {
		spec = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
	} catch {}

	const mods = await Promise.all(projects.map(async (p) => {
		const repo = p.repo || (p.prefix && vars[`${p.prefix}_GH_REPO`]) || null;
		const links = p.announce?.links || {};
		let icon = icons.get(lastSegment(links.modrinth)) || null;
		if (!icon && links.curseforge) icon = await settle(`${p.name} CurseForge icon`, async () => (await fetchCurseForge(links.curseforge))?.icon || null, null);
		if (!icon && repo && token) icon = await settle(`${p.name} placeholder icon`, () => repoIcon(repo, token), null);
		const row = {
			dir: p.dir,
			name: p.name,
			icon,
			emoji: tagEmoji(spec, p.tag) || p.emoji || null,
			link: links.modrinth || links.curseforge || null,
			total: null,
			oldest_days: null,
			counts: null,
		};
		if (!repo) {
			errors.push(`${p.name}: no \`repo\` in projects.json and no ${p.prefix || "<PREFIX>"}_GH_REPO variable`);
			return row;
		}
		if (!token) return row;
		const issues = await settle(`${p.name} issues`, () => openIssues(repo, token), null);
		if (!issues) return row;
		const counts = emptyCounts();
		for (const issue of issues) {
			const buckets = classify(issue, items?.get(issueKey(repo, issue.number)) ?? null);
			for (const [dim, key] of Object.entries(buckets)) counts[dim][key]++;
		}
		// Without the Project every issue would read "Not in Project": say unknown instead.
		if (!items) counts.status = counts.priority = null;
		row.total = issues.length;
		row.counts = counts;
		const oldest = issues.reduce((min, i) => Math.min(min, Date.parse(i.created_at)), Infinity);
		row.oldest_days = issues.length ? Math.floor((Date.now() - oldest) / 86400000) : null;
		return row;
	}));
	if (!token) errors.push("GitHub: MODS_GH_TOKEN is not set, so no repo was read");

	return {
		generated_at: new Date().toISOString(),
		dimensions: Object.fromEntries(Object.entries(DIMENSIONS).map(([dim, buckets]) => [dim, buckets.map(([key, label]) => ({ key, label }))])),
		mods,
		errors,
	};
}
