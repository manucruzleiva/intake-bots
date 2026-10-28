// The GitHub Project "Cobblemon Mods" (a ProjectV2), the planning layer that replaced Linear on
// 2026-10-28. GitHub Issues stay the ticket; the Project puts a Status and a Priority on top, for every
// repo of the workspace in one board. Its ids live in ../project.json — the project, each field and
// each option, keyed by the names the board shows; a copy of the workspace's .claude/github-project.json,
// and no secret — and everything here looks them up by name, so a renamed option is one edit there.
//
// What this writes, and nothing else:
//   loadIssue     the issue the poller just filed enters the Project in `Triage` with the Priority of
//                 its kind (crash → 1 Urgent, bug → 2 High, idea / feedback → 4 Low; `other` gets none:
//                 a human's call). Once, on filing: a Status or Priority set afterwards is the author's.
//   sweepMissing  every open issue of every configured repo that is not in the Project yet goes in, in
//                 `Triage` and with no Priority — the ones filed by hand, and the ones loadIssue could
//                 not load. An item already there is never touched.
// And it reads: listItems, every item with its Status and Priority, for the status page's backlog table
// (lib/backlog.mjs) and for the sweep.
//
// Token: PROJECTS_TOKEN, a PAT with the `project` scope. A repo's GITHUB_TOKEN cannot see a user-level
// Project, which is why it is its own secret; the same PAT reads the private mod repos, which adding an
// issue needs anyway. Unset, the first call says so once and every call does nothing, so the run stays
// green — like catalog.mjs without MODRINTH_ANALYTICS_TOKEN.

import { readFileSync } from "node:fs";

const API = "https://api.github.com/graphql";
const UA = "intake-bots-projects (+https://github.com/manucruzleiva/intake-bots)";
const TOKEN = (process.env.PROJECTS_TOKEN || "").trim();

/** ../project.json: `project_id`, `url` and `fields.<Name>` = `{ id, options: { <option name>: id } }`. */
export const PROJECT = JSON.parse(readFileSync(new URL("../project.json", import.meta.url), "utf8"));

/** The Status every issue enters with. */
export const TRIAGE = "Triage";
/**
 * The Priority of a post's kind, as the number its option name opens with ("2 High"): the table in
 * CLAUDE.md. A kind missing here (`other`) gets no priority. The number is what is matched, so renaming
 * "2 High" to "2 Important" in project.json is enough.
 */
export const PRIORITY_BY_KIND = { crash: 1, bug: 2, idea: 4, feedback: 4 };

/** `owner/repo#N`, case-insensitive: how an item is matched to a GitHub issue (the tail of its URL). */
export const issueKey = (repo, number) => `${repo.toLowerCase()}#${number}`;

export const configured = () => Boolean(TOKEN);

let warned = false;
/** Says once per run that the Project is skipped, and returns `value`. */
function skipped(value) {
	if (!warned) console.log("::warning::PROJECTS_TOKEN is not set: the Project step is skipped; the issues stay out of the Project until it is loaded");
	warned = true;
	return value;
}

function field(name) {
	const f = PROJECT.fields?.[name];
	if (!f?.id) throw new Error(`project.json has no field "${name}"`);
	return f;
}

/** The option id of `name` in the single select `fieldName`, by its exact name. */
function optionId(fieldName, name) {
	const id = field(fieldName).options?.[name];
	if (!id) throw new Error(`project.json: the field "${fieldName}" has no option "${name}"`);
	return id;
}

