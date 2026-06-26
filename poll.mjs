// Discord → GitHub Issues intake poller for Cobblemon Routes.
//
// Polls a Discord FORUM channel (the #bug-reports forum) over the REST API — no gateway/websocket, so it
// runs fine as a GitHub Actions cron. Each NEW forum post (thread) becomes a GitHub issue in the code repo;
// the bot then replies "tracked" in the thread (never linking the private repo). Already-seen threads are
// remembered in state.json so nothing is filed twice.
//
// Required env:
//   DISCORD_BOT_TOKEN        bot token (needs the Message Content privileged intent + access to the forum)
//   DISCORD_FORUM_CHANNEL_ID id of the bug-reports forum channel
//   GH_TOKEN                 a PAT with `repo` scope on the issues repo (a fine-grained token works too)
//   GH_ISSUES_REPO           "owner/repo" to file issues into (e.g. the private code repo)
// Optional:
//   DISCORD_GUILD_ID         guild id (speeds up the active-threads lookup; otherwise derived per thread)
//   ISSUE_LABEL              label to add to filed issues (default "discord")
//   STATE_FILE               path to the dedup state (default ./state.json)

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const D = "https://discord.com/api/v10";
const GH = "https://api.github.com";
const UA = "cobblemon-routes-intake (+https://modrinth.com/project/cobblemon-routes)";

const TOKEN = req("DISCORD_BOT_TOKEN");
const FORUM = req("DISCORD_FORUM_CHANNEL_ID");
const GH_TOKEN = req("GH_TOKEN");
const REPO = req("GH_ISSUES_REPO");
const GUILD = process.env.DISCORD_GUILD_ID || "";
const LABEL = process.env.ISSUE_LABEL || "discord";
const STATE_FILE = process.env.STATE_FILE || "state.json";

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
		throw new Error(`Discord ${path} -> ${res.status} ${await res.text()}`);
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

function loadState() {
	if (existsSync(STATE_FILE)) {
		try {
			return JSON.parse(readFileSync(STATE_FILE, "utf8"));
		} catch {
			/* corrupt — start fresh */
		}
	}
	return { processed: [] };
}

/** All forum posts (threads) under the bug-reports forum: active + recently archived. */
async function forumThreads() {
	const threads = new Map();
	// Active threads (guild-wide if we have the id, else the channel's own active set isn't exposed by REST,
	// so the guild lookup is preferred). Both shapes return { threads: [...] }.
	try {
		const active = GUILD ? await discord(`/guilds/${GUILD}/threads/active`) : { threads: [] };
		for (const t of active.threads || []) {
			if (t.parent_id === FORUM) threads.set(t.id, t);
		}
	} catch (e) {
		console.warn("active threads:", e.message);
	}
	// Recently archived public threads under the forum (catches posts closed between runs).
	try {
		const archived = await discord(`/channels/${FORUM}/threads/archived/public?limit=25`);
		for (const t of archived.threads || []) threads.set(t.id, t);
	} catch (e) {
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
async function buildBody(thread, msg) {
	const author = msg?.author ? `${msg.author.username}` : "unknown";
	const lines = [];
	lines.push(`**Reported on Discord** by \`${author}\` — forum post "${thread.name}".`);
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

async function main() {
	const state = loadState();
	const seen = new Set(state.processed);
	const threads = await forumThreads();
	let filed = 0;
	for (const thread of threads) {
		if (seen.has(thread.id)) continue;
		try {
			const msg = await starterMessage(thread.id);
			const issue = await github(`/repos/${REPO}/issues`, {
				title: `[Discord] ${thread.name}`.slice(0, 250),
				body: await buildBody(thread, msg),
				labels: [LABEL],
			});
			console.log(`Filed #${issue.number} for thread ${thread.id} ("${thread.name}")`);
			// Reply in the thread — NEVER link the private code repo.
			try {
				await discordPost(`/channels/${thread.id}/messages`, {
					content: "🔍 Thanks for the report — we're **investigating** it. We'll post here when it's fixed in a release. "
						+ "If you can, attach your **crash report** (`crash-reports/crash-*.txt`) — it has the stack trace we need.",
				});
			} catch (e) {
				console.warn("reply failed:", e.message);
			}
			seen.add(thread.id);
			filed++;
		} catch (e) {
			console.error(`thread ${thread.id} failed:`, e.message);
		}
	}
	state.processed = [...seen].slice(-1000); // cap the dedup list
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	console.log(`Done. ${filed} new issue(s) filed; ${seen.size} threads tracked.`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
