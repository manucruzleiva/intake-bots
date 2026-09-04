// Discord -> GitHub Issues intake poller for Cobblemon Raid Icons.
//
// Polls a Discord FORUM channel (the tickets forum) over the REST API — no gateway/websocket, so it
// runs fine as a GitHub Actions cron. Each NEW forum post (thread) becomes a GitHub issue in the code repo;
// the bot then replies in the thread (never linking the private repo). Already-seen threads are
// remembered in state.json so nothing is filed twice.
//
// The reply — and the issue's labels — follow the post's FORUM TAG (Bug / Crash / Idea / Feedback).
// Asking for a crash report under someone's feature idea reads like a bot that did not look, so each
// kind gets its own text and only the ones where logs help ask for logs. Tags are resolved by NAME at
// runtime from the forum's own tag list: no ids are hardcoded, and renaming a tag in Discord does not
// break anything as long as the word survives.
//
// The bot also closes the loop: once the issue is closed on GitHub it posts that back to the thread,
// distinguishing "fixed" from "not planned". Without it the reporter never learns the outcome.
//
// Required env:
//   DISCORD_BOT_TOKEN        bot token (needs the Message Content privileged intent + access to the forum)
//   DISCORD_FORUM_CHANNEL_ID id of the tickets forum channel
//   GH_TOKEN                 a PAT with `repo` scope on the issues repo (a fine-grained token works too)
//   GH_ISSUES_REPO           "owner/repo" to file issues into (e.g. the private code repo)
// Optional:
//   DISCORD_GUILD_ID         guild id — in practice REQUIRED: without it the active-threads lookup is
//                            skipped and only ARCHIVED posts are seen, so a fresh report waits for
//                            Discord to archive it
//   ISSUE_LABEL              label added to every filed issue (default "discord")
//   STATE_FILE               path to the dedup state (default ./state.json)
//   REPORTERS_FILE           path to the community-credit tally (default ./reporters.json)
//   SKIP_BEFORE_ID           ignore posts older than this snowflake, once. Only needed when a bot
//                            that tracked a high-water mark instead of a list is replaced by this
//                            one: its last id becomes the cut-off, and everything under it is
//                            recorded as already handled rather than filed a second time.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const D = "https://discord.com/api/v10";
const GH = "https://api.github.com";
// By project id, not slug: the Modrinth project is still a draft and has no public slug yet, and an
// id cannot be renamed out from under a link.
const UA = "cobblemon-raid-icons-intake (+https://modrinth.com/project/S01tPZTk)";

const TOKEN = req("DISCORD_BOT_TOKEN");
const FORUM = req("DISCORD_FORUM_CHANNEL_ID");
const GH_TOKEN = req("GH_TOKEN");
const REPO = req("GH_ISSUES_REPO");
const GUILD = process.env.DISCORD_GUILD_ID || "";
const LABEL = process.env.ISSUE_LABEL || "discord";
const STATE_FILE = process.env.STATE_FILE || "state.json";
const REPORTERS_FILE = process.env.REPORTERS_FILE || "reporters.json";
const SKIP_BEFORE_ID = process.env.SKIP_BEFORE_ID || "";
// Community credit is for the COMMUNITY. shiero is the author, so their own tickets never earn a
// line on the credits page — they'd be thanking themselves on their own wiki.
const AUTHOR_USERNAMES = (process.env.AUTHOR_USERNAMES || "shiero").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function req(name) {
	const v = process.env[name];
	if (!v) {
		console.error(`Missing required env ${name}`);
		process.exit(1);
	}
	return v;
}

