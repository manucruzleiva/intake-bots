// Is intake working? Answers from the intake workflow's own runs, not from exit codes alone, and
// keeps one issue in this repo — "Intake unhealthy" — open for exactly as long as the answer is no.
//
// What it checks:
//   chain     the newest run of intake.yml was created less than CHAIN_MAX_MIN ago. The pacer chain
//             (intake-pacer.yml) is what keeps runs ~10 minutes apart; if it breaks, runs only come
//             from the `schedule`, hours apart, and every one of them is green.
//   projects  every project whose gate lets it run (lib/gates.mjs) had its poll succeed in at least
//             one of its last FAILS_TO_ALARM executed rows. One red row is a blip; two in a row is
//             a broken poller. The poller turns red on a bad token and also on a run that finished
//             without doing its job (see "Exit code" in poller.mjs), which is the silent shape.
//   watched   a project kept off by its gate is listed as not watched. It is not a failure — the gate
//             is a choice — but it must not look the same as a healthy one.
//
// Why an issue and not only a red run: intake runs are dispatched by the pacer with GITHUB_TOKEN,
// and GitHub tells nobody when a run like that fails. An issue opened by the bot notifies the repo's
// watchers within the run that found the problem.
//
// It runs twice over: as the `health` job at the end of every intake run (minutes), and from
// healthcheck.yml on a schedule, which is the only one that can see the chain stop — the in-run job
// stops with it.
//
// Env:
//   GH_TOKEN           token with actions:read and issues:write on this repo
//   GITHUB_REPOSITORY  owner/repo
//   REPO_VARS          toJSON(vars), for the gates
//   GITHUB_RUN_ID      when it runs inside intake.yml: that run is still in progress, but its poll
//                      rows are done and count
//   HEALTH_DRY_RUN     "1": print the report and leave the issue alone
//   HEALTH_PAGE_DIR    folder to write the status page into (index.html + status.json), which the
//                      workflows deploy to GitHub Pages, with the stats page in its stats/ (the
//                      workflows add the stats branch's JSON next to it). Unset: no page
//   LINEAR_API_KEY     the issue's Linear mirror lands in Triage like any other: with the key, it gets
//                      project Intake Bots, priority High and Backlog (lib/linear.mjs). Unset: left there
//
// The mirror is looked for while the issue is younger than MIRROR_WAIT_MS, so without any state an
// outage costs a handful of Linear reads, and a quiet hour none.

import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projects as allProjects, resolveGates } from "./gates.mjs";
import { triageMirror, MIRROR_WAIT_MS } from "./linear.mjs";

const CHAIN_MAX_MIN = 30;
const FAILS_TO_ALARM = 2;
const RUNS_TO_READ = 8;
const POLL_STEP = "Poll Discord and file issues";
const ISSUE_TITLE = "Intake unhealthy";
const BOT_LOGIN = "github-actions[bot]";
// Reports stop reaching the issues while it is open: more than tooling, short of the game breaking.
const LINEAR_PROJECT = "Intake Bots";
const LINEAR_PRIORITY = 2;
const LINEAR_KEY = (process.env.LINEAR_API_KEY || "").replace(/^﻿/, "").trim();

const GH = "https://api.github.com";
const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const CURRENT_RUN = Number(process.env.GITHUB_RUN_ID || 0);
const DRY_RUN = process.env.HEALTH_DRY_RUN === "1";
const PAGE_DIR = process.env.HEALTH_PAGE_DIR || "";
const vars = JSON.parse(process.env.REPO_VARS || "{}");

