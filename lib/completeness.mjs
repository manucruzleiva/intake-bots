// What a bug or crash report still lacks before it can be worked on (#10): the version, the loader
// and, for a crash, the log. The poller asks for exactly the missing pieces instead of the same
// generic request every time, labels the issue `needs-info`, and notices when a later message
// supplies them.
//
// Pure: it reads the messages it is handed, never the network. A log is judged by its presence, not
// parsed — a latest.log or a crash report states the Minecraft version and the loader in its first
// lines, so a report that carries one has all three, and asking its author for their loader would
// read like a bot that did not look.

/** The pieces each kind needs. Every other kind needs nothing. */
export const NEEDS = {
	bug: ["version", "loader"],
	crash: ["version", "loader", "log"],
};

// A version string: Minecraft's `1.21.1`, a mod's `2.0.3`, a bare `1.21`.
const VERSION = /\bv?\d{1,2}\.\d{1,3}(?:\.\d{1,3})?\b/i;
// Any loader name answers the question, even one the mod does not support.
const LOADER = /\b(?:fabric|neo[\s-]?forge|forge|quilt)\b/i;
const LOG_FILE = /\.(?:log|txt)(?:\.gz)?$/i;
const LOG_LINK = /\b(?:mclo\.gs|pastebin\.com|gist\.github\.com|hastebin\.com|paste\.ee)\//i;

// How the reply names each piece: written to be read as a list item.
const ASK = {
	version: "your Minecraft and mod versions (for example `1.21.1` and `2.0.3`)",
	loader: "your loader: Fabric or NeoForge",
	log: "the crash report (`crash-reports/crash-*.txt`) or `logs/latest.log`, attached here or as an mclo.gs link",
};

function hasLog(msgs) {
	return msgs.some((m) => (m?.attachments || []).some((a) => LOG_FILE.test(a.filename || "")) || LOG_LINK.test(m?.content || ""));
}

/** Of the pieces in `needs`, the ones none of `msgs` supplies, in the order of `needs`. */
export function missingInfo(needs, msgs) {
	if (!needs?.length) return [];
	if (hasLog(msgs)) return [];
	const text = msgs.map((m) => m?.content || "").join("\n");
	const present = { version: VERSION.test(text), loader: LOADER.test(text), log: false };
	return needs.filter((f) => !present[f]);
}

/** The request appended to the filing reply; "" when nothing is missing. */
export function askFor(missing) {
	if (!missing.length) return "";
	return (
		"\n\nTo work on it we still need:\n" +
		missing.map((f) => `- ${ASK[f]}`).join("\n") +
		"\n\nReply here with them and they reach the report."
	);
}

/** Every request askFor can produce for these needs, so the poller recognises its own replies. */
export function allAsks(needs) {
	const out = [];
	for (let mask = 0; mask < 1 << needs.length; mask++) out.push(askFor(needs.filter((_, i) => mask & (1 << i))));
	return out;
}
