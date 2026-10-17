// GitHub -> Discord: a comment on the issue that starts with `/reply` goes to the reporter's thread
// (#11). Every mod repo is private, so the thread is the only way back to the person who reported: a
// question the author asks on the issue ("which seed?") never reaches them otherwise. Only marked
// comments travel; the rest of the issue — notes, links into the private repo — stays internal.
//
// One read per run: the repo-wide comment list since state.repliesSince, matched to the tracked
// threads by issue number. A comment is relayed when it starts with `/reply`, its author has write
// access (OWNER / MEMBER / COLLABORATOR — a reader cannot speak for the mod), and its issue is open
// or closed within the follow-up window. The prefix is stripped and the thread owner is pinged: a
// forum post's creator often follows it on "mentions only", and a question nobody sees is not asked.
// Once Discord took every part of it, the comment gets a 🚀 and entry.lastReply moves to it.
//
// Loop safety. Filtering by GitHub login does not work — the poller comments with the author's own
// PAT. The rule is the prefix: the follow-up comments the poller writes (#5) never start with
// `/reply`, and carry FROM_DISCORD, which is skipped explicitly. The other way round, REPLY_HEADER is
// one of the poller's own replies (isOwnReply), so a relayed message never comes back as a follow-up
// in a thread the bot owns.
//
// An empty repliesSince records now and relays nothing: no comment from before this existed is sent
// late. It moves to this run's start only when no comment failed; a failed one is read again next
// run, and lastReply keeps the ones already relayed from going twice.

export const FROM_DISCORD = "<!-- intake:from-discord -->";
export const REPLY_HEADER = `💬 **${process.env.REPLY_NAME || "shiero"}:** `;

const PREFIX = /^\/reply(?:[ \t]+|\r?\n|$)/;
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ROCKET = "rocket";
const MESSAGE_MAX = 2000; // Discord's cap on `content`
const PAGE = 100;
const MAX_PAGES = 10;
const SINCE_MARGIN_MS = 60 * 1000; // clock skew between the runner and GitHub
const ATTEMPTS = 3;

/** The text to relay, or null when the comment is not marked. */
export function replyText(body) {
	if (!body || body.includes(FROM_DISCORD)) return null;
	const text = body.replace(/\r\n/g, "\n").trimStart();
	const m = PREFIX.exec(text);
	return m ? text.slice(m[0].length).trim() : null;
}

/** Splits text into parts of at most `size`, at a line break or a space when there is one. */
export function chunks(text, size) {
	const parts = [];
	let rest = text;
	while (rest.length > size) {
		let cut = rest.lastIndexOf("\n", size);
		if (cut < size / 2) cut = rest.lastIndexOf(" ", size);
		if (cut <= 0) cut = size;
		parts.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).replace(/^[ \n]+/, "");
	}
	if (rest) parts.push(rest);
	return parts;
}

/**
 * deps: { repo, dryRun, windowDays, githubGet, github, discord, discordPost, botUser, degrade, say }.
 * Returns how many comments were relayed (or, in a dry run, would be).
 */