async function discord(path) {
	const res = await fetch(D + path, { headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": UA } });
	if (!res.ok) {
		const err = new Error(`Discord ${path} -> ${res.status} ${await res.text()}`);
		// 401 and 403 are not partial failures: they mean this run cannot do its job at all. The
		// callers below swallow everything else on purpose - a channel with no tags, a thread deleted
		// mid-run - but swallowing these turns "the bot has no credentials" into "there was nothing
		// new", and those are indistinguishable from outside. Intake was down eleven days that way.
		if (res.status === 401 || res.status === 403) err.fatal = true;
		throw err;
	}
	return res.json();
}

async function discordPost(path, body) {
	const res = await fetch(D + path, {
		method: "POST",
		headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": UA, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`Discord POST ${path} -> ${res.status} ${await res.text()}`);
	}
	return res.json();
}

async function github(path, body) {
	const res = await fetch(GH + path, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${GH_TOKEN}`,
			"User-Agent": UA,
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`GitHub ${path} -> ${res.status} ${await res.text()}`);
	}
	return res.json();
}

async function githubGet(path) {
	const res = await fetch(GH + path, {
		headers: {
			Authorization: `Bearer ${GH_TOKEN}`,
			"User-Agent": UA,
			Accept: "application/vnd.github+json",
		},
	});
	if (!res.ok) {
		throw new Error(`GitHub GET ${path} -> ${res.status} ${await res.text()}`);
	}
	return res.json();
}

// ── Post kinds ──────────────────────────────────────────────────────────────
// Driven by the forum tag. `match` runs against the lowercased tag names, so "Bug", "bugs" and
// "Bug report" all land on the same kind, and a tag nobody anticipated falls through to `other`
// with a short, honest reply instead of a wrong one.
const KINDS = {
	crash: {
		match: (t) => t.includes("crash"),
		labels: ["bug", "crash"],
		filed:
			"🚨 **Tracked as a crash** — this one jumps the queue.\n\n" +
			"If you can, attach the crash report (`crash-reports/crash-*.txt`) or `logs/latest.log`: the stack " +
			"trace is what turns this from a hunt into a fix. Your mod list helps too, in case it is a conflict.",
		fixed:
			"✅ **Fixed.** The cause is gone on our side and the fix ships in the next release — update and give " +
			"it a go. If it comes back, post here and we reopen this.",
	},
	bug: {
		match: (t) => t.includes("bug") || t.includes("issue") || t.includes("problem"),
		labels: ["bug"],
		filed:
			"🐛 **Tracked as a bug.**\n\n" +
			"If it is not already above: your Minecraft and mod versions, the loader (Fabric or NeoForge), and " +
			"the steps that trigger it. That is usually what separates a fix from a guess.",
		fixed:
			"✅ **Fixed.** It ships in the next release — update and give it a go. If it comes back, post here " +
			"and we reopen this.",
	},
	idea: {
		match: (t) => t.includes("idea") || t.includes("feature") || t.includes("suggestion") || t.includes("request"),
		labels: ["enhancement"],
		filed:
			"💡 **Tracked as an idea.**\n\n" +
			"It goes on the list to weigh against the roadmap — no promise on timing, and nothing else needed " +
			"from you. If you have a picture of what you are imagining, it helps more than a description.",
		fixed: "✅ **This one landed.** It ships in the next release. Thanks for the idea — it made the mod better.",
	},
	feedback: {
		match: (t) => t.includes("feedback") || t.includes("thought") || t.includes("opinion"),
		labels: [],
		filed:
			"💬 **Tracked as feedback.**\n\n" +
			"Nothing to do on your side — it is read and recorded, and this is the kind of thing that actually " +
			"steers what gets built next.",
		fixed: "✅ **Wrapped up.** Thanks for taking the time to write it — it was read and it counted.",
	},
	other: {
		match: () => false, // fallback only
		labels: [],
		filed: "✅ **Tracked.** It is on the list, and we post back here when there is news.",
		fixed: "✅ **Closed** — this one is wrapped up.",
	},
};

// Closing as "not planned" is not a fix, and saying "fixed" there would be a lie the reporter can
// check. One honest text for every kind, with the door left open.
const NOT_PLANNED =
	"📕 **Closed without a change** — we are not taking this one forward for now.\n\n" +
	"That is not a verdict on the report: if you disagree, or something new turns up, say so here and it " +
	"can be reopened.";

function classify(tagNames) {
	const lowered = tagNames.map((t) => String(t).toLowerCase());
	// Crash is checked first on purpose: a post tagged both Bug and Crash is a crash.
	for (const key of ["crash", "bug", "idea", "feedback"]) {
		if (lowered.some((t) => KINDS[key].match(t))) return key;
	}
	return "other";
}

/** id -> name for the forum's own tag list, so nothing about tags is hardcoded here. */
async function forumTagNames() {
	try {
		const forum = await discord(`/channels/${FORUM}`);
		const byId = new Map();
		for (const t of forum.available_tags || []) byId.set(t.id, t.name);
		if (byId.size) console.log(`Forum tags: ${[...byId.values()].join(", ")}`);
		return byId;
	} catch (e) {
		if (e.fatal) throw e;
		console.warn("forum tags:", e.message);
		return new Map();
	}
}

function loadState() {
	if (existsSync(STATE_FILE)) {
		try {
			const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
			// `tracked` (thread -> issue) arrived with the close-the-loop replies; states written before
			// that only have `processed`, and those threads simply get no closing message.
			return { processed: s.processed || [], tracked: s.tracked || {} };
		} catch {
			/* corrupt — start fresh */
		}
	}
	return { processed: [], tracked: {} };
}

// Who reported what, for the community credits on the wiki. It is a plain tally kept in git so it has
// history — the alternative is trawling Discord by hand at release time.
function loadReporters() {
	if (existsSync(REPORTERS_FILE)) {
		try {
			return JSON.parse(readFileSync(REPORTERS_FILE, "utf8"));
		} catch {
			/* corrupt — start fresh rather than lose the run */
		}
	}
	return {};
}

function creditReporter(reporters, username, kind) {
	if (!username || username === "unknown") return;
	if (AUTHOR_USERNAMES.includes(username.toLowerCase())) return; // the author is not a community reporter
	const r = (reporters[username] ||= { count: 0, kinds: {} });
	r.count += 1;
	r.kinds ||= {};
	r.kinds[kind] = (r.kinds[kind] || 0) + 1;
}

/** All forum posts (threads) under the tickets forum: active + recently archived. */
async function forumThreads() {
	const threads = new Map();
	try {
		const active = GUILD ? await discord(`/guilds/${GUILD}/threads/active`) : { threads: [] };
		for (const t of active.threads || []) {
			if (t.parent_id === FORUM) threads.set(t.id, t);
		}
	} catch (e) {
		if (e.fatal) throw e;
		console.warn("active threads:", e.message);
	}
	// Recently archived public threads under the forum (catches posts closed between runs).
	try {
		const archived = await discord(`/channels/${FORUM}/threads/archived/public?limit=25`);
		for (const t of archived.threads || []) threads.set(t.id, t);
	} catch (e) {
		if (e.fatal) throw e;
		console.warn("archived threads:", e.message);
	}
	return [...threads.values()];
}

/** The opening message of a forum thread (same id as the thread for forum posts). */
async function starterMessage(threadId) {
	try {
		return await discord(`/channels/${threadId}/messages/${threadId}`);
	} catch {
		// Fallback: oldest message in the thread.
		const msgs = await discord(`/channels/${threadId}/messages?limit=1&after=0`);
		return Array.isArray(msgs) && msgs.length ? msgs[0] : null;
	}
}

/** Build the GitHub issue body from the Discord post, inlining images and crash/text attachments. */
async function buildBody(thread, msg, tagNames) {
	const author = msg?.author ? `${msg.author.username}` : "unknown";
	const lines = [];
	const tags = tagNames.length ? ` — tagged ${tagNames.map((t) => `\`${t}\``).join(", ")}` : "";
	lines.push(`**Reported on Discord** by \`${author}\` — forum post "${thread.name}"${tags}.`);
	lines.push("");
	lines.push(msg?.content?.trim() ? msg.content : "_(no description)_");
	for (const att of msg?.attachments || []) {
		const name = (att.filename || "").toLowerCase();
		if (/\.(png|jpe?g|gif|webp)$/.test(name)) {
			lines.push("", `![${att.filename}](${att.url})`);
		} else if (/\.(txt|log|json)$/.test(name)) {
			let text = "(could not fetch — Discord CDN links expire)";
			try {
				const r = await fetch(att.url, { headers: { "User-Agent": UA } });
				if (r.ok) text = (await r.text()).slice(0, 60000);
			} catch {
				/* expired link */
			}
			lines.push("", `<details><summary>${att.filename}</summary>`, "", "```", text, "```", "", "</details>");
		} else {
			lines.push("", `Attachment: ${att.filename} (${att.url})`);
		}
	}
	return lines.join("\n");
}

/** File the issues for posts we have not seen yet. */
async function fileNewThreads(state, seen, tagsById, reporters, threads) {
	let filed = 0;
	for (const thread of threads) {
		if (seen.has(thread.id)) continue;
		// Snowflakes are time-ordered, so "older than the previous bot's last id" means "already
		// filed by it". They are marked as seen so the comparison only ever runs once per post.
		if (SKIP_BEFORE_ID && BigInt(thread.id) <= BigInt(SKIP_BEFORE_ID)) {
			seen.add(thread.id);
			continue;
		}
		try {
			const tagNames = (thread.applied_tags || []).map((id) => tagsById.get(id)).filter(Boolean);
			const kind = classify(tagNames);
			const spec = KINDS[kind];
			const msg = await starterMessage(thread.id);
			const issue = await github(`/repos/${REPO}/issues`, {
				title: `[Discord] ${thread.name}`.slice(0, 250),
				body: await buildBody(thread, msg, tagNames),
				labels: [LABEL, ...spec.labels],
			});
			console.log(`Filed #${issue.number} [${kind}] for thread ${thread.id} ("${thread.name}")`);
			state.tracked[thread.id] = { issue: issue.number, kind };
			creditReporter(reporters, msg?.author?.username, kind);
			// Reply in the thread — NEVER link the private code repo.
			try {
				await discordPost(`/channels/${thread.id}/messages`, { content: spec.filed });
			} catch (e) {
				console.warn("reply failed:", e.message);
			}
			seen.add(thread.id);
			filed++;
		} catch (e) {
			console.error(`thread ${thread.id} failed:`, e.message);
		}
	}
	return filed;
}

// Threads imported before the close-the-loop replies existed are in `processed` but not in `tracked`,
// so nothing would ever be posted back to them — and those are precisely the oldest, most likely to be
// closed next. Their issues are recoverable: the title is "[Discord] <thread name>", which is how they
// were filed. Matching is by title, once; after that they behave like any other tracked thread.
async function backfillTracked(state, threads, tagsById) {
	// Anything still sitting on the `other` fallback gets re-read from the post's tags first. Tags get
	// added or corrected after the fact, and a stale `other` only surfaces much later — as the blandest
	// possible closing message, on the report that waited longest for it.
	let reclassified = 0;
	for (const thread of threads) {
		const entry = state.tracked[thread.id];
		if (!entry || entry.kind !== "other") continue;
		const kind = classify((thread.applied_tags || []).map((id) => tagsById.get(id)).filter(Boolean));
		if (kind !== "other") {
			entry.kind = kind;
			reclassified++;
		}
	}
	if (reclassified) console.log(`Re-read the kind of ${reclassified} tracked thread(s) from their tags.`);

	const missing = threads.filter((t) => !state.tracked[t.id]);
	if (!missing.length) return reclassified;

	let issues;
	try {
		issues = await githubGet(`/repos/${REPO}/issues?state=all&labels=${encodeURIComponent(LABEL)}&per_page=100`);
	} catch (e) {
		console.warn("backfill:", e.message);
		return reclassified;
	}
	const byTitle = new Map();
	for (const i of issues) {
		if (i.pull_request) continue;
		byTitle.set(i.title, i);
	}

	let linked = 0;
	for (const thread of missing) {
		const issue = byTitle.get(`[Discord] ${thread.name}`.slice(0, 250));
		if (!issue) continue;
		// The post's own tag is the better source: these issues predate the kind labels, so reading
		// their labels would call every one of them "other" and give them the blandest closing text.
		const tagNames = (thread.applied_tags || []).map((id) => tagsById.get(id)).filter(Boolean);
		let kind = classify(tagNames);
		if (kind === "other") {
			const names = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name).toLowerCase());
			if (names.includes("crash")) kind = "crash";
			else if (names.includes("bug")) kind = "bug";
			else if (names.includes("enhancement")) kind = "idea";
		}
		state.tracked[thread.id] = { issue: issue.number, kind };
		// Already-closed issues stay silent: announcing a months-old close now would be noise, and the
		// reporter was told at the time or not at all.
		if (issue.state === "closed") state.tracked[thread.id].closedAnnounced = true;
		linked++;
	}
	if (linked) console.log(`Backfilled ${linked} thread(s) to their existing issue.`);
	return linked;
}

/** Post back to the thread when its issue gets closed, once. */
async function announceClosed(state) {
	const pending = Object.entries(state.tracked).filter(([, v]) => v && v.issue && !v.closedAnnounced);
	if (!pending.length) return 0;

	// One list call instead of one GET per tracked issue: the crons run every 10 minutes and this is
	// the only place that touches GitHub on a quiet run.
	let closed;
	try {
		closed = await githubGet(`/repos/${REPO}/issues?state=closed&per_page=100&sort=updated&direction=desc`);
	} catch (e) {
		console.warn("closed issues:", e.message);
		return 0;
	}
	const byNumber = new Map(closed.filter((i) => !i.pull_request).map((i) => [i.number, i]));

	let announced = 0;
	for (const [threadId, entry] of pending) {
		const issue = byNumber.get(entry.issue);
		if (!issue) continue;
		const spec = KINDS[entry.kind] || KINDS.other;
		const text = issue.state_reason === "not_planned" ? NOT_PLANNED : spec.fixed;
		try {
			await discordPost(`/channels/${threadId}/messages`, { content: text });
			entry.closedAnnounced = true;
			announced++;
			console.log(`Announced close of #${entry.issue} in thread ${threadId}`);
		} catch (e) {
			// A locked thread can never take the message: retrying it every 10 minutes forever would be
			// pure noise, so give up after a few tries and move on.
			entry.closeAttempts = (entry.closeAttempts || 0) + 1;
			if (entry.closeAttempts >= 3) entry.closedAnnounced = true;
			console.warn(`close reply failed for thread ${threadId}:`, e.message);
		}
	}
	return announced;
}

async function main() {
	const state = loadState();
	const seen = new Set(state.processed);
	const reporters = loadReporters();
	const tagsById = await forumTagNames();
	const threads = await forumThreads();

	const filed = await fileNewThreads(state, seen, tagsById, reporters, threads);
	await backfillTracked(state, threads, tagsById);
	const announced = await announceClosed(state);

	state.processed = [...seen].slice(-1000); // cap the dedup list
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	if (filed) writeFileSync(REPORTERS_FILE, JSON.stringify(reporters, null, 2) + "\n");
	console.log(`Done. ${filed} new issue(s) filed; ${announced} close(s) announced; ${seen.size} threads tracked.`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
