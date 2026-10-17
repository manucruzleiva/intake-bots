// Release follow-up: tell each reporter, in their own thread, the day the release carrying their fix
// is out. The close message says "ships in the next release" — an issue closes when its fix is
// committed — and releases stack for weeks, so without this the reporter never learns when to update.
//
// What counts as "carrying the fix" is the same thing the publish workflows use to close tickets: the
// `#N` refs in the top section of CHANGELOG.md, read AT the release's tag. Drafts are skipped;
// prereleases are not — a beta is still a build the reporter can install, and `/releases/latest`
// would never see one.
//
// state.lastRelease is the newest tag already handled. Releases after it are handled oldest first,
// and the tag only moves once every post for that release went through or ran out of attempts. An
// empty lastRelease records the newest tag and posts nothing: old releases are not announced late.
//
// The post unarchives the thread. If it was archived before, entry.archived goes back to false and
// archiveClosed archives it again later in the same run; a thread the reporter had reopened by
// replying was not archived, and stays visible.
//
// A crash or bug post's message also carries the satisfaction poll (lib/survey.mjs): one message, so
// the poll goes out exactly when the release line does and shares its retry and give-up.

import { SURVEY_KINDS, surveyPoll } from "./survey.mjs";
import { speak, releaseLine } from "./voice.mjs";

/** The top non-Unreleased section, by the publish workflows' awk rule: its version and its body. */
export function topSection(changelog) {
	const lines = changelog.split(/\r?\n/);
	let version = null;
	const body = [];
	for (const line of lines) {
		if (line.startsWith("## [")) {
			if (version) break;
			if (/Unreleased/.test(line)) continue;
			version = line.match(/^## \[([^\]]+)\]/)?.[1] ?? null;
			continue;
		}
		if (version) body.push(line);
	}
	return version ? { version, body: body.join("\n") } : null;
}

/** Bare `#N` refs. `owner/repo#N` points at another repo and is left out. */
export function issueRefs(text) {
	return new Set([...text.matchAll(/(?<![\w/])#(\d+)\b/g)].map((m) => Number(m[1])));
}

/**
 * deps: { repo, dryRun, githubGet, discord, discordPost, degrade, say, modTag }. `say(entry, text)` is what
 * the thread gets: in a post filed for several mods it names the mod, and so does the poll, by `modTag`.
 * Returns how many threads were told (or, in a dry run, would be).
 */
export async function announceReleases(state, deps) {
	const { repo, dryRun, githubGet, discord, discordPost, degrade, say = (_, t) => t, modTag = "" } = deps;
	let releases;
	try {
		releases = (await githubGet(`/repos/${repo}/releases?per_page=20`)).filter((r) => !r.draft);
	} catch (e) {
		if (e.fatal) throw e;
		degrade("releases", e);
		return 0;
	}
	if (!releases.length) return 0;
	// The API lists newest first; created_at orders them even when one is published late.
	releases.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

	if (!state.lastRelease) {
		const newest = releases[releases.length - 1].tag_name;
		console.log(`Releases: first run, recording ${newest} without announcing it`);
		if (!dryRun) state.lastRelease = newest;
		return 0;
	}
	const seenAt = releases.findIndex((r) => r.tag_name === state.lastRelease);
	// A lastRelease no longer in the window (deleted, or 20+ releases ago) means everything listed is
	// newer — but announcing up to 20 old releases at once is worse than skipping them.
	if (seenAt < 0) {
		const newest = releases[releases.length - 1].tag_name;
		console.log(`Releases: ${state.lastRelease} not among the last 20, moving to ${newest} without announcing`);
		if (!dryRun) state.lastRelease = newest;
		return 0;
	}

	let told = 0;
	for (const release of releases.slice(seenAt + 1)) {
		const result = await announceOne(release);
		told += result.told;
		if (!result.done) break; // retried next run from this same release
		if (!dryRun) state.lastRelease = release.tag_name;
	}
	return told;

	async function announceOne(release) {
		const tag = release.tag_name;
		let section;
		try {
			const file = await githubGet(`/repos/${repo}/contents/CHANGELOG.md?ref=${encodeURIComponent(tag)}`);
			section = topSection(Buffer.from(file.content, "base64").toString("utf8"));
		} catch (e) {
			if (e.fatal) throw e;
			degrade(`CHANGELOG.md at ${tag}`, e);
			return { told: 0, done: false };
		}
		if (!section) {
			console.log(`Release ${tag}: no versioned section in CHANGELOG.md, nothing to announce`);
			return { told: 0, done: true };
		}
		const refs = issueRefs(section.body);
		const pending = Object.entries(state.tracked).filter(
			([, v]) => v && v.issue && refs.has(v.issue) && !v.releaseAnnounced && !v.test,
		);
		let told = 0;
		let done = true;
		for (const [threadId, entry] of pending) {
			// Rotated per thread (lib/voice.mjs): two reporters of one release read two different lines.
			const text = releaseLine(speak(state, "release"), section.version);
			const poll = SURVEY_KINDS.has(entry.kind) ? surveyPoll(section.version, entry.others?.length ? modTag : "") : null;
			if (dryRun) {
				console.log(`[dry run] would post in thread ${threadId} (#${entry.issue}): ${say(entry, text)}${poll ? ` + poll "${poll.question.text}"` : ""}`);
				told++;
				continue;
			}
			try {
				const thread = await discord(`/channels/${threadId}`);
				const message = await discordPost(`/channels/${threadId}/messages`, { content: say(entry, text), ...(poll ? { poll } : {}) });
				entry.releaseAnnounced = tag;
				if (poll) entry.survey = { message: message.id, version: section.version, owner: thread.owner_id };
				if (thread.thread_metadata?.archived) entry.archived = false;
				told++;
				console.log(`Announced ${tag} in thread ${threadId} (#${entry.issue})`);
			} catch (e) {
				if (e.fatal) throw e;
				// Same give-up as the close reply: a thread that refuses three times is not retried forever.
				entry.releaseAttempts = (entry.releaseAttempts || 0) + 1;
				if (entry.releaseAttempts >= 3) entry.releaseAnnounced = `gave up: ${tag}`;
				else done = false;
				console.warn(`release reply failed for thread ${threadId}:`, e.message);
			}
		}
		console.log(`Release ${tag} (v${section.version}): ${refs.size} ref(s), ${pending.length} tracked thread(s)`);
		return { told, done };
	}
}
