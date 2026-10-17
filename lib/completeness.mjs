// What a bug or crash report still lacks before it can be worked on (#10): the version, the loader
// and, for a crash, the log. The poller asks for exactly the missing pieces instead of the same
// generic request every time, labels the issue `needs-info`, and notices when a later message
// supplies them.
//
// Pure: it reads the messages it is handed, never the network. A log is judged by its presence, not
// parsed — a latest.log or a crash report states the Minecraft version and the loader in its first
// lines, so a report that carries one has all three, and asking its author for their loader would
// read like a bot that did not look.

import { VOICE, ASK_ITEMS, LEGACY } from "./voice.mjs";

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

/**
 * The request appended to the filing reply; "" when nothing is missing. `frame` is one of the voice's
 * `ask` variants (lib/voice.mjs); `items` names each piece as a list entry.
 */
export function askFor(missing, frame, items = ASK_ITEMS) {
	if (!missing.length) return "";
	return `\n\n${frame.head}\n` + missing.map((f) => `- ${items[f]}`).join("\n") + `\n\n${frame.tail}`;
}

/**
 * Every request askFor can produce for these needs, in every frame and in the wording posted before
 * the voice, so the poller recognises its own replies.
 */
export function allAsks(needs) {
	const styles = [...VOICE.ask.map((frame) => [frame, ASK_ITEMS]), [LEGACY.ask, LEGACY.ask.items]];
	const out = new Set();
	for (const [frame, items] of styles) {
		for (let mask = 0; mask < 1 << needs.length; mask++) out.add(askFor(needs.filter((_, i) => mask & (1 << i)), frame, items));
	}
	return [...out];
}
