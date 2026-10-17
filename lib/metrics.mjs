// How intake is doing, in numbers (#14): one table per project at the end of every poll, in the job
// summary of that matrix row. Nothing is posted anywhere else and nothing is stored for it — every
// figure is recomputed each run from what the poller already has:
//
//   Ingest lag         issue created_at minus the post's own time, read from its snowflake id. A post
//                      that waited for a backfill (intake down, a forum not read yet) shows here as the
//                      days it waited: that is the point of measuring it
//   First human reply  entry.firstReplyAt minus issue created_at. lib/replies.mjs sets it once, from
//                      the first comment a writer leaves on the issue — a `/reply` or not — and only on
//                      issues filed since it exists (entry.awaitingReply): before #11 the poller's own
//                      follow-ups carried no marker, so an older issue's first comment cannot be told
//                      apart. Those count as "n of m" and never as a guess
//   Time to close      issue closed_at minus created_at
//   Open / needs-info  the open issues of the list and their labels, with the oldest one's age
//   Survey             satisfaction.json (lib/survey.mjs), counted by vote
//
// The issues are the poller's one list of every LABEL issue (discordIssues in poller.mjs), shared with
// the backfill. Test posts (entry.test) are left out everywhere. Each timing has two columns: all
// time, and the events of the last RECENT_DAYS — ingest by created_at, reply by firstReplyAt, close by
// closed_at — so a slow month long fixed stops hiding how intake runs today.
//
// Median is the mean of the two middle values for an even count; p90 is nearest-rank.

import { NO_ANSWER } from "./survey.mjs";

export const DISCORD_EPOCH = 1420070400000;
export const RECENT_DAYS = 30;
const DAY = 86400000;
const HOUR = 3600000;
const NEEDS_INFO = "needs-info";
const VOTES = [
	["yes", "✅ Yes"],
	["partly", "🟡 Partly"],
	["no", "❌ No"],
	[NO_ANSWER, "no answer"],
];

/** The moment a Discord id was minted: a forum post's id is its creation time. */
export const snowflakeTime = (id) => Number((BigInt(id) >> 22n) + BigInt(DISCORD_EPOCH));

/** { n, median, p90, max } of a list of durations, or { n: 0 }. */
export function stats(values) {
	const v = [...values].sort((a, b) => a - b);
	const n = v.length;
	if (!n) return { n };
	const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
	return { n, median, p90: v[Math.ceil(0.9 * n) - 1], max: v[n - 1] };
}

const labelNames = (issue) => (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));

/**
 * state: the poller's state ({ tracked }); issues: every LABEL issue, open and closed; satisfaction:
 * the rows of satisfaction.json. Returns plain numbers in ms, for renderSummary or anyone else.
 */
export function computeMetrics({ state, issues, satisfaction = [], now = Date.now(), recentDays = RECENT_DAYS }) {
	const since = now - recentDays * DAY;
	const tracked = Object.entries(state.tracked || {});
	const tests = new Set(tracked.filter(([, e]) => e?.test && e.issue).map(([, e]) => e.issue));
	const byNumber = new Map(issues.filter((i) => !i.pull_request && !tests.has(i.number)).map((i) => [i.number, i]));

	const timing = () => ({ all: [], recent: [] });
	const ingest = timing();
	const reply = timing();
	const close = timing();
	const add = (t, ms, at) => {
		t.all.push(ms);
		if (at >= since) t.recent.push(ms);
	};
	let replyOf = 0;
	for (const [threadId, entry] of tracked) {
		const issue = entry && !entry.test && byNumber.get(entry.issue);
		if (!issue) continue;
		const created = Date.parse(issue.created_at);
		add(ingest, created - snowflakeTime(threadId), created);
		if (entry.firstReplyAt || entry.awaitingReply) replyOf++;
		if (entry.firstReplyAt) {
			const at = Date.parse(entry.firstReplyAt);
			add(reply, at - created, at);
		}
		if (issue.closed_at) {
			const at = Date.parse(issue.closed_at);
			add(close, at - created, at);
		}
	}

	const open = [...byNumber.values()].filter((i) => i.state === "open");
	const oldest = open.reduce((min, i) => Math.min(min, Date.parse(i.created_at)), Infinity);
	const survey = Object.fromEntries(VOTES.map(([vote]) => [vote, 0]));
	for (const row of satisfaction) if (row?.vote in survey) survey[row.vote]++;

	const both = (t) => ({ all: stats(t.all), recent: stats(t.recent) });
	return {
		recentDays,
		ingest: both(ingest),
		reply: { ...both(reply), of: replyOf },
		close: both(close),
		open: open.length,
		oldestOpen: open.length ? now - oldest : null,
		needsInfo: open.filter((i) => labelNames(i).includes(NEEDS_INFO)).length,
		survey,
	};
}

/** 45 min · 1.5 h · 3.2 d */
export function duration(ms) {
	if (ms < HOUR) return `${Math.round(ms / 60000)} min`;
	if (ms < 48 * HOUR) return `${(ms / HOUR).toFixed(1)} h`;
	return `${(ms / DAY).toFixed(1)} d`;
}

const cell = (s) => (s.n ? `${duration(s.median)} · p90 ${duration(s.p90)} · max ${duration(s.max)} (n=${s.n})` : "—");

/** The markdown table of one project, for $GITHUB_STEP_SUMMARY. */
export function renderSummary(name, m) {
	const rows = [
		["Ingest lag (post → issue)", cell(m.ingest.all), cell(m.ingest.recent)],
		[`First human reply (${m.reply.all.n || 0} of ${m.reply.of} answered)`, cell(m.reply.all), cell(m.reply.recent)],
		["Time to close", cell(m.close.all), cell(m.close.recent)],
		["Open Discord issues", m.open ? `${m.open} · oldest ${duration(m.oldestOpen)}` : "0", ""],
		["`needs-info`", String(m.needsInfo), ""],
		["Survey", VOTES.map(([vote, label]) => `${label} ${m.survey[vote]}`).join(" · "), ""],
	];
	return [
		`### ${name} — intake metrics`,
		"",
		`| Metric | All time | Last ${m.recentDays} d |`,
		"|---|---|---|",
		...rows.map((r) => `| ${r.join(" | ")} |`),
		"",
		"Times are median · p90 · max. Test posts are left out.",
		"",
	].join("\n");
}
