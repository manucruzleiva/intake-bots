// Satisfaction survey (#13): the release message that tells a reporter their fix is out (#12) carries a
// native Discord poll — "Did vX.Y.Z fix your problem?", Yes / Partly / No, open SURVEY_HOURS. Only for
// crash and bug posts: an idea that shipped is not asked whether it fixed anything. A poll is created
// and read over REST, so it fits the poller: no gateway, no interactions endpoint.
//
// Only the REPORTER's vote counts — anyone in the thread can vote. The reporter is the thread's owner,
// read when the release message is posted and kept in entry.survey.owner. Each run, for every open
// poll, one GET of the message gives the per-answer counts; only an answer someone voted for has its
// voters read. The first vote of the reporter seen is the result, and that poll is not read again.
//
//   Yes            recorded, nothing else
//   Partly / No    recorded; the issue gets FIX_FAILED_LABEL and a comment with the vote, and the thread
//                  is asked what still happens. Nothing reopens: that stays the author's call. The
//                  follow-up window (FOLLOWUP_DAYS_AFTER_CLOSE) counts again from the vote, so the answer
//                  reaches the issue however long after the close the release came (followUpDays)
//   no vote        recorded as `no-answer` once the poll expires
//
// Every result is one row of satisfaction.json, next to state.json: { issue, version, vote, at }.
// A run that finds no new vote changes nothing — not even a "last checked" — so state.json only moves
// when something happened. While the poll is open, and after Partly / No, archiveClosed leaves the
// thread visible (surveyHoldsThread): voting in an archived thread is not something to count on, and a
// question asked into a thread that is then archived is buried.

export const SURVEY_KINDS = new Set(["crash", "bug"]);
export const SURVEY_HOURS = 168;
const ANSWERS = [
	{ vote: "yes", text: "Yes", emoji: "✅" },
	{ vote: "partly", text: "Partly", emoji: "🟡" },
	{ vote: "no", text: "No", emoji: "❌" },
];
const FAILED = new Set(["partly", "no"]);
export const NO_ANSWER = "no-answer";
const GONE = /"code": ?(10003|10008)\b/; // the thread or the poll message was deleted
const VOTERS_PAGE = 100;
const ATTEMPTS = 3;

export const FIX_FAILED_LABEL = { name: "fix-failed", color: "b60205", description: "The reporter said the shipped fix did not solve it" };
export const SURVEY_ASK =
	"Sorry it is not fully fixed yet. **What still happens?** Write it here — it goes straight to the author, together with your vote.";

/** The `poll` field of the release message. `mod` names it in a post filed for several mods. */
export function surveyPoll(version, mod = "") {
	return {
		question: { text: `Did ${mod ? `${mod} ` : ""}v${version} fix your problem?` },
		answers: ANSWERS.map((a) => ({ poll_media: { text: a.text, emoji: { name: a.emoji } } })),
		duration: SURVEY_HOURS,
		allow_multiselect: false,
		layout_type: 1,
	};
}

/** A poll still waiting for the reporter, or a Partly / No still being talked through. */
export const surveyHoldsThread = (entry) => Boolean(entry?.survey && (!entry.survey.vote || FAILED.has(entry.survey.vote)));

/**
 * Days since the issue closed, for the follow-up window — counted from a Partly / No vote instead when
 * that came later: the reporter was just asked what still happens, and their answer must reach the issue.
 */
export function followUpDays(issue, entry) {
	if (issue.state !== "closed") return 0;
	const failedAt = FAILED.has(entry?.survey?.vote) ? Date.parse(entry.survey.at) : 0;
	return (Date.now() - Math.max(Date.parse(issue.closed_at), failedAt)) / 86400000;
}

/**
 * deps: { repo, dryRun, github, discord, discordPost, ensureLabel, degrade, say, fromDiscord }.
 * `satisfaction` is the satisfaction.json array; each result is pushed onto it.
 * Returns how many results were recorded this run.
 */
