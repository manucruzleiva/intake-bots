// Computah's voice (#17): every message the bot writes into a reporter's thread, as a list of
// variants. Computah speaks like a primitive AI — short, curt, efficient — and does not say the same
// sentence twice in a row. One casing rule for all of it: the bold label in CAPITALS, the rest in
// clipped sentence case, so the request for data stays readable.
//
// The variant is picked by rotation, one counter per message key in the project's state.json
// (`state.voice`): two posts of the same kind in a row always get different texts, and a dry run
// shows exactly the text the real run would post (it advances the counter only in memory and writes
// nothing). A counter that is not there starts at 0.
//
// The texts are not decoration; every variant of a key keeps what that message does:
//   filed.crash     it jumps the queue (the log and the mod list are asked for in `ask`)
//   filed.bug       steps to reproduce (version and loader are asked for in `ask`, when missing)
//   filed.idea/feedback   no promise on timing; nothing else needed from the reporter
//   fixed.*         ships in the next release; post here if it comes back
//   notPlanned      closed without a change, never "fixed"; it can be reopened
// And none of them ever links the private code repo.
//
// The bot knows its own messages by their text (OWN_REPLIES, CLOSE_TEXTS in poller.mjs), so a text
// edited here is still recognised in its new wording only. LEGACY keeps the wording that was posted
// before this voice existed: threads still open carry it, and a multi-mod post reads the other mods'
// close replies back from the thread.

export const VOICE = {
	"filed.crash": [
		"🚨 **CRASH REGISTERED.** Priority: maximum. It jumps the queue.",
		"🚨 **CRASH LOGGED.** Queue skipped. This one goes first.",
		"🚨 **CRITICAL FAULT RECEIVED.** Priority override engaged. Front of the queue.",
	],
	"filed.bug": [
		"🐛 **BUG STORED.** Steps to reproduce: not in the post? Add them here.",
		"🐛 **ANOMALY RECORDED.** Repair queue updated. Exact steps to reproduce speed up the repair.",
		"🐛 **DEFECT LOGGED.** Steps that trigger it: post them here if not given yet.",
	],
	"filed.idea": [
		"💡 **IDEA STORED.** Weighed against the roadmap. Timing: not promised. Nothing more needed from you. " +
			"A picture beats a description.",
		"💡 **PROPOSAL RECEIVED.** Queued for evaluation. No date promised. Your part is done. " +
			"A sketch or a screenshot, if you have one, helps.",
		"💡 **CONCEPT ARCHIVED FOR REVIEW.** No timing promised. No further input required. Images help more than words.",
	],
	"filed.feedback": [
		"💬 **FEEDBACK RECORDED.** Read. Stored. It steers what gets built next. No timing promised. Nothing needed from you.",
		"💬 **INPUT ACQUIRED.** Logged for the author. No timeline promised. Nothing else required.",
	],
	"filed.other": [
		"✅ **RECEIVED.** On the list. News arrives in this thread.",
		"✅ **LOGGED.** Tracked. Updates post here.",
	],
	"fixed.crash": [
		"✅ **CRASH ELIMINATED.** Fix ships in the next release. Update. Test. Crashes again? Post here: it reopens.",
		"✅ **FAULT REPAIRED.** The next release carries the fix. Returns? Report here.",
		"✅ **CAUSE REMOVED.** Fix deploys with the next release. If it crashes again, post here and it reopens.",
	],
	"fixed.bug": [
		"✅ **ANOMALY ELIMINATED.** Fix ships in the next release. Recurs? Report here.",
		"✅ **BUG TERMINATED.** The next release carries the fix. Update. If it returns, post here and it reopens.",
		"✅ **DEFECT REPAIRED.** Arrives with the next release. Comes back? Post here.",
	],
	"fixed.idea": [
		"✅ **IDEA IMPLEMENTED.** Ships in the next release. Contribution: valuable.",
		"✅ **PROPOSAL BUILT.** The next release carries it. Gratitude registered.",
		"✅ **CONCEPT IS NOW CODE.** Deploys with the next release. The mod improved. Thanks.",
	],
	"fixed.feedback": [
		"✅ **FEEDBACK PROCESSED.** Read. It counted. Thanks.",
		"✅ **INPUT CONSUMED.** Acted on. Gratitude logged.",
	],
	"fixed.other": ["✅ **CLOSED.** Task complete.", "✅ **RESOLVED.** Entry closed."],
	notPlanned: [
		"📕 **CLOSED. NO CHANGE MADE.** Not taken forward for now. Not a verdict on the report. " +
			"Disagree, or new data? Post here. It can be reopened.",
		"📕 **ARCHIVED WITHOUT ACTION.** Nothing was changed. Decision: not now. " +
			"New information? Reply here. Reopening is possible.",
	],
	// What a bug or crash report still lacks (lib/completeness.mjs): a frame around the list of items.
	ask: [
		{ head: "**DATA MISSING.** Provide:", tail: "Reply in this thread. It reaches the report." },
		{ head: "**INSUFFICIENT DATA.** Required:", tail: "Reply here. Computah forwards it." },
	],
	// {version} is the bare version, "2.0.3". Recognised by releaseMatchers, wherever it sits in the message.
	release: [
		"🚀 **NOW LIVE: v{version}.** It carries your report. Update. Test.",
		"🚀 **v{version} DEPLOYED.** Your report is in it. Update now.",
	],
	// After a Partly / No vote on the satisfaction poll (lib/survey.mjs).
	surveyAsk: [
		"🔧 **FIX INCOMPLETE.** **What still happens?** Describe it here. It goes to the author, with your vote.",
		"🔧 **RESIDUAL FAULT DETECTED.** **What still happens?** Write it here. Computah delivers it to the author, with your vote.",
	],
	// A post in #tickets with no mod tag (lib/unrouted.mjs).
	untagged: [
		"🏷️ **MOD UNKNOWN.** Add its tag: the **…** menu → **Edit Tags**. Untagged = untracked. " +
			"Nothing else needed: pickup is automatic once tagged.",
		"🏷️ **TAG REQUIRED.** Which mod? Add its tag (**…** → **Edit Tags**). Until then: not tracked. " +
			"Once tagged: picked up automatically.",
	],
};