export async function relayReplies(state, deps) {
	const { repo, dryRun, windowDays, githubGet, github, discord, discordPost, botUser, degrade, say = (_, t) => t } = deps;
	const started = new Date(Date.now() - SINCE_MARGIN_MS).toISOString();
	if (!state.repliesSince) {
		console.log(`Replies: first run, relaying comments from ${started} on`);
		if (!dryRun) state.repliesSince = started;
		return 0;
	}

	const byIssue = new Map();
	for (const [threadId, entry] of Object.entries(state.tracked)) {
		if (entry?.issue) byIssue.set(entry.issue, [...(byIssue.get(entry.issue) || []), [threadId, entry]]);
	}

	let comments = [];
	try {
		for (let page = 1; page <= MAX_PAGES; page++) {
			const since = encodeURIComponent(state.repliesSince);
			const batch = await githubGet(`/repos/${repo}/issues/comments?since=${since}&sort=created&direction=asc&per_page=${PAGE}&page=${page}`);
			comments.push(...batch);
			if (batch.length < PAGE) break;
		}
	} catch (e) {
		if (e.fatal) throw e;
		degrade("issue comments", e);
		return 0;
	}

	// Marked, by a writer, on a tracked issue — oldest first, so lastReply only ever moves forward.
	const marked = comments
		.map((c) => ({ c, text: replyText(c.body), issue: Number(c.issue_url?.split("/").pop()) }))
		.filter(({ c, text, issue }) => text !== null && WRITERS.has(c.author_association) && byIssue.has(issue))
		.sort((a, b) => a.c.id - b.c.id);

	let relayed = 0;
	let failed = false;
	const issues = new Map();
	const stuck = new Set();
	for (const { c, text, issue } of marked) {
		for (const [threadId, entry] of byIssue.get(issue)) {
			if (stuck.has(threadId) || c.id <= (entry.lastReply || 0)) continue;
			try {
				if (!issues.has(issue)) issues.set(issue, await githubGet(`/repos/${repo}/issues/${issue}`));
				const info = issues.get(issue);
				const closedDays = info.state === "closed" ? (Date.now() - Date.parse(info.closed_at)) / 86400000 : 0;
				if (closedDays > windowDays) {
					console.log(`#${issue}: closed ${Math.floor(closedDays)} days ago, /reply ${c.id} not relayed`);
					if (!dryRun) entry.lastReply = c.id;
					continue;
				}
				if (!text) {
					if (!dryRun) entry.lastReply = c.id;
					continue;
				}
				const thread = await discord(`/channels/${threadId}`);
				const me = await botUser();
				const ping = thread.owner_id && thread.owner_id !== me.id ? thread.owner_id : null;
				const lead = say(entry, REPLY_HEADER);
				const parts = chunks(text, MESSAGE_MAX - lead.length - (ping ? ping.length + 4 : 0));
				const messages = parts.map((part, i) => ({
					content: (i === 0 && ping ? `<@${ping}> ` : "") + lead + part,
					allowed_mentions: { parse: [], users: i === 0 && ping ? [ping] : [] },
				}));
				if (dryRun) {
					console.log(`[dry run] would relay comment ${c.id} on #${issue} to thread ${threadId} in ${messages.length} message(s):`);
					for (const m of messages) console.log(m.content);
					relayed++;
					continue;
				}
				for (const m of messages) await discordPost(`/channels/${threadId}/messages`, m);
				entry.lastReply = c.id;
				delete entry.replyAttempts;
				// The message unarchived the thread; one archiveClosed had closed goes back to it.
				if (thread.thread_metadata?.archived && entry.closedAnnounced) entry.archived = false;
				relayed++;
				console.log(`Relayed /reply ${c.id} on #${issue} to thread ${threadId} (${messages.length} message(s))`);
				try {
					await github(`/repos/${repo}/issues/comments/${c.id}/reactions`, { content: ROCKET });
				} catch (e) {
					if (e.fatal) throw e;
					degrade(`🚀 on comment ${c.id} (#${issue})`, e);
				}
			} catch (e) {
				if (e.fatal) throw e;
				// Same give-up as the close reply: a thread that refuses three times is not retried forever.
				const attempt = (entry.replyAttempts || 0) + 1;
				if (attempt >= ATTEMPTS) {
					entry.lastReply = c.id;
					delete entry.replyAttempts;
				} else {
					entry.replyAttempts = attempt;
					failed = true;
				}
				stuck.add(threadId); // a later comment must not overtake this one
				degrade(`/reply ${c.id} on #${issue} to thread ${threadId}, attempt ${attempt} of ${ATTEMPTS}`, e);
			}
		}
	}
	if (!dryRun && !failed) state.repliesSince = started;
	return relayed;
}