async function api(path, { method = "GET", body } = {}) {
	const res = await fetch(GH + path, {
		method,
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "intake-health",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status} ${await res.text()}`);
	return res.json();
}

const minutesSince = (iso) => Math.round((Date.now() - Date.parse(iso)) / 60000);

/**
 * One row of a project in one run: ok, fail, or skip (did not poll: gate closed, cancelled, still
 * running). A job that failed counts as fail even when the poll itself passed: the step after it
 * pushes state.json, and a state that never lands means the next run files the same issues again.
 */
function outcome(job) {
	if (job.conclusion === "failure") return "fail";
	if (job.conclusion !== "success") return "skip";
	const poll = (job.steps || []).find((s) => s.name === POLL_STEP);
	return poll?.conclusion === "success" ? "ok" : "skip";
}

async function check() {
	const problems = [];
	const projects = resolveGates(vars, false);
	const { workflow_runs: runs } = await api(`/repos/${REPO}/actions/workflows/intake.yml/runs?per_page=${RUNS_TO_READ}`);

	// The chain. Inside an intake run the newest run is this one, so this only ever fires from the
	// scheduled healthcheck — which is the point.
	const newest = runs[0];
	const chain = newest
		? { age: minutesSince(newest.created_at), url: newest.html_url, event: newest.event }
		: null;
	if (!chain) problems.push({ key: "chain", text: "intake.yml has no runs at all" });
	else if (chain.age > CHAIN_MAX_MIN) {
		problems.push({
			key: "chain",
			text: `the last intake run was created ${chain.age} min ago (limit ${CHAIN_MAX_MIN}): the pacer chain is broken, and only the hours-apart \`schedule\` is left`,
		});
	}

	// Rows per project, newest run first.
	const rows = new Map(projects.map((p) => [p.name, []]));
	for (const run of runs) {
		if (run.status !== "completed" && run.id !== CURRENT_RUN) continue;
		const { jobs } = await api(`/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`);
		for (const job of jobs) {
			const list = rows.get(job.name);
			if (!list) continue; // plan, next, health
			const o = outcome(job);
			if (o !== "skip") list.push({ o, url: job.html_url, at: job.completed_at || run.created_at });
		}
	}

	// One row per project. `level` is what the page colours by; the markdown table and the page are
	// both rendered from these, so they cannot disagree.
	const table = [];
	for (const p of projects) {
		if (!p.run) {
			table.push({ name: p.name, level: "off", state: "not watched", since: null, note: p.reason });
			continue;
		}
		const list = rows.get(p.name);
		const lastOk = list.find((r) => r.o === "ok");
		const since = lastOk ? minutesSince(lastOk.at) : null;
		if (!list.length) {
			problems.push({ key: `project:${p.dir}`, text: `**${p.name}**: no poll ran in the last ${RUNS_TO_READ} intake runs` });
			table.push({ name: p.name, level: "fail", state: "not polling", since, note: "no executed row" });
			continue;
		}
		const head = list.slice(0, FAILS_TO_ALARM);
		if (head.length === FAILS_TO_ALARM && head.every((r) => r.o === "fail")) {
			problems.push({
				key: `project:${p.dir}`,
				text: `**${p.name}**: its last ${FAILS_TO_ALARM} polls failed — [newest failing job](${head[0].url})`,
			});
			table.push({ name: p.name, level: "fail", state: "failing", since, url: head[0].url });
		} else if (list[0].o === "fail") {
			table.push({ name: p.name, level: "warn", state: "one failed poll", since, url: list[0].url });
		} else {
			table.push({ name: p.name, level: "ok", state: "healthy", since });
		}
	}
	return { problems, chain, table };
}

const LEVEL_ICON = { ok: "🟢", warn: "🟡", fail: "🔴", off: "⚪" };

function render({ problems, chain, table }) {
	const lines = [];
	lines.push(problems.length ? `**Intake is unhealthy** — ${problems.length} problem(s):` : "**Intake is healthy.**");
	lines.push("");
	for (const p of problems) lines.push(`- ${p.text}`);
	if (problems.length) lines.push("");
	if (chain) lines.push(`Last intake run: [${chain.age} min ago](${chain.url}) (${chain.event}).`, "");
	lines.push("| Project | State | Last good poll | |", "|---|---|---|---|");
	for (const r of table) {
		const since = r.level === "off" ? "—" : r.since === null ? `none in the last ${RUNS_TO_READ} runs` : `${r.since} min ago`;
		const extra = r.url ? `[job](${r.url})` : r.note || "";
		lines.push(`| ${r.name} | ${LEVEL_ICON[r.level]} ${r.state} | ${since} | ${extra} |`);
	}
	return lines.join("\n");
}

/**
 * The status page: lib/status-page.html plus the status.json it reads. The page itself decides
 * whether the data is stale, against the viewer's clock — it is only redeployed by a run that is
 * alive, so a broken chain would otherwise leave the last healthy verdict up for hours.
 */
function writePage(dir, { problems, chain, table }) {
	mkdirSync(dir, { recursive: true });
	const status = {
		generated_at: new Date().toISOString(),
		// GITHUB_RUN_ID is set in every workflow, so it cannot tell the two callers apart.
		source: /healthcheck\.yml@/.test(process.env.GITHUB_WORKFLOW_REF || "") ? "healthcheck" : process.env.GITHUB_ACTIONS ? "intake" : "local",
		healthy: problems.length === 0,
		stale_after_min: CHAIN_MAX_MIN,
		runs_read: RUNS_TO_READ,
		problems: problems.map((p) => p.text),
		chain: chain && { age_min: chain.age, url: chain.url, event: chain.event },
		rows: table,
	};
	writeFileSync(join(dir, "status.json"), JSON.stringify(status, null, 2) + "\n");
	copyFileSync(new URL("./status-page.html", import.meta.url), join(dir, "index.html"));
	writeStatsPage(join(dir, "stats"));
	console.log(`Status page written to ${dir}.`);
}