// The items of `ask`, written to be read as list entries.
export const ASK_ITEMS = {
	version: "Minecraft and mod versions (e.g. `1.21.1` and `2.0.3`)",
	loader: "loader: Fabric or NeoForge",
	log: "`crash-reports/crash-*.txt` or `logs/latest.log`: attached here, or an mclo.gs link. The mod list helps too",
};

// The single text of the satisfaction poll's question: the issue comment quotes it back.
export const pollQuestion = (version, mod = "") => `FIX CHECK: did ${mod ? `${mod} ` : ""}v${version} solve your problem?`;

// The wording posted before #17. Only ever matched against, never posted.
export const LEGACY = {
	filed: {
		crash: "🚨 **Tracked as a crash** — this one jumps the queue.",
		bug: "🐛 **Tracked as a bug.**",
		idea:
			"💡 **Tracked as an idea.**\n\n" +
			"It goes on the list to weigh against the roadmap — no promise on timing, and nothing else needed " +
			"from you. If you have a picture of what you are imagining, it helps more than a description.",
		feedback:
			"💬 **Tracked as feedback.**\n\n" +
			"Nothing to do on your side — it is read and recorded, and this is the kind of thing that actually " +
			"steers what gets built next.",
		other: "✅ **Tracked.** It is on the list, and we post back here when there is news.",
	},
	fixed: {
		crash:
			"✅ **Fixed.** The cause is gone on our side and the fix ships in the next release — update and give " +
			"it a go. If it comes back, post here and we reopen this.",
		bug: "✅ **Fixed.** It ships in the next release — update and give it a go. If it comes back, post here and we reopen this.",
		idea: "✅ **This one landed.** It ships in the next release. Thanks for the idea — it made the mod better.",
		feedback: "✅ **Wrapped up.** Thanks for taking the time to write it — it was read and it counted.",
		other: "✅ **Closed** — this one is wrapped up.",
	},
	notPlanned:
		"📕 **Closed without a change** — we are not taking this one forward for now.\n\n" +
		"That is not a verdict on the report: if you disagree, or something new turns up, say so here and it " +
		"can be reopened.",
	ask: {
		head: "To work on it we still need:",
		tail: "Reply here with them and they reach the report.",
		items: {
			version: "your Minecraft and mod versions (for example `1.21.1` and `2.0.3`)",
			loader: "your loader: Fabric or NeoForge",
			log: "the crash report (`crash-reports/crash-*.txt`) or `logs/latest.log`, attached here or as an mclo.gs link",
		},
	},
	releasePrefix: "🚀 **Out now in ",
	surveyAsk: "Sorry it is not fully fixed yet. **What still happens?** Write it here — it goes straight to the author, together with your vote.",
	untagged:
		"🏷️ **Which mod is this about?** Add its tag to this post (the **…** menu → **Edit Tags**) — " +
		"until it has one, it is not tracked anywhere. Nothing else to do: it is picked up as soon as the tag is there.",
};

/** Every variant of a key. */
export function variants(key) {
	const list = VOICE[key];
	if (!list) throw new Error(`voice: no texts for "${key}"`);
	return list;
}

/** The next variant of `key` for this project, by rotation: `state.voice[key]` counts the times it was spoken. */
export function speak(state, key) {
	const list = variants(key);
	state.voice ||= {};
	const n = state.voice[key] || 0;
	state.voice[key] = n + 1;
	return list[n % list.length];
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A regex per release variant, the version left open: how the bot knows its release line in a thread. */
export const releaseMatchers = () => variants("release").map((t) => new RegExp(t.split("{version}").map(escape).join("[\\w.+-]+")));

/** The release line of a version. */
export const releaseLine = (template, version) => template.replaceAll("{version}", version);