/** The name of the Priority option that opens with `n` ("2 High" for 2); null for no priority. */
export function priorityName(n) {
	if (!n) return null;
	const name = Object.keys(field("Priority").options || {}).find((o) => o === String(n) || o.startsWith(`${n} `));
	if (!name) throw new Error(`project.json: no Priority option opens with "${n}"`);
	return name;
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

/** Add the issue with node id `nodeId`; its item id. Idempotent: the same issue returns the same item. */
export async function addIssueToProject(nodeId) {
	if (!configured()) return skipped(null);
	const data = await graphql(ADD, { p: PROJECT.project_id, c: nodeId });
	return data.addProjectV2ItemById.item.id;
}

/**
 * Set the single selects of item `itemId` by option name — `{ status: "Triage", priority: "2 High" }` —
 * in one request, one aliased updateProjectV2ItemFieldValue per field. A key left out or null is not
 * touched. Returns the item id.
 */
export async function setItemFields(itemId, { status, priority } = {}) {
	if (!configured()) return skipped(null);
	const wanted = Object.entries({ Status: status, Priority: priority }).filter(([, name]) => name);
	if (!wanted.length) return itemId;
	const vars = { p: PROJECT.project_id, i: itemId };
	const decl = ["$p:ID!", "$i:ID!"];
	const sets = wanted.map(([fieldName, name], n) => {
		vars[`f${n}`] = field(fieldName).id;
		vars[`o${n}`] = optionId(fieldName, name);
		decl.push(`$f${n}:ID!`, `$o${n}:String!`);
		return `${fieldName.toLowerCase()}: updateProjectV2ItemFieldValue(input:{projectId:$p, itemId:$i, fieldId:$f${n}, value:{singleSelectOptionId:$o${n}}}){ projectV2Item{ id } }`;
	});
	await graphql(`mutation(${decl.join(",")}){ ${sets.join(" ")} }`, vars);
	return itemId;
}

/**
 * Load `issue` (as the REST API returns it: `node_id`) into the Project: Status Triage and the Priority
 * of `kind`. What was set, as text for the log; null when the Project is skipped.
 */
export async function loadIssue(issue, kind) {
	if (!configured()) return skipped(null);
	const priority = priorityName(PRIORITY_BY_KIND[kind]);
	await setItemFields(await addIssueToProject(issue.node_id), { status: TRIAGE, priority });
	return `${TRIAGE}, ${priority || "no priority"}`;
}

const ITEMS = `query($p:ID!,$a:String){ node(id:$p){ ... on ProjectV2{ items(first:100, after:$a){
	pageInfo{ hasNextPage endCursor }
	nodes{ id
		content{ ... on Issue{ id number state url repository{ nameWithOwner } } }
		fieldValues(first:20){ nodes{ ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2FieldCommon{ name } } } } } } } } } }`;

/**
 * Every item of the Project, 100 per page: `{ id, status, priority, issue }`, the names of the two
 * single selects (null when unset) and `issue` = `{ id, repo, number, state, url }`, or null for a
 * draft or a pull request. Null when the Project is skipped.
 */
export async function listItems() {
	if (!configured()) return skipped(null);
	const items = [];
	let after = null;
	for (;;) {
		const page = (await graphql(ITEMS, { p: PROJECT.project_id, a: after })).node.items;
		for (const node of page.nodes) {
			const values = Object.fromEntries(node.fieldValues.nodes.filter((v) => v.field?.name).map((v) => [v.field.name, v.name]));
			const c = node.content;
			items.push({
				id: node.id,
				status: values.Status ?? null,
				priority: values.Priority ?? null,
				issue: c?.number ? { id: c.id, repo: c.repository.nameWithOwner, number: c.number, state: c.state, url: c.url } : null,
			});
		}
		if (!page.pageInfo.hasNextPage) return items;
		after = page.pageInfo.endCursor;
	}
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
 * Add every open issue of `repos` ("owner/repo") that is not in the Project yet, in Triage and with no
 * Priority; an item already there is not touched. How many went in. A repo or an issue that fails is
 * a warning and the sweep goes on; 0 when the Project is skipped.
 */
export async function sweepMissing(repos) {
	if (!configured()) return skipped(0);
	const loaded = new Set((await listItems()).filter((i) => i.issue).map((i) => issueKey(i.issue.repo, i.issue.number)));
	let added = 0;
	for (const repo of new Map(repos.map((r) => [r.toLowerCase(), r])).values()) {
		let issues;
		try {
			issues = await openIssues(repo);
		} catch (e) {
			console.log(`::warning::Project sweep: ${e.message}`);
			continue;
		}
		for (const issue of issues) {
			if (loaded.has(issueKey(repo, issue.number))) continue;
			try {
				await setItemFields(await addIssueToProject(issue.id), { status: TRIAGE });
				loaded.add(issueKey(repo, issue.number));
				added++;
				console.log(`${repo}#${issue.number} -> Project: ${TRIAGE}, no priority`);
			} catch (e) {
				console.log(`::warning::Project sweep: ${repo}#${issue.number}: ${e.message}`);
			}
		}
	}
	return added;
}