export async function readSurveys(state, satisfaction, deps) {
	const { dryRun } = deps;
	let recorded = 0;
	for (const [threadId, entry] of Object.entries(state.tracked)) {
		const survey = entry?.survey;
		if (!survey || survey.done) continue;
		try {
			if (!survey.vote) {
				const vote = await reporterVote(threadId, survey, deps);
				if (!vote) continue;
				if (dryRun) {
					console.log(`[dry run] thread ${threadId} (#${entry.issue}): the reporter's answer is ${vote}`);
					continue;
				}
				survey.vote = vote;
				survey.at = new Date().toISOString();
				satisfaction.push({ issue: entry.issue, version: survey.version, vote, at: survey.at });
				recorded++;
				console.log(`Survey on #${entry.issue} (v${survey.version}, thread ${threadId}): ${vote}`);
			}
			if (FAILED.has(survey.vote)) await followUpFailed(threadId, entry, deps);
			survey.done = true;
			delete survey.attempts;
		} catch (e) {
			if (e.fatal) throw e;
			if (GONE.test(e.message)) {
				// Nothing left to vote on or to ask in; a vote already recorded stays recorded.
				console.log(`Survey on #${entry.issue}: thread ${threadId} or its poll is gone`);
				survey.done = true;
				continue;
			}
			// Same give-up as the close reply: a thread that refuses three times is not retried forever.
			survey.attempts = (survey.attempts || 0) + 1;
			if (survey.attempts >= ATTEMPTS) survey.done = true;
			deps.degrade(`survey on #${entry.issue} (thread ${threadId}), attempt ${survey.attempts} of ${ATTEMPTS}`, e);
		}
	}
	return recorded;
}

/** The reporter's answer, NO_ANSWER once the poll expired without one, or null while it is still open. */
async function reporterVote(threadId, survey, { discord }) {
	const { poll } = await discord(`/channels/${threadId}/messages/${survey.message}`);
	if (!poll) return NO_ANSWER; // the poll was taken off the message
	const counts = new Map((poll.results?.answer_counts || []).map((c) => [c.id, c.count]));
	for (const [i, answer] of (poll.answers || []).entries()) {
		// Without results Discord has not tallied yet: read every answer rather than miss a vote.
		if (poll.results && !counts.get(answer.answer_id)) continue;
		if (await votedFor(threadId, survey, answer.answer_id, discord)) return ANSWERS[i]?.vote || NO_ANSWER;
	}
	return Date.now() >= Date.parse(poll.expiry) ? NO_ANSWER : null;
}

async function votedFor(threadId, survey, answerId, discord) {
	let after = "";
	for (;;) {
		const page = await discord(`/channels/${threadId}/polls/${survey.message}/answers/${answerId}?limit=${VOTERS_PAGE}${after}`);
		const users = page.users || [];
		if (users.some((u) => u.id === survey.owner)) return true;
		if (users.length < VOTERS_PAGE) return false;
		after = `&after=${users[users.length - 1].id}`;
	}
}

/** Label, comment, question — each once, so a run cut halfway finishes the rest and repeats nothing. */
async function followUpFailed(threadId, entry, { repo, github, discordPost, ensureLabel, say, fromDiscord }) {
	const { survey } = entry;
	if (!survey.labeled) {
		await ensureLabel(FIX_FAILED_LABEL);
		await github(`/repos/${repo}/issues/${entry.issue}/labels`, { labels: [FIX_FAILED_LABEL.name] });
		survey.labeled = true;
	}
	if (!survey.commented) {
		const answer = ANSWERS.find((a) => a.vote === survey.vote);
		await github(`/repos/${repo}/issues/${entry.issue}/comments`, {
			body: [
				`**Satisfaction survey** · the reporter answered **${answer.emoji} ${answer.text}** to "Did v${survey.version} fix your problem?" on Discord, ${survey.at.slice(0, 16).replace("T", " ")} UTC.`,
				"",
				`They were asked what still happens; their answer arrives here as a follow-up. The issue was not reopened.`,
				"",
				fromDiscord, // lib/replies.mjs never relays it back
			].join("\n"),
		});
		survey.commented = true;
	}
	if (!survey.asked) {
		const ping = survey.owner ? `<@${survey.owner}> ` : "";
		await discordPost(`/channels/${threadId}/messages`, {
			content: ping + say(entry, SURVEY_ASK),
			allowed_mentions: { parse: [], users: survey.owner ? [survey.owner] : [] },
		});
		survey.asked = true;
		console.log(`Asked thread ${threadId} (#${entry.issue}) what still happens`);
	}
}
