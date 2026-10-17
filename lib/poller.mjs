// Discord -> GitHub Issues intake poller, shared by every project in ../projects.json.
//
// It runs from the project's own folder (the workflow sets the working directory), so state.json and
// reporters.json resolve to that folder. Everything project-specific arrives through the env below.
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
// distinguishing "fixed" from "not planned". Without it the reporter never learns the outcome. Then it
// archives the thread, once: the post leaves the forum's open list but the forum search still finds it.
// When a Release ships the fix, it says so in the same thread and archives it again (lib/releases.mjs).
//
// And it keeps listening: whatever the reporter writes in the thread after the import — the log the
// bot asked for, "it came back" after a close — goes to the issue as one comment per thread per run.
//
// The SHARED tickets forum holds every mod's posts, each with a MOD TAG next to its kind tag. A row
// reads it as well as its own legacy forum and keeps only the posts carrying its tag. A post tagged for
// two mods becomes an issue in each repo: the first of them in projects.json order replies on filing,
// and every later message of either names its mod. A post with no mod tag belongs to no row;
// lib/unrouted.mjs asks for the tag, and the owning row files it once it is there.
//
// Required env:
//   DISCORD_BOT_TOKEN        bot token (needs the Message Content privileged intent + access to the forum)
//   DISCORD_FORUM_CHANNEL_ID id of the project's own tickets forum. Optional when the shared forum is read
//                            (DISCORD_SHARED_FORUM_ID + MOD_TAG): a mod added after it has no forum of its own
//   GH_TOKEN                 a PAT with `repo` scope on the issues repo (a fine-grained token works too)
//   GH_ISSUES_REPO           "owner/repo" to file issues into (e.g. the private code repo)
//   INTAKE_USER_AGENT        User-Agent sent to Discord and GitHub, one per project
// Optional:
//   DISCORD_GUILD_ID         guild id — in practice REQUIRED: without it the active-threads lookup is
//                            skipped and only ARCHIVED posts are seen, so a fresh report waits for
//                            Discord to archive it
//   DISCORD_SHARED_FORUM_ID  id of the shared tickets forum. Read only together with MOD_TAG
//   MOD_TAG                  this project's tag in the shared forum (`tag` in projects.json)
//   ISSUE_LABEL             label added to every filed issue (default "discord")
//   STATE_FILE               path to the dedup state (default ./state.json)
//   REPORTERS_FILE           path to the community-credit tally (default ./reporters.json)
//   REPORTER_ROLE            the role every credited reporter gets (default "Bug Catcher", server.json)
//   SKIP_BEFORE_ID           ignore posts older than this snowflake, once. Only needed when a bot
//                            that tracked a high-water mark instead of a list is replaced by this
//                            one: its last id becomes the cut-off, and everything under it is
//                            recorded as already handled rather than filed a second time.
//   FOLLOWUP_DAYS_AFTER_CLOSE  how long a closed issue keeps taking the reporter's follow-ups as
//                            comments (default 14). Past that a message is skipped, not queued
//   DRY_RUN                  "1": print the issue each new thread would get and the comment each
//                            follow-up would post, and the release messages (lib/releases.mjs),
//                            and touch nothing — no issue, no comment, no
//                            Discord reply, no state or credits written
//   ONLY_THREAD              thread id: run on that one thread, seen or not, so an old import can be
//                            re-rendered. Refused without DRY_RUN, where it would file it a second time
//
// Exit code: 1 on a fatal error (bad credentials, no network), and also when the run finished but
// could not do part of its job — the forum could not be listed, a thread could not be filed, GitHub
// refused a read. Those used to be warnings in a green run, and a green run that imports nothing is
// exactly how intake went down unnoticed. The state is still written, so the workflow persists what
// did work; lib/health.mjs reads the red row.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { announceReleases, RELEASE_PREFIX } from "./releases.mjs";
import { projects } from "./gates.mjs";
import { ASK as ASK_FOR_MOD_TAG } from "./unrouted.mjs";
import { NEEDS, missingInfo, askFor, allAsks } from "./completeness.mjs";

const D = "https://discord.com/api/v10";
const GH = "https://api.github.com";
const UA = req("INTAKE_USER_AGENT");

const TOKEN = req("DISCORD_BOT_TOKEN");
const FORUM = (process.env.DISCORD_FORUM_CHANNEL_ID || "").trim();
const GH_TOKEN = req("GH_TOKEN");
const REPO = req("GH_ISSUES_REPO");
const GUILD = process.env.DISCORD_GUILD_ID || "";
const MOD_TAG = process.env.MOD_TAG || "";
const SHARED_FORUM = MOD_TAG ? process.env.DISCORD_SHARED_FORUM_ID || "" : "";
if (!FORUM && !SHARED_FORUM) {
	console.error("Missing required env DISCORD_FORUM_CHANNEL_ID (or DISCORD_SHARED_FORUM_ID with MOD_TAG)");
	process.exit(1);
}
// Every mod tag of the shared forum, in projects.json order. They say WHERE a post goes, never what
// kind it is: classify must not see them, or a mod named "… Ideas" would turn every bug into an idea.
const MOD_TAGS = projects.map((p) => p.tag).filter(Boolean);
const LABEL = process.env.ISSUE_LABEL || "discord";
const STATE_FILE = process.env.STATE_FILE || "state.json";
const REPORTERS_FILE = process.env.REPORTERS_FILE || "reporters.json";
const SKIP_BEFORE_ID = process.env.SKIP_BEFORE_ID || "";
const DRY_RUN = process.env.DRY_RUN === "1";
const ONLY_THREAD = process.env.ONLY_THREAD || "";
// GitHub rejects an issue body over 65536 characters with a 422, and a thread that fails to file is
// retried — and fails — on every run. The margin covers the fences and truncation notes around logs.
const BODY_MAX = 65536;
const BODY_MARGIN = 1024;
// Follow-ups closer than this to the message before them are one sitting, rendered without a break.
const FOLLOW_UP_GAP_MS = 10 * 60 * 1000;
const FOLLOWUP_DAYS_AFTER_CLOSE = Number(process.env.FOLLOWUP_DAYS_AFTER_CLOSE || 14);
// Community credit is for the COMMUNITY. shiero is the author, so their own tickets never earn a
// line on the credits page — they'd be thanking themselves on their own wiki.
const AUTHOR_USERNAMES = (process.env.AUTHOR_USERNAMES || "shiero").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// What this run could not do. Each entry turns the run red at the end — see "Exit code" above. A
// per-thread Discord quirk (a locked thread refusing a reply, a test post not yet deletable) is not
// here: it says nothing about whether intake works, and it would keep the row red forever.
const degraded = [];

