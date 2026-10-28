// The GitHub Projects (ProjectV2), the planning layer that replaced Linear on 2026-10-28. GitHub Issues
// stay the ticket; a Project puts a Status and a Priority on top. Two boards, in ../project.json:
// "Cobblemon Mods" for every repo of the workspace (`repos: "*"`), and "TCGKB" for the TCG apps it lists
// by name. Each board carries its ids — the project, each field and each option, keyed by the names the
// board shows; no secret — plus the Status an issue enters with (`triage`), the Priority of each kind
// (`priority_by_kind`) and `as`, which translates its option names into Cobblemon Mods' ("High" →
// "2 High"), so the status page reads every board with one vocabulary. Everything here looks the ids up
// by name, so a renamed option is one edit there. The Cobblemon Mods board is a copy of the workspace's
// .claude/github-project.json.
//
// What this writes, and nothing else:
//   loadIssue     the issue the poller just filed enters its repo's board in that board's `triage`
//                 Status with the Priority of its kind (Cobblemon Mods: crash → 1 Urgent, bug → 2 High,
//                 idea / feedback → 4 Low; `other` gets none: a human's call). Once, on filing: a Status
//                 or Priority set afterwards is the author's.
//   sweepMissing  every open issue of every configured repo that is on no board yet goes into its own,
//                 in `triage` and with no Priority — the ones filed by hand, and the ones loadIssue could
//                 not load. An item already on a board is never touched, on that board or another.
// And it reads: listItems, every item of every board with its Status and Priority (translated), for
// the status page's backlog table (lib/backlog.mjs) and for the sweep.
//
// Token: PROJECTS_TOKEN, a PAT with the `project` scope. A repo's GITHUB_TOKEN cannot see a user-level
// Project, which is why it is its own secret; the same PAT reads the private mod repos, which adding an
// issue needs anyway. Unset, the first call says so once and every call does nothing, so the run stays
// green — like catalog.mjs without MODRINTH_ANALYTICS_TOKEN.

import { readFileSync } from "node:fs";

const API = "https://api.github.com/graphql";
const UA = "intake-bots-projects (+https://github.com/manucruzleiva/intake-bots)";
const TOKEN = (process.env.PROJECTS_TOKEN || "").trim();

/**
 * ../project.json's `boards`: each `{ name, repos, project_id, url, triage, priority_by_kind, as,
 * fields }`, where `repos` is a list of "owner/repo" or "*" (every repo no other board lists) and
 * `fields.<Name>` = `{ id, options: { <option name>: id } }`.
 */
export const BOARDS = JSON.parse(readFileSync(new URL("../project.json", import.meta.url), "utf8")).boards;

/** `owner/repo#N`, case-insensitive: how an item is matched to a GitHub issue (the tail of its URL). */
export const issueKey = (repo, number) => `${repo.toLowerCase()}#${number}`;

/** The board of `repo` ("owner/repo"): the one that lists it, else the one with `repos: "*"`. */
export function boardFor(repo) {
	const r = repo.toLowerCase();
	const board = BOARDS.find((b) => Array.isArray(b.repos) && b.repos.some((x) => x.toLowerCase() === r)) || BOARDS.find((b) => b.repos === "*");
	if (!board) throw new Error(`project.json: no board takes ${repo}`);
	return board;
}

export const configured = () => Boolean(TOKEN);

let warned = false;
/** Says once per run that the Project is skipped, and returns `value`. */
function skipped(value) {
	if (!warned) console.log("::warning::PROJECTS_TOKEN is not set: the Project step is skipped; the issues stay out of the Project until it is loaded");
	warned = true;
	return value;
}

function field(board, name) {
	const f = board.fields?.[name];
	if (!f?.id) throw new Error(`project.json: the board "${board.name}" has no field "${name}"`);
	return f;
}

/** The option id of `name` in the single select `fieldName` of `board`, by its exact name. */
function optionId(board, fieldName, name) {
	const id = field(board, fieldName).options?.[name];
	if (!id) throw new Error(`project.json: the field "${fieldName}" of "${board.name}" has no option "${name}"`);
	return id;
}

/**
 * One GraphQL request. GitHub answers a secondary rate limit with a 403 or a 429 and, usually, a
 * Retry-After: that one is retried once, after it. Anything else that fails, and a 200 carrying
 * `errors`, throws.
 */
export async function graphql(query, variables, retried = false) {
	const res = await fetch(API, {
		method: "POST",
		headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": UA },
		body: JSON.stringify({ query, variables }),
	});
	const text = await res.text();
	if ((res.status === 403 || res.status === 429) && /rate limit/i.test(text) && !retried) {
		const after = Math.min(Number(res.headers.get("retry-after")) || 60, 300);
		console.log(`::warning::GitHub GraphQL -> ${res.status} (rate limit); retrying once in ${after} s`);
		await new Promise((r) => setTimeout(r, after * 1000));
		return graphql(query, variables, true);
	}
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`GitHub GraphQL -> ${res.status} ${text.slice(0, 300)}`);
	}
	if (!res.ok || body.errors?.length) {
		throw new Error(`GitHub GraphQL -> ${res.status} ${(body.errors || []).map((e) => e.message).join("; ") || text.slice(0, 300)}`);
	}
	return body.data;
}

const ADD = `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p, contentId:$c}){ item{ id } } }`;

/** Add the issue with node id `nodeId` to `board`; its item id. Idempotent: the same issue returns the same item. */
export async function addIssueToProject(board, nodeId) {
	if (!configured()) return skipped(null);
	const data = await graphql(ADD, { p: board.project_id, c: nodeId });
	return data.addProjectV2ItemById.item.id;
}