/**
 * The stats page: lib/stats-page.html plus mods.json, the names and order it draws the mods in.
 * Its data, stats/downloads.json and (once there) stats/modrinth-daily.json, lives on the `stats`
 * branch; the workflows copy it in, so here the page may have nothing to draw and says so.
 */
function writeStatsPage(dir) {
	mkdirSync(dir, { recursive: true });
	const mods = allProjects.map((p) => ({
		dir: p.dir,
		name: p.name,
		// The link's last segment: a slug, or an id for a project that has none yet.
		modrinth: p.announce?.links?.modrinth?.replace(/\/+$/, "").split("/").pop() ?? null,
	}));
	writeFileSync(join(dir, "mods.json"), JSON.stringify(mods, null, 2) + "\n");
	copyFileSync(new URL("./stats-page.html", import.meta.url), join(dir, "index.html"));
}

/** The open "Intake unhealthy" issue, if the bot has one. */
async function openIssue() {
	const issues = await api(`/repos/${REPO}/issues?state=open&creator=${encodeURIComponent(BOT_LOGIN)}&per_page=100`);
	return issues.find((i) => !i.pull_request && i.title === ISSUE_TITLE) || null;
}

const signatureOf = (problems) => problems.map((p) => p.key).sort().join(",");
const signatureIn = (body) => (body || "").match(/<!-- health: (.*?) -->/)?.[1] ?? null;

/**
 * Open the issue on the first problem, edit it while the problems stay the same (an edit notifies
 * nobody), comment when they change (a comment does), and close it once everything is healthy.
 * Returns the issue while it stays open.
 */
async function report(result, text) {
	const sig = signatureOf(result.problems);
	const body = `${text}\n\n_Updated by \`lib/health.mjs\`, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. This issue closes itself when intake is healthy again._\n\n<!-- health: ${sig} -->`;
	const issue = await openIssue();
	if (result.problems.length) {
		if (!issue) {
			const created = await api(`/repos/${REPO}/issues`, { method: "POST", body: { title: ISSUE_TITLE, body } });
			console.log(`Opened #${created.number}.`);
			return created;
		}
		if (signatureIn(issue.body) !== sig) {
			await api(`/repos/${REPO}/issues/${issue.number}/comments`, { method: "POST", body: { body: `The problems changed:\n\n${text}` } });
			console.log(`Commented on #${issue.number}: problems changed.`);
		}
		await api(`/repos/${REPO}/issues/${issue.number}`, { method: "PATCH", body: { body } });
		return issue;
	}
	if (issue) {
		await api(`/repos/${REPO}/issues/${issue.number}/comments`, { method: "POST", body: { body: `Healthy again.\n\n${text}` } });
		await api(`/repos/${REPO}/issues/${issue.number}`, { method: "PATCH", body: { state: "closed", state_reason: "completed" } });
		console.log(`Closed #${issue.number}.`);
	}
	return null;
}

/** Plan the open issue's Linear mirror. A failure here says nothing about intake: a warning, not a red check. */
async function triage(issue) {
	if (!issue || Date.now() - Date.parse(issue.created_at) > MIRROR_WAIT_MS) return;
	if (!LINEAR_KEY) {
		console.log(`::warning::LINEAR_API_KEY is not set: the mirror of #${issue.number} stays in Linear Triage`);
		return;
	}
	try {
		const done = await triageMirror(LINEAR_KEY, issue.html_url, { project: LINEAR_PROJECT, priority: LINEAR_PRIORITY });
		if (!done) console.log(`#${issue.number} has no Linear mirror yet; the next check looks again.`);
		else if (done.changed.length) console.log(`#${issue.number} -> ${done.identifier}: ${done.changed.join(", ")}`);
	} catch (e) {
		console.log(`::warning::Linear triage of #${issue.number}: ${e.message}`);
	}
}

const result = await check();
const text = render(result);
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
if (PAGE_DIR) writePage(PAGE_DIR, result);
if (!DRY_RUN) await triage(await report(result, text));
if (result.problems.length) process.exitCode = 1;