function degrade(what, e) {
	console.log(`::error::${what}: ${e.message}`);
	degraded.push(`${what}: ${e.message}`);
}

function req(name) {
	const v = process.env[name];
	if (!v) {
		console.error(`Missing required env ${name}`);
		process.exit(1);
	}
	// A BOM and surrounding whitespace are stripped, because both have already shipped inside a
	// GitHub secret here: PowerShell pipes UTF-8 WITH a byte-order mark, so a token loaded that way
	// arrives as "\uFEFFMTIz...". A header value cannot hold U+FEFF at all - fetch throws
	// "character at index 4 has a value of 65279" before the request leaves the machine - and that
	// is what took intake down while every run stayed green. Fixing the secret is still the real
	// fix; this is so a bad paste degrades into a working run instead of a silent outage.
	return v.replace(/^\uFEFF/, "").trim();
}

async function discord(path) {
	let res;
	try {
		res = await fetch(D + path, { headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": UA } });
	} catch (e) {
		// The request never left. A malformed header, a DNS failure, a dead network - none of them
		// are the partial failure the callers below are written to tolerate, and every one of them
		// means this run cannot do its job. Fatal, like a 401.
		e.fatal = true;
		throw e;
	}
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

/** PATCH whose error carries Discord's JSON `code`, so the caller can tell "already so" from a failure. */
async function discordPatch(path, body) {
	const res = await fetch(D + path, {
		method: "PATCH",
		headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": UA, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		const err = new Error(`Discord PATCH ${path} -> ${res.status} ${text}`);
		try {
			err.code = JSON.parse(text).code;
		} catch {
			// not JSON: no code to read
		}
		throw err;
	}
	return res.json();
}

/**
 * Body-less PUT (204), with Discord's JSON `code` on the error like discordPatch. A 429 waits out
 * `retry_after` and tries again: the matrix rows run at once and share the guild's role bucket, so a
 * backfill or a burst of filings across mods hits it within a handful of calls.
 */
async function discordPut(path, retries = 3) {
	const res = await fetch(D + path, { method: "PUT", headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": UA } });
	if (res.status === 429 && retries > 0) {
		const wait = Math.ceil(1000 * Number((await res.json().catch(() => ({}))).retry_after || 1));
		await new Promise((resolve) => setTimeout(resolve, wait));
		return discordPut(path, retries - 1);
	}
	if (!res.ok) {
		const text = await res.text();
		const err = new Error(`Discord PUT ${path} -> ${res.status} ${text}`);
		try {
			err.code = JSON.parse(text).code;
		} catch {
			// not JSON: no code to read
		}
		throw err;
	}
}

/** DELETE that treats "already gone" as done, so a cleanup interrupted halfway can simply run again. */
async function discordDelete(path) {
	const res = await fetch(D + path, { method: "DELETE", headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": UA } });
	if (!res.ok && res.status !== 404) {
		throw new Error(`Discord DELETE ${path} -> ${res.status} ${await res.text()}`);
	}
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
	if (!res.ok) throw await githubError(`GitHub ${path}`, res);
	return res.json();
}

/**
 * A 401 means the token is bad, not that one call failed: fatal, like in discord(). A 403 is not —
 * GitHub also answers it for a secondary rate limit, and aborting there would drop the state of the
 * issues this run already filed, so the next run would file them again. It degrades instead.
 */
async function githubError(what, res) {
	const err = new Error(`${what} -> ${res.status} ${await res.text()}`);
	if (res.status === 401) err.fatal = true;
	return err;
}

async function githubGet(path) {
	const res = await fetch(GH + path, {
		headers: {
			Authorization: `Bearer ${GH_TOKEN}`,
			"User-Agent": UA,
			Accept: "application/vnd.github+json",
		},
	});
	if (!res.ok) throw await githubError(`GitHub GET ${path}`, res);
	return res.json();
}

/** DELETE that treats "already gone" as done, like discordDelete. */
async function githubDelete(path) {
	const res = await fetch(GH + path, {
		method: "DELETE",
		headers: {
			Authorization: `Bearer ${GH_TOKEN}`,
			"User-Agent": UA,
			Accept: "application/vnd.github+json",
		},
	});
	if (!res.ok && res.status !== 404) throw await githubError(`GitHub DELETE ${path}`, res);
}

// ── Post kinds ──────────────────────────────────────────────────────────────
// Driven by the forum tag. `match` runs against the lowercased tag names, so "Bug", "bugs" and
// "Bug report" all land on the same kind, and a tag nobody anticipated falls through to `other`
// with a short, honest reply instead of a wrong one.
const KINDS = {
	crash: {
		match: (t) => t.includes("crash"),
		labels: ["bug", "crash"],
		// The request for whatever the post still lacks follows it: see filedReply.
		filed: "🚨 **Tracked as a crash** — this one jumps the queue.",
		fixed:
			"✅ **Fixed.** The cause is gone on our side and the fix ships in the next release — update and give " +
			"it a go. If it comes back, post here and we reopen this.",
	},
	bug: {
		match: (t) => t.includes("bug") || t.includes("issue") || t.includes("problem"),
		labels: ["bug"],
		filed: "🐛 **Tracked as a bug.**",
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

// The status tags of the shared forum (#30), resolved by name like every other tag. They are
// moderated: only Manage Threads (the bot, staff) can set them, so a reporter cannot mark their own
// post resolved. Archiving adds the close status; Needs info marks a report still missing a piece
// (#10), and a close replaces it.
const CLOSED_STATUS = { completed: "Resolved", not_planned: "Not planned" };
const NEEDS_INFO_TAG = "Needs info";
const STATUS_TAGS = [...Object.values(CLOSED_STATUS), NEEDS_INFO_TAG];
// The issue side of Needs info. Colour and description are the ones routes already had, so the label
// created in every other repo matches it.
const NEEDS_INFO_LABEL = { name: "needs-info", color: "d4c5f9", description: "Waiting on more info from reporter" };
const MAX_APPLIED_TAGS = 5; // Discord's cap per post
// What the close reply of another mod looks like in a multi-mod post: `**<Tag>** · <text>`.
const CLOSE_TEXTS = new Map([
	...Object.values(KINDS).map((k) => [k.fixed, "completed"]),
	[NOT_PLANNED, "not_planned"],
]);

/** The filing reply: the kind's line, then a request naming only what the report still lacks. */
const filedReply = (kind, missing) => KINDS[kind].filed + askFor(missing);

function classify(tagNames) {
	const lowered = tagNames.map((t) => String(t).toLowerCase());
	// Crash is checked first on purpose: a post tagged both Bug and Crash is a crash.
	for (const key of ["crash", "bug", "idea", "feedback"]) {
		if (lowered.some((t) => KINDS[key].match(t))) return key;
	}
	return "other";
}

/** id -> name for the tag lists of the project's forum and the shared one, so nothing about tags is hardcoded here. */
async function forumTagNames() {
	const byId = new Map();
	for (const id of [FORUM, SHARED_FORUM].filter(Boolean)) {
		try {
			const forum = await discord(`/channels/${id}`);
			for (const t of forum.available_tags || []) byId.set(t.id, t.name);
		} catch (e) {
			if (e.fatal) throw e;
			// The forum's own channel: failing to read it is what a wrong channel id looks like.
			degrade(`forum tags of ${id}`, e);
		}
	}
	if (byId.size) console.log(`Forum tags: ${[...new Set(byId.values())].join(", ")}`);
	return byId;
}

const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();

/** A post's tag names, split: the kind tags pick the reply and the labels, the mod tags the repos. */
function threadTags(thread, tagsById) {
	const names = (thread.applied_tags || []).map((id) => tagsById.get(id)).filter(Boolean);
	return {
		names,
		kinds: names.filter((n) => !MOD_TAGS.some((t) => sameTag(t, n)) && !STATUS_TAGS.some((t) => sameTag(t, n))),
		mods: MOD_TAGS.filter((t) => names.some((n) => sameTag(t, n))),
	};
}

/** The id of this project's tag in the shared forum, or "" when there is none to read. */
function modTagId(tagsById) {
	if (!SHARED_FORUM) return "";
	for (const [id, name] of tagsById) if (sameTag(name, MOD_TAG)) return id;
	degrade("shared forum", new Error(`it has no "${MOD_TAG}" tag, so none of its posts reach this project`));
	return "";
}

/** In a post filed for several mods, every later message from one of them says which. */
const say = (entry, text) => (entry.others?.length ? `**${MOD_TAG}** · ${text}` : text);

function loadState() {
	if (existsSync(STATE_FILE)) {
		try {
			const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
			// `tracked` (thread -> issue) arrived with the close-the-loop replies; states written before
			// that only have `processed`, and those threads simply get no closing message.
			return { processed: s.processed || [], tracked: s.tracked || {}, lastRelease: s.lastRelease || "" };
		} catch {
			/* corrupt — start fresh */
		}
	}
	return { processed: [], tracked: {}, lastRelease: "" };
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

function creditReporter(reporters, author, kind) {
	// A bot is not the community either: a post the bot opened itself, to test the pipeline, must not
	// earn it a line on the credits page.
	if (!author || author.bot) return;
	const username = author.username;
	if (!username) return;
	if (AUTHOR_USERNAMES.includes(username.toLowerCase())) return; // the author is not a community reporter
	const r = (reporters[username] ||= { count: 0, kinds: {} });
	r.count += 1;
	r.kinds ||= {};
	r.kinds[kind] = (r.kinds[kind] || 0) + 1;
	// The username keys the tally because that is what the credits page prints; the role needs the id.
	if (author.id) r.id = author.id;
}

// ── Reporter role ───────────────────────────────────────────────────────────
// Every credited reporter also gets the REPORTER_ROLE on the server, so the thanks shows where they
// are and not only on a wiki page. The role follows the tally, so it has the same exclusions: no bots
// (the bot's own test posts), no author. `bugCatcher` records the outcome once: true when granted —
// never put back if a moderator or the member takes it off —, NOT_A_MEMBER when they left the server.
// Anything else is retried next run. Needs Manage Roles and the role under the bot's own.
const REPORTER_ROLE = process.env.REPORTER_ROLE || "Bug Catcher";
const NOT_A_MEMBER = "not a member";
const UNKNOWN_MEMBER = 10007;

/** Grant the role to every reporter with an id and no outcome yet. Returns how many entries changed. */
async function grantReporterRoles(reporters) {
	const pending = Object.entries(reporters).filter(([, r]) => r.id && r.bugCatcher === undefined);
	if (!pending.length || !GUILD) return 0;
	let role;
	try {
		role = (await discord(`/guilds/${GUILD}/roles`)).find((r) => r.name.toLowerCase() === REPORTER_ROLE.toLowerCase());
	} catch (e) {
		if (e.fatal) throw e;
		console.log(`::warning::roles not listed, ${REPORTER_ROLE} not granted: ${e.message}`);
		return 0;
	}
	if (!role) {
		console.log(`::warning::No role "${REPORTER_ROLE}" in the server: ${pending.length} reporter(s) wait for it. server.json declares it.`);
		return 0;
	}
	let changed = 0;
	for (const [username, r] of pending) {
		try {
			await discordPut(`/guilds/${GUILD}/members/${r.id}/roles/${role.id}`);
			r.bugCatcher = true;
			console.log(`Granted ${REPORTER_ROLE} to ${username}`);
		} catch (e) {
			if (e.code !== UNKNOWN_MEMBER) {
				console.log(`::warning::${REPORTER_ROLE} not granted to ${username}: ${e.message}`);
				continue;
			}
			r.bugCatcher = NOT_A_MEMBER;
			console.log(`${username} is not in the server: ${REPORTER_ROLE} skipped`);
		}
		changed++;
	}
	return changed;
}

// The forum's pinned post is the how-to-report example that lib/server.mjs keeps (server.json `pinned`):
// never a report, whatever tags a moderator gives it.
const PINNED = 1 << 1;
const isPinned = (t) => Boolean(t.flags & PINNED);

/**
 * This project's posts, active + recently archived: every one in its own forum, and the ones in the
 * shared forum that carry its mod tag (`tagId`, "" = the shared forum is not read).
 */
async function forumThreads(tagId) {
	const threads = new Map();
	const mine = (t) =>
		!isPinned(t) && (t.parent_id === FORUM || (tagId && t.parent_id === SHARED_FORUM && (t.applied_tags || []).includes(tagId)));
	try {
		const active = GUILD ? await discord(`/guilds/${GUILD}/threads/active`) : { threads: [] };
		for (const t of active.threads || []) {
			if (mine(t)) threads.set(t.id, t);
		}
	} catch (e) {
		if (e.fatal) throw e;
		degrade("active threads", e);
	}
	// Recently archived public threads under each forum (catches posts closed between runs).
	for (const forum of [FORUM, tagId && SHARED_FORUM].filter(Boolean)) {
		try {
			const archived = await discord(`/channels/${forum}/threads/archived/public?limit=25`);
			for (const t of archived.threads || []) if (mine(t)) threads.set(t.id, t);
		} catch (e) {
			if (e.fatal) throw e;
			degrade(`archived threads of ${forum}`, e);
		}
	}
	return [...threads.values()];
}

/** Every message in a thread after the given snowflake (default: all of them), oldest first. */
async function threadMessages(threadId, after = "0") {
	const all = [];
	for (;;) {
		const page = await discord(`/channels/${threadId}/messages?limit=100&after=${after}`);
		if (!Array.isArray(page) || !page.length) break;
		all.push(...page);
		if (page.length < 100) break;
		after = page.reduce((max, m) => maxId(max, m.id), after);
	}
	// Snowflakes are time-ordered; Discord's page order is not something to lean on.
	return all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
}

function maxId(a, b) {
	return BigInt(b) > BigInt(a) ? b : a;
}

/**
 * The report is the opening post plus everything its author wrote under it. Most people write in
 * Discord a paragraph per message, so the opening post alone is often one line of preamble. Other
 * people's replies are left out: a thread can hold a conversation, and an issue is not a transcript.
 */
function reportMessages(thread, msgs) {
	// A forum post's opening message shares the thread's id; if it was deleted, the oldest stands in.
	const starter = msgs.find((m) => m.id === thread.id) || msgs[0] || null;
	const followUps = msgs.filter(
		(m) => m !== starter && m.author?.id === thread.owner_id && !isOwnReply(m) && (m.content?.trim() || m.attachments?.length),
	);
	return { starter, followUps };
}

/** Images inline, text files folded in (by fitBody, once the room is known), anything else as a link. */
function renderAttachments(msg) {
	const parts = [];
	for (const att of msg?.attachments || []) {
		const name = (att.filename || "").toLowerCase();
		if (/\.(png|jpe?g|gif|webp)$/.test(name)) parts.push("", `![${att.filename}](${att.url})`);
		else if (/\.(txt|log|json)$/.test(name)) parts.push("", att);
		else parts.push("", `Attachment: ${att.filename} (${att.url})`);
	}
	return parts;
}

function foldFile(att, text) {
	return [`<details><summary>${att.filename}</summary>`, "", "```", text, "```", "", "</details>"].join("\n");
}

/**
 * Joins the body parts under BODY_MAX. The reporter's own words always go in whole; the text files
 * share whatever room is left, smallest first, so one huge log cannot crowd out a short one. Their
 * content is fetched now because a Discord attachment link expires a day after it was posted.
 */
async function fitBody(parts) {
	const files = parts.filter((p) => typeof p !== "string");
	const texts = new Map();
	for (const att of files) {
		let text = "(could not fetch — Discord CDN links expire)";
		try {
			const r = await fetch(att.url, { headers: { "User-Agent": UA } });
			if (r.ok) text = await r.text();
		} catch {
			/* expired link */
		}
		texts.set(att, text);
	}

	const fixed = parts.reduce((n, p) => n + 1 + (typeof p === "string" ? p.length : foldFile(p, "").length), 0);
	let room = Math.max(0, BODY_MAX - BODY_MARGIN - fixed);
	const clipped = new Map();
	const bySize = [...files].sort((a, b) => texts.get(a).length - texts.get(b).length);
	bySize.forEach((att, i) => {
		const text = texts.get(att);
		const share = Math.floor(room / (bySize.length - i));
		if (text.length <= share) {
			clipped.set(att, text);
		} else {
			const note = `\n… (truncated: ${text.length - share} more characters — the full file is on the Discord thread)`;
			clipped.set(att, text.slice(0, Math.max(0, share - note.length)) + note);
		}
		room -= clipped.get(att).length;
	});

	const body = parts.map((p) => (typeof p === "string" ? p : foldFile(p, clipped.get(p)))).join("\n");
	if (body.length <= BODY_MAX) return body;
	// Only reachable when the reporter's text alone overflows — dozens of long messages.
	const note = "\n\n_(truncated — the rest is on the Discord thread)_";
	return body.slice(0, BODY_MAX - note.length) + note;
}

/** Build the GitHub issue body from the Discord post and its author's follow-ups, verbatim. */
async function buildBody(thread, starter, followUps, tagNames, others, missing) {
	const author = starter?.author ? `${starter.author.username}` : "unknown";
	const tags = tagNames.length ? ` — tagged ${tagNames.map((t) => `\`${t}\``).join(", ")}` : "";
	const parts = [`**Reported on Discord** by \`${author}\` — forum post "${thread.name}"${tags}.`, ""];
	if (others.length) parts.push(`_Also filed for ${others.join(", ")}: the post carries their tag too._`, "");
	if (missing.length) parts.push(`_Missing: ${missing.join(", ")} — asked for on Discord._`, "");
	parts.push(starter?.content?.trim() ? starter.content : "_(no description)_");
	parts.push(...renderAttachments(starter));
	parts.push(...renderFollowUps(followUps, Date.parse(starter?.timestamp) || 0));
	return fitBody(parts);
}

/**
 * The reporter's later messages, verbatim. Messages written in one sitting read as one text; a rule
 * and a timestamp mark only a return to the thread later, so a paragraph-per-message post does not
 * turn into a wall of separators. `last` is the time of whatever the first message follows.
 */
function renderFollowUps(msgs, last) {
	const parts = [];
	for (const m of msgs) {
		const t = Date.parse(m.timestamp);
		if (t - last > FOLLOW_UP_GAP_MS) parts.push("", "---", "", `_Follow-up, ${utc(t)} UTC:_`);
		last = t;
		if (m.content?.trim()) parts.push("", m.content);
		parts.push(...renderAttachments(m));
	}
	return parts;
}

function utc(t) {
	return new Date(t).toISOString().slice(0, 16).replace("T", " ");
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
			const { names, kinds, mods } = threadTags(thread, tagsById);
			const kind = classify(kinds);
			const spec = KINDS[kind];
			const others = mods.filter((t) => !sameTag(t, MOD_TAG));
			// A post filed for several mods gets one reply, from the first of them, not one per repo.
			const replies = !mods.length || sameTag(mods[0], MOD_TAG);
			const msgs = await threadMessages(thread.id);
			const { starter, followUps } = reportMessages(thread, msgs);
			const missing = missingInfo(NEEDS[kind], [starter, ...followUps].filter(Boolean));
			const draft = {
				title: `[Discord] ${thread.name}`.slice(0, 250),
				body: await buildBody(thread, starter, followUps, names, others, missing),
				labels: [LABEL, ...spec.labels, ...(missing.length ? [NEEDS_INFO_LABEL.name] : [])],
			};
			if (DRY_RUN) {
				console.log(
					`[dry run] would file [${kind}] for thread ${thread.id}: ${draft.title}\n` +
						`labels: ${draft.labels.join(", ")} · ${followUps.length} follow-up(s) · body ${draft.body.length} chars · ` +
						`${replies ? "replies" : `no reply (${mods[0]} replies)`}\n` +
						`${"─".repeat(72)}\n${draft.body}\n${"─".repeat(72)}` +
						(replies ? `\nreply:\n${filedReply(kind, missing)}\n${"─".repeat(72)}` : ""),
				);
				filed++;
				continue;
			}
			if (missing.length) await ensureNeedsInfoLabel();
			const issue = await github(`/repos/${REPO}/issues`, draft);
			console.log(
				`Filed #${issue.number} [${kind}] for thread ${thread.id} ("${thread.name}"), ${followUps.length} follow-up(s)` +
					(missing.length ? `, missing ${missing.join(", ")}` : ""),
			);
			// Everything read now is in the body; forwardFollowUps takes it from the next message on.
			state.tracked[thread.id] = { issue: issue.number, kind, lastMsg: msgs.reduce((max, m) => maxId(max, m.id), thread.id) };
			if (others.length) state.tracked[thread.id].others = others;
			if (missing.length) state.tracked[thread.id].missing = missing;
			creditReporter(reporters, starter?.author, kind);
			// Reply in the thread — NEVER link the private code repo.
			if (replies) {
				try {
					await discordPost(`/channels/${thread.id}/messages`, { content: filedReply(kind, missing) });
				} catch (e) {
					console.warn("reply failed:", e.message);
				}
			}
			if (missing.length) await tagNeedsInfo(thread.id, true);
			seen.add(thread.id);
			filed++;
		} catch (e) {
			if (e.fatal) throw e;
			degrade(`thread ${thread.id} not filed`, e);
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
		const kind = classify(threadTags(thread, tagsById).kinds);
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
		if (e.fatal) throw e;
		degrade("backfill", e);
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
		let kind = classify(threadTags(thread, tagsById).kinds);
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

// ── Test posts ──────────────────────────────────────────────────────────────
// The pipeline is tested by having the bot open a post in a real forum, and a test must not outlive
// its check: an archived "[TEST]" thread sits in front of every reporter, and its issue in the mod's
// tracker. A thread the bot itself opened is a test; closing its issue (any reason) means the check
// is over, and the next run deletes the thread and then the issue. Each step is retried until it
// lands — a missing permission shows as a warning on every run instead of a test left behind.
// Needs Manage Threads on the forum and a GH_TOKEN allowed to delete issues (repo admin).

let bot;
const botUser = async () => (bot ??= await discord("/users/@me"));

/** Mark the tracked threads the bot opened itself. Another bot's posts are not ours to delete. */
async function markTests(state, threads) {
	if (!threads.some((t) => state.tracked[t.id])) return;
	let me;
	try {
		me = await botUser();
	} catch (e) {
		if (e.fatal) throw e;
		console.warn("bot identity:", e.message);
		return;
	}
	for (const t of threads) {
		const entry = state.tracked[t.id];
		if (entry && t.owner_id === me.id) entry.test = true;
	}
}

async function cleanUpTests(state) {
	const tests = Object.entries(state.tracked).filter(([, v]) => v && v.test && v.issue);
	if (!tests.length) return 0;
	let closed;
	try {
		closed = await githubGet(`/repos/${REPO}/issues?state=closed&per_page=100&sort=updated&direction=desc`);
	} catch (e) {
		if (e.fatal) throw e;
		degrade("closed issues (tests)", e);
		return 0;
	}
	const byNumber = new Map(closed.filter((i) => !i.pull_request).map((i) => [i.number, i]));

	let cleaned = 0;
	for (const [threadId, entry] of tests) {
		const issue = byNumber.get(entry.issue);
		if (!issue) continue; // still open: the check is not over
		try {
			// Thread first: an issue deleted under a thread that stays would leave nothing to retry from.
			await discordDelete(`/channels/${threadId}`);
			const res = await github("/graphql", {
				query: "mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }",
				variables: { id: issue.node_id },
			});
			if (res.errors?.length) throw new Error(`GitHub deleteIssue #${entry.issue}: ${res.errors.map((x) => x.message).join("; ")}`);
			delete state.tracked[threadId];
			cleaned++;
			console.log(`Deleted test thread ${threadId} and its issue #${entry.issue}`);
		} catch (e) {
			console.log(`::warning::test thread ${threadId} (#${entry.issue}) not deleted: ${e.message}`);
		}
	}
	return cleaned;
}

// ── Follow-ups ──────────────────────────────────────────────────────────────
// What the reporter writes after the import — usually the log the bot asked for, sometimes "it came
// back" after a close — goes to the issue as ONE comment per thread per run. `lastMsg` is the newest
// message already handled; an entry from before it existed starts at the starter, so its first pass
// posts every follow-up it holds (none of those reached a body: they predate the folding).
//
// A quiet run costs no call: the thread listing already carries each thread's last_message_id, and
// only a thread past its cursor is read. A thread missing from the listing has nothing new — a reply
// in an archived thread unarchives it, which puts it back in the active list.

// The poller's own replies. In a normal thread the owner filter already drops them; in a test thread
// the bot IS the owner, and they are what would otherwise come back as a "follow-up".
// Each filing reply in every variant of its request: a reply is matched by its ending.
const OWN_REPLIES = new Set([
	...Object.entries(KINDS).flatMap(([kind, k]) => [...allAsks(NEEDS[kind] || []).map((ask) => k.filed + ask), k.fixed]),
	NOT_PLANNED,
	ASK_FOR_MOD_TAG,
]);

// endsWith/includes: in a post filed for several mods they carry the mod's name in front (say).
const isOwnReply = (m) => [...OWN_REPLIES].some((r) => m.content?.endsWith(r)) || Boolean(m.content?.includes(RELEASE_PREFIX));

function isReporterFollowUp(thread, m) {
	if (m.author?.id !== thread.owner_id) return false;
	if (AUTHOR_USERNAMES.includes((m.author.username || "").toLowerCase())) return false;
	if (isOwnReply(m)) return false;
	return Boolean(m.content?.trim() || m.attachments?.length);
}

async function forwardFollowUps(state, threads) {
	let posted = 0;
	for (const thread of threads) {
		const entry = state.tracked[thread.id];
		if (!entry?.issue) continue;
		const cursor = entry.lastMsg || thread.id;
		if (!thread.last_message_id || BigInt(thread.last_message_id) <= BigInt(cursor)) continue;
		try {
			const issue = await githubGet(`/repos/${REPO}/issues/${entry.issue}`);
			const closedDays = issue.state === "closed" ? (Date.now() - Date.parse(issue.closed_at)) / 86400000 : 0;
			if (closedDays > FOLLOWUP_DAYS_AFTER_CLOSE) {
				// Skipped, not queued: reading it later would only bury it under whatever came after.
				console.log(`Thread ${thread.id}: #${entry.issue} closed ${Math.floor(closedDays)} days ago, follow-ups skipped`);
				if (!DRY_RUN) entry.lastMsg = thread.last_message_id;
				continue;
			}
			const msgs = await threadMessages(thread.id, cursor);
			if (!msgs.length) continue;
			const newest = msgs.reduce((max, m) => maxId(max, m.id), cursor);
			const followUps = msgs.filter((m) => isReporterFollowUp(thread, m));
			if (!followUps.length) {
				if (!DRY_RUN) entry.lastMsg = newest;
				continue;
			}
			const first = Date.parse(followUps[0].timestamp);
			const who = followUps[0].author?.username || "unknown";
			const still = entry.missing?.length ? missingInfo(entry.missing, followUps) : null;
			const arrived = still ? entry.missing.filter((f) => !still.includes(f)) : [];
			// A comment never reopens: the issue stays as the author left it.
			const body = await fitBody([
				`**Follow-up on Discord** by \`${who}\`, ${utc(first)} UTC:`,
				...(arrived.length ? ["", arrivedLine(arrived, still)] : []),
				...renderFollowUps(followUps, first),
			]);
			if (DRY_RUN) {
				console.log(
					`[dry run] would comment on #${entry.issue} (${issue.state}) for thread ${thread.id}: ` +
						`${followUps.length} message(s) · body ${body.length} chars\n${"─".repeat(72)}\n${body}\n${"─".repeat(72)}`,
				);
				posted++;
				continue;
			}
			await github(`/repos/${REPO}/issues/${entry.issue}/comments`, { body });
			// Only now: a comment that did not go through is retried from the same cursor next run.
			entry.lastMsg = newest;
			// An empty list is not dropped here: it is what clearAnswered takes the label off.
			if (arrived.length) entry.missing = still;
			posted++;
			console.log(`Commented ${followUps.length} follow-up(s) on #${entry.issue} (${issue.state}) from thread ${thread.id}`);
		} catch (e) {
			if (e.fatal) throw e;
			degrade(`follow-ups for thread ${thread.id} (#${entry.issue})`, e);
		}
	}
	return posted;
}

/** The line a follow-up comment opens with when it supplies a missing piece. */
function arrivedLine(arrived, still) {
	return (
		`**Needs info** · arrived: ${arrived.join(", ")}. ` +
		(still.length ? `Still missing: ${still.join(", ")}.` : `Nothing missing: \`${NEEDS_INFO_LABEL.name}\` removed.`)
	);
}

// ── Needs info ──────────────────────────────────────────────────────────────
// A bug or crash report missing a piece gets the needs-info label on its issue and the Needs info tag
// on its post (#10). Both come off once every piece has arrived, and never by a timer: an issue that
// stays incomplete stays open, labelled, until the author decides.

let labelReady;
/** Creates the label the first time this run needs it; 422 is "already there". GitHub would create a bare one anyway. */
function ensureNeedsInfoLabel() {
	return (labelReady ??= github(`/repos/${REPO}/labels`, NEEDS_INFO_LABEL).catch((e) => {
		if (e.fatal) throw e;
		if (!/ -> 422 /.test(e.message)) console.warn(`${NEEDS_INFO_LABEL.name} label:`, e.message);
	}));
}

let statusIdsOnce;
/** statusTagIds, read once per run; null when there is no shared forum or it could not be read. */
function statusIds() {
	return (statusIdsOnce ??= statusTagIds().catch((e) => {
		if (e.fatal) throw e;
		degrade("status tags", e);
		return null;
	}));
}

/**
 * Puts the Needs info tag on a post of the shared forum, or takes it off. Best effort, like the reply:
 * the issue label is the record, and a post already carrying Discord's five tags goes without.
 */
async function tagNeedsInfo(threadId, on) {
	const id = (await statusIds())?.get(NEEDS_INFO_TAG.toLowerCase());
	if (!id) return;
	try {
		const thread = await discord(`/channels/${threadId}`);
		if (thread.parent_id !== SHARED_FORUM) return;
		const applied = thread.applied_tags || [];
		if (applied.includes(id) === on) return;
		if (on && applied.length >= MAX_APPLIED_TAGS) {
			console.log(`Thread ${threadId} already has ${applied.length} tags: no "${NEEDS_INFO_TAG}"`);
			return;
		}
		await discordPatch(`/channels/${threadId}`, { applied_tags: on ? [...applied, id] : applied.filter((t) => t !== id) });
	} catch (e) {
		if (e.fatal) throw e;
		console.warn(`"${NEEDS_INFO_TAG}" on thread ${threadId}:`, e.message);
	}
}

/** Takes needs-info off the reports whose last missing piece arrived. Retried each run until the label is gone. */
async function clearAnswered(state) {
	let cleared = 0;
	for (const [threadId, entry] of Object.entries(state.tracked)) {
		if (!entry?.issue || !Array.isArray(entry.missing) || entry.missing.length) continue;
		try {
			await githubDelete(`/repos/${REPO}/issues/${entry.issue}/labels/${NEEDS_INFO_LABEL.name}`);
			await tagNeedsInfo(threadId, false);
			delete entry.missing;
			cleared++;
			console.log(`Cleared ${NEEDS_INFO_LABEL.name} on #${entry.issue} (thread ${threadId})`);
		} catch (e) {
			if (e.fatal) throw e;
			degrade(`${NEEDS_INFO_LABEL.name} off #${entry.issue}`, e);
		}
	}
	return cleared;
}

/** Post back to the thread when its issue gets closed, once. */
async function announceClosed(state) {
	// A test thread is deleted instead: telling it "closed" first would only be one more message to delete.
	const pending = Object.entries(state.tracked).filter(([, v]) => v && v.issue && !v.closedAnnounced && !v.test);
	if (!pending.length) return 0;

	// One list call instead of one GET per tracked issue: the crons run every 10 minutes and this is
	// the only place that touches GitHub on a quiet run.
	let closed;
	try {
		closed = await githubGet(`/repos/${REPO}/issues?state=closed&per_page=100&sort=updated&direction=desc`);
	} catch (e) {
		if (e.fatal) throw e;
		degrade("closed issues", e);
		return 0;
	}
	const byNumber = new Map(closed.filter((i) => !i.pull_request).map((i) => [i.number, i]));

	let announced = 0;
	for (const [threadId, entry] of pending) {
		const issue = byNumber.get(entry.issue);
		if (!issue) continue;
		const spec = KINDS[entry.kind] || KINDS.other;
		entry.closedAs = issue.state_reason === "not_planned" ? "not_planned" : "completed";
		const text = say(entry, entry.closedAs === "not_planned" ? NOT_PLANNED : spec.fixed);
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

// ── Archive ─────────────────────────────────────────────────────────────────
// The close message is what puts a resolved thread back in the forum's open list: posting into a
// thread Discord had auto-archived unarchives it. So once the close is announced the thread is
// archived — not locked: the forum search still finds it, and a reporter who replies "it came back"
// unarchives it, which forwardFollowUps then picks up.
//
// Once per entry. A thread the reporter reopens by replying stays visible; hiding it again on the
// next run would bury exactly the message the author has to read.
// The one exception is the release message: the bot unarchived it, so the bot archives it back.

const THREAD_ALREADY_ARCHIVED = 50083; // a PATCH on an archived thread may only unarchive it
const UNKNOWN_CHANNEL = 10003;

/**
 * A multi-mod post gets its status when its LAST mod closes: until then, Resolved would sit on a post
 * with work still open. Every mod's close reply is read from the thread — the other rows' state is
 * not ours to read — and each row posts its own before it gets here, so of two closing at once, at
 * least the later one sees both. Any fix makes it Resolved; only all-not-planned is Not planned.
 */
async function postStatus(threadId, entry) {
	if (!entry.others?.length) return CLOSED_STATUS[entry.closedAs];
	const closes = new Map([[MOD_TAG.toLowerCase(), entry.closedAs]]);
	const me = await botUser();
	for (const m of await threadMessages(threadId)) {
		const reply = m.author?.id === me.id && /^\*\*(.+?)\*\* · ([\s\S]*)$/.exec(m.content || "");
		const how = reply && CLOSE_TEXTS.get(reply[2]);
		if (how && closes.get(reply[1].toLowerCase()) !== "completed") closes.set(reply[1].toLowerCase(), how);
	}
	const open = entry.others.filter((t) => !closes.has(t.toLowerCase()));
	if (open.length) {
		console.log(`Thread ${threadId} (#${entry.issue}): no status yet, ${open.join(", ")} still open`);
		return null;
	}
	return CLOSED_STATUS[[...closes.values()].includes("completed") ? "completed" : "not_planned"];
}

/**
 * The tags to archive the post with — its own, minus any older status, plus the close status — and
 * that status. Null
 * when it gets none — not in the shared forum, closed before #30, still open for another mod, or it
 * already carries Discord's five (the reporter's tags win: the close reply says the same thing).
 */
async function closedTags(threadId, entry, statusIds) {
	if (!statusIds || !entry.closedAs) return null;
	const thread = await discord(`/channels/${threadId}`);
	if (thread.parent_id !== SHARED_FORUM) return null;
	const status = await postStatus(threadId, entry);
	const id = status && statusIds.get(status.toLowerCase());
	if (!id) return null;
	const applied = thread.applied_tags || [];
	const kept = applied.filter((t) => ![...statusIds.values()].includes(t));
	if (kept.length === applied.length - 1 && applied.includes(id)) return null; // already just that
	if (kept.length >= MAX_APPLIED_TAGS) {
		console.log(`Thread ${threadId} (#${entry.issue}) already has ${kept.length} tags: archived without "${status}"`);
		return null;
	}
	return { tags: [...kept, id], status };
}

/** The shared forum's status tag ids by lowercased name, or null when there is no shared forum to tag. */
async function statusTagIds() {
	if (!SHARED_FORUM) return null;
	const forum = await discord(`/channels/${SHARED_FORUM}`);
	const ids = new Map();
	for (const t of forum.available_tags || []) if (STATUS_TAGS.some((s) => sameTag(s, t.name))) ids.set(t.name.toLowerCase(), t.id);
	for (const s of Object.values(CLOSED_STATUS)) {
		if (!ids.has(s.toLowerCase())) degrade("shared forum", new Error(`it has no "${s}" tag, so no closed post gets it`));
	}
	return ids;
}

async function archiveClosed(state) {
	const pending = Object.entries(state.tracked).filter(([, v]) => v && v.issue && v.closedAnnounced && !v.archived && !v.test);
	if (!pending.length) return 0;
	const ids = await statusIds();
	let archived = 0;
	for (const [threadId, entry] of pending) {
		try {
			// One PATCH: an archived thread refuses every edit but unarchiving, and the close reply has
			// just unarchived this one.
			const tagged = await closedTags(threadId, entry, ids);
			await discordPatch(`/channels/${threadId}`, { archived: true, ...(tagged ? { applied_tags: tagged.tags } : {}) });
			archived++;
			console.log(`Archived thread ${threadId} (#${entry.issue})${tagged ? ` tagged ${tagged.status}` : ""}`);
		} catch (e) {
			if (e.code === THREAD_ALREADY_ARCHIVED || e.code === UNKNOWN_CHANNEL) {
				console.log(`Thread ${threadId} (#${entry.issue}) already archived or gone`);
			} else {
				// Same give-up as the close reply: a thread that refuses three times is not retried forever.
				entry.archiveAttempts = (entry.archiveAttempts || 0) + 1;
				degrade(`archive thread ${threadId} (#${entry.issue}), attempt ${entry.archiveAttempts}`, e);
				if (entry.archiveAttempts < 3) continue;
			}
		}
		entry.archived = true;
	}
	return archived;
}

async function main() {
	if (ONLY_THREAD && !DRY_RUN) {
		console.error("ONLY_THREAD needs DRY_RUN=1: it ignores the dedup state and would file the thread again.");
		process.exit(1);
	}
	const state = loadState();
	const seen = new Set(ONLY_THREAD ? [] : state.processed);
	const reporters = loadReporters();
	const tagsById = await forumTagNames();
	const threads = ONLY_THREAD ? [await discord(`/channels/${ONLY_THREAD}`)] : await forumThreads(modTagId(tagsById));

	const filed = await fileNewThreads(state, seen, tagsById, reporters, threads);
	const releaseDeps = { repo: REPO, dryRun: DRY_RUN, githubGet, discord, discordPost, degrade, say };
	if (DRY_RUN) {
		const comments = await forwardFollowUps(state, threads);
		const released = ONLY_THREAD ? 0 : await announceReleases(state, releaseDeps);
		console.log(
			`Dry run. ${filed} issue(s) would be filed, ${comments} follow-up comment(s) and ${released} release message(s) posted; nothing was posted or written.`,
		);
		return;
	}
	await backfillTracked(state, threads, tagsById);
	await markTests(state, threads);
	const comments = await forwardFollowUps(state, threads);
	const answered = await clearAnswered(state);
	const announced = await announceClosed(state);
	// After the close reply, so a fix committed and released between two runs reads in order; before
	// archiveClosed, which archives again the threads the release message unarchived.
	const released = await announceReleases(state, releaseDeps);
	const archived = await archiveClosed(state);
	const cleaned = await cleanUpTests(state);
	const granted = await grantReporterRoles(reporters);

	state.processed = [...seen].slice(-1000); // cap the dedup list
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	if (filed || granted) writeFileSync(REPORTERS_FILE, JSON.stringify(reporters, null, 2) + "\n");
	const tests = cleaned ? ` ${cleaned} test post(s) deleted;` : "";
	const cleared = answered ? ` ${answered} needs-info cleared;` : "";
	const roles = granted ? ` ${granted} ${REPORTER_ROLE} outcome(s) recorded;` : "";
	console.log(`Done. ${filed} new issue(s) filed; ${comments} follow-up comment(s);${cleared} ${announced} close(s) announced; ${released} release message(s); ${archived} thread(s) archived;${tests}${roles} ${seen.size} threads tracked.`);
}

main()
	.then(() => {
		if (!degraded.length) return;
		const summary = process.env.GITHUB_STEP_SUMMARY;
		const lines = [`**Degraded run** — ${degraded.length} part(s) of the job did not happen:`, "", ...degraded.map((d) => `- ${d}`), ""];
		if (summary) writeFileSync(summary, lines.join("\n"), { flag: "a" });
		console.error(`Degraded: ${degraded.length} failure(s); see the ::error:: lines above.`);
		process.exitCode = 1;
	})
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