/**
 * Set the single selects of item `itemId` of `board` by option name — `{ status: "Triage", priority:
 * "2 High" }` — in one request, one aliased updateProjectV2ItemFieldValue per field. A key left out or
 * null is not touched. Returns the item id.
 */
export async function setItemFields(board, itemId, { status, priority } = {}) {
	if (!configured()) return skipped(null);
	const wanted = Object.entries({ Status: status, Priority: priority }).filter(([, name]) => name);
	if (!wanted.length) return itemId;
	const vars = { p: board.project_id, i: itemId };
	const decl = ["$p:ID!", "$i:ID!"];
	const sets = wanted.map(([fieldName, name], n) => {
		vars[`f${n}`] = field(board, fieldName).id;
		vars[`o${n}`] = optionId(board, fieldName, name);
		decl.push(`$f${n}:ID!`, `$o${n}:String!`);
		return `${fieldName.toLowerCase()}: updateProjectV2ItemFieldValue(input:{projectId:$p, itemId:$i, fieldId:$f${n}, value:{singleSelectOptionId:$o${n}}}){ projectV2Item{ id } }`;
	});
	await graphql(`mutation(${decl.join(",")}){ ${sets.join(" ")} }`, vars);
	return itemId;
}

/** "owner/repo" of an issue as the REST API returns it (`repository_url`). */
const repoOf = (issue) => issue.repository_url.replace(/^.*\/repos\//, "");

/**
 * Load `issue` (as the REST API returns it: `node_id`, `repository_url`) into its repo's board: that
 * board's `triage` Status and the Priority of `kind`. What was set, as text for the log; null when the
 * Project is skipped.
 */
export async function loadIssue(issue, kind) {
	if (!configured()) return skipped(null);
	const board = boardFor(repoOf(issue));
	const priority = board.priority_by_kind?.[kind] || null;
	await setItemFields(board, await addIssueToProject(board, issue.node_id), { status: board.triage, priority });
	return `${board.name}: ${board.triage}, ${priority || "no priority"}`;
}

const ITEMS = `query($p:ID!,$a:String){ node(id:$p){ ... on ProjectV2{ items(first:100, after:$a){
	pageInfo{ hasNextPage endCursor }
	nodes{ id
		content{ ... on Issue{ id number state url repository{ nameWithOwner } } }
		fieldValues(first:20){ nodes{ ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2FieldCommon{ name } } } } } } } } } }`;

/**
 * Every item of every board, 100 per page: `{ id, board, status, priority, issue }`, the names of the
 * two single selects translated by the board's `as` (null when unset) and `issue` = `{ id, repo,
 * number, state, url }`, or null for a draft or a pull request. Null when the Project is skipped.
 */
export async function listItems() {
	if (!configured()) return skipped(null);
	const items = [];
	for (const board of BOARDS) {
		const as = (fieldName, name) => (name == null ? null : board.as?.[fieldName]?.[name] ?? name);
		let after = null;
		for (;;) {
			const page = (await graphql(ITEMS, { p: board.project_id, a: after })).node.items;
			for (const node of page.nodes) {
				const values = Object.fromEntries(node.fieldValues.nodes.filter((v) => v.field?.name).map((v) => [v.field.name, v.name]));
				const c = node.content;
				items.push({
					id: node.id,
					board: board.name,
					status: as("Status", values.Status),
					priority: as("Priority", values.Priority),
					issue: c?.number ? { id: c.id, repo: c.repository.nameWithOwner, number: c.number, state: c.state, url: c.url } : null,
				});
			}
			if (!page.pageInfo.hasNextPage) break;
			after = page.pageInfo.endCursor;
		}
	}
	return items;
}

const OPEN_ISSUES = `query($o:String!,$n:String!,$a:String){ repository(owner:$o, name:$n){
	issues(states:OPEN, first:100, after:$a){ pageInfo{ hasNextPage endCursor } nodes{ id number } } } }`;

/** The node id and number of every open issue of `repo` ("owner/repo"). */
async function openIssues(repo) {
	const [o, n] = repo.split("/");
	const all = [];
	let after = null;
	for (;;) {
		const page = (await graphql(OPEN_ISSUES, { o, n, a: after })).repository?.issues;
		if (!page) throw new Error(`${repo}: no such repo, or the token cannot see it`);
		all.push(...page.nodes);
		if (!page.pageInfo.hasNextPage) return all;
		after = page.pageInfo.endCursor;
	}
}

/**
 * Add every open issue of `repos` ("owner/repo") that is on no board yet to its repo's board, in that
 * board's `triage` and with no Priority; an item already on a board is not touched. How many went in.
 * A repo or an issue that fails is a warning and the sweep goes on; 0 when the Project is skipped.
 */
export async function sweepMissing(repos) {
	if (!configured()) return skipped(0);
	const loaded = new Set((await listItems()).filter((i) => i.issue).map((i) => issueKey(i.issue.repo, i.issue.number)));
	let added = 0;
	for (const repo of new Map(repos.map((r) => [r.toLowerCase(), r])).values()) {
		let issues, board;
		try {
			board = boardFor(repo);
			issues = await openIssues(repo);
		} catch (e) {
			console.log(`::warning::Project sweep: ${e.message}`);
			continue;
		}
		for (const issue of issues) {
			if (loaded.has(issueKey(repo, issue.number))) continue;
			try {
				await setItemFields(board, await addIssueToProject(board, issue.id), { status: board.triage });
				loaded.add(issueKey(repo, issue.number));
				added++;
				console.log(`${repo}#${issue.number} -> ${board.name}: ${board.triage}, no priority`);
			} catch (e) {
				console.log(`::warning::Project sweep: ${repo}#${issue.number}: ${e.message}`);
			}
		}
	}
	return added;
}
