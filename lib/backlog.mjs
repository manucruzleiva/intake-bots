// The open tickets of every mod, counted for the status page: one row per project of
// ../projects.json, its icon, and how many open issues its repo has by type, by status, by priority
// and by source. health.mjs writes it next to status.json as backlog.json; the page draws the table.
//
// Counts only, never a title: the page is public and the mod repos are private.
//
// Where each column comes from:
//   type      the GitHub issue (the authority): `crash` and `bug` labels, RESEARCH in the title,
//             `documentation`, `enhancement`. Most tickets filed by hand carry no label, so an
//             unlabeled one falls back to its Linear priority, which the workspace sets by type
//             (1 crash · 2 bug · 3 cosmetic, perf, tooling · 4 feature, polish, docs, store)
//   status    the Linear mirror's state, found by its GitHub URL in the attachments (as linear.mjs
//             does). `needs-info` or `blocked` on the issue wins over the state. A repo that does
//             not mirror (no `linear` in projects.json), or an issue whose mirror is closed, is
//             "Not in Linear"
//   priority  the mirror's priority; no mirror is "No priority"
//   source    `discord` label (filed by intake) or not
//   icon      Modrinth's icon_url, CurseForge's thumbnail for a project Modrinth has not approved
//             yet, and the project's tag emoji in #tickets (server.json) when neither has one
//
// Nothing here may fail the health check: each source that cannot be read is left out, and the
// reason goes into `errors`, which the page shows under the table.

import { readFileSync } from "node:fs";
import { linear } from "./linear.mjs";
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
		["unlinked", "Not in Linear"],
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

const PRIORITY_KEY = ["none", "urgent", "high", "medium", "low"];
const TYPE_BY_PRIORITY = [null, "crash", "bug", "improvement", "feature"];
// Linear state names of team COB; any other started/unstarted state falls under its type.
const STATUS_BY_STATE = { Triage: "triage", Backlog: "backlog", Todo: "todo", "In Progress": "in-progress", "In Review": "in-review" };
const STATUS_BY_STATE_TYPE = { triage: "triage", backlog: "backlog", unstarted: "todo", started: "in-progress" };

const ISSUE_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i;
const urlKey = (repo, number) => `${repo.toLowerCase()}#${number}`;

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

const MIRRORS = `query($after: String) {
	issues(first: 250, after: $after, filter: {
		team: { key: { eq: "COB" } }
		state: { type: { nin: ["completed", "canceled", "duplicate"] } }
	}) {
		pageInfo { hasNextPage endCursor }
		nodes { priority state { name type } labels { nodes { name } } attachments { nodes { url } } }
	}
}`;

/** The open Linear issues of team COB, keyed by the GitHub issue they mirror. */
async function linearMirrors(key) {
	const byUrl = new Map();
	let after = null;
	for (;;) {
		const { issues } = await linear(key, MIRRORS, { after });
		for (const node of issues.nodes) {
			for (const { url } of node.attachments.nodes) {
				const m = url.match(ISSUE_URL);
				if (m) byUrl.set(urlKey(m[1], m[2]), node);
			}
		}
		if (!issues.pageInfo.hasNextPage) return byUrl;
		after = issues.pageInfo.endCursor;
	}
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

const lastSegment = (url) => url?.replace(/\/+$/, "").split("/").pop() || null;

/** The type, status, priority and source bucket of one open issue. */
export function classify(issue, mirror) {
	const labels = new Set((issue.labels || []).map((l) => (typeof l === "string" ? l : l.name).toLowerCase()));
	const mirrorLabels = new Set((mirror?.labels.nodes || []).map((l) => l.name.toLowerCase()));
	const priority = mirror?.priority ?? 0;

	let type;
	if (labels.has("crash")) type = "crash";
	else if (labels.has("bug")) type = "bug";
	else if (/\bRESEARCH\b/.test(issue.title)) type = "research";
	else if (labels.has("documentation")) type = "docs";
	else if (labels.has("enhancement")) type = "feature";
	else type = TYPE_BY_PRIORITY[priority] || "untriaged";

	let status;
	if (labels.has("needs-info") || mirrorLabels.has("needs-info")) status = "needs-info";
	else if (labels.has("blocked") || mirrorLabels.has("blocked")) status = "blocked";
	else if (!mirror) status = "unlinked";
	else status = STATUS_BY_STATE[mirror.state.name] || STATUS_BY_STATE_TYPE[mirror.state.type] || "backlog";

	return { type, status, priority: PRIORITY_KEY[priority] || "none", source: labels.has("discord") ? "discord" : "internal" };
}

const emptyCounts = () => Object.fromEntries(Object.entries(DIMENSIONS).map(([dim, buckets]) => [dim, Object.fromEntries(buckets.map(([k]) => [k, 0]))]));

/**
 * backlog.json: `projects` with their resolved gates (for the repo variable names), `vars` the
 * repo variables, `token` a PAT that reads the mod repos, `linearKey` optional.
 */
export async function collectBacklog(projects, vars, { token, linearKey }) {
	const errors = [];
	const settle = async (what, fn, fallback) => {
		try {
			return await fn();
		} catch (e) {
			errors.push(`${what}: ${e.message}`);
			return fallback;
		}
	};

	const mirrors = linearKey
		? await settle("Linear", () => linearMirrors(linearKey), null)
		: (errors.push("Linear: LINEAR_API_KEY is not set, so status and priority are unknown"), null);

	const modrinthIds = projects.map((p) => lastSegment(p.announce?.links?.modrinth)).filter(Boolean);
	const icons = await settle("Modrinth icons", () => modrinthIcons(modrinthIds), new Map());
	let spec = {};
	try {
		spec = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
	} catch {}

	const mods = await Promise.all(projects.map(async (p) => {
		const repo = vars[`${p.prefix}_GH_REPO`] || null;
		const links = p.announce?.links || {};
		let icon = icons.get(lastSegment(links.modrinth)) || null;
		if (!icon && links.curseforge) icon = await settle(`${p.name} CurseForge icon`, async () => (await fetchCurseForge(links.curseforge))?.icon || null, null);
		const row = {
			dir: p.dir,
			name: p.name,
			icon,
			emoji: tagEmoji(spec, p.tag) || null,
			link: links.modrinth || links.curseforge || null,
			total: null,
			oldest_days: null,
			counts: null,
		};
		if (!repo) {
			errors.push(`${p.name}: no ${p.prefix}_GH_REPO variable`);
			return row;
		}
		if (!token) return row;
		const issues = await settle(`${p.name} issues`, () => openIssues(repo, token), null);
		if (!issues) return row;
		const counts = emptyCounts();
		for (const issue of issues) {
			const mirror = mirrors?.get(urlKey(repo, issue.number)) ?? null;
			const buckets = classify(issue, mirror);
			for (const [dim, key] of Object.entries(buckets)) counts[dim][key]++;
		}
		// Without Linear every issue would read "Not in Linear": say unknown instead.
		if (!mirrors) counts.status = counts.priority = null;
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
