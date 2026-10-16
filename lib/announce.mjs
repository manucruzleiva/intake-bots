// Release announcement on Discord, shared by every mod's publish.yml through
// .github/workflows/announce.yml. One copy of the message format instead of seven pasted ones.
//
//   node lib/announce.mjs <project> <version> [--print]
//
// <project> is a `dir` of ../projects.json, whose `announce` block holds the per-mod data: the
// channel, the header line (`{version}` is replaced), the embed color, the footer and the `links`
// that become buttons. The changelog is the CHANGELOG.md of the current directory — in the reusable
// workflow, the CALLER's checkout. --print writes the payload to stdout and touches no network: it
// is how a change to this file is checked against the message the previous version sent.
//
// Env: DISCORD_TOKEN (unset → skip, like the inline steps did) and RELEASE_URL (the embed link and
// the "more changes" link, only for a project with no store link: the mod repos are private, so a
// player who opens a GitHub release gets a 404).
//
// The message carries a player-facing SUMMARY of the changelog section, in an embed (description
// holds 4096), never in `content` (2000). The summary is extracted from the section, never written
// apart: its tagline, every `###` heading, and each bullet reduced to its bold lead phrase (its first
// sentence when it has none). The full section is one click away, on the embed title. A summary over
// LIMIT keeps whole headings and ends in "…and N more changes", linked to the same page.
// The project's links are buttons under the embed, never hyperlinks in the text. A link button needs
// no gateway and no interaction handler: it only opens its URL. The changelog gets no button: the
// embed title already links it.
// Ticket refs `(#N)` come out of the public text; the raw section is what closes the tickets, and
// that stays in the caller's publish.yml, which owns the token that can close them.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 3900;
const API = "https://discord.com/api/v10";

/**
 * The buttons, one array per action row (Discord: ≤ 5 rows, ≤ 5 buttons each). `key` names an
 * `announce.links` entry. A project without that link gets no button: a store page that does not
 * exist is left out, never guessed.
 */
const BUTTON_ROWS = [
	[
		{ key: "modrinth", label: "Modrinth", emoji: "⬇️" },
		{ key: "curseforge", label: "CurseForge", emoji: "⬇️" },
		{ key: "wiki", label: "Wiki", emoji: "📖" },
		{ key: "sponsor", label: "Sponsor shiero", emoji: "💛" },
	],
];

/**
 * The public changelog pages, in order of preference, derived from a store link: each store keeps
 * the changelog of every file it hosts. `base`, when set, is the shape the link must have for the
 * page to exist — CurseForge's `/projects/<id>` redirects to the mod page but not to its subpages, so
 * `/minecraft/mc-mods/<slug>/files/all` needs the slug form of the link.
 */
const CHANGELOG_PAGES = [
	{ key: "modrinth", path: "/changelog" },
	{ key: "curseforge", path: "/files/all", base: /^https:\/\/www\.curseforge\.com\/minecraft\/mc-mods\/[a-z0-9-]+\/?$/ },
];
const ACTION_ROW = 1;
const BUTTON = 2;
const LINK_STYLE = 5;
const MAX_ROWS = 5;
const MAX_PER_ROW = 5;
const MAX_LABEL = 80;
const MAX_URL = 512;

const linkUrl = (links, { key, path, base }) => {
	const url = links?.[key];
	if (!url || (base && !base.test(url))) return null;
	return path ? url.replace(/\/+$/, "") + path : url;
};

/** The action rows for a project's links. Throws on a link Discord would refuse with a 400. */
export function buttonRows(links) {
	const rows = BUTTON_ROWS.map((row) =>
		row
			.map((b) => ({ ...b, url: linkUrl(links, b) }))
			.filter((b) => b.url)
			.map(({ label, emoji, url }) => {
				if (!/^https:\/\/\S+$/.test(url) || url.length > MAX_URL) throw new Error(`bad button URL: ${url}`);
				if (label.length > MAX_LABEL) throw new Error(`button label over ${MAX_LABEL}: ${label}`);
				return { type: BUTTON, style: LINK_STYLE, label, emoji: { name: emoji }, url };
			}),
	).filter((row) => row.length);
	if (rows.length > MAX_ROWS || rows.some((r) => r.length > MAX_PER_ROW)) throw new Error("too many buttons");
	return rows.map((components) => ({ type: ACTION_ROW, components }));
}

/** Where the embed title and a cut section point: the first store changelog, else the release. */
export function changelogUrl(links, releaseUrl) {
	return CHANGELOG_PAGES.map((p) => linkUrl(links, p)).find(Boolean) ?? releaseUrl;
}

/**
 * The top non-Unreleased section of a changelog, as the publish workflows' awk extracts it: every
 * line after that heading up to the next one, each ending in "\n".
 */
export function changelogSection(changelog) {
	const lines = changelog.split("\n");
	// split() leaves an empty last element after a final "\n"; awk never sees that record.
	if (changelog.endsWith("\n")) lines.pop();
	const out = [];
	let found = false;
	for (const line of lines) {
		if (line.startsWith("## [")) {
			if (found) break;
			if (!/Unreleased/.test(line)) found = true;
			continue;
		}
		if (found) out.push(line);
	}
	return out.length ? out.join("\n") + "\n" : "";
}

/** The public copy: `(#N)` / `(#N, #M)` refs out, per line, like the old `sed -E`. */
export function publicText(section) {
	return section
		.split("\n")
		.map((l) => l.replace(/[ \t\r\f\v]*\(#[0-9]+(,[ \t\r\f\v]*#[0-9]+)*\)/g, ""))
		.join("\n");
}

/** A period that ends one of these is not the end of a sentence ("Exp. Share"). */
const ABBREVIATION = /\b(?:Exp|e\.g|i\.e|vs|approx|Mr|Dr)\.$/i;

/**
 * What a player reads first of a bullet or paragraph: its bold lead phrase, else its first sentence.
 * A bold lead followed by a comma is the start of a sentence ("**If you don't install it**, you lose
 * the rope"), not a phrase that stands alone, so it gives the sentence instead.
 */
export function leadPhrase(text) {
	const bold = /^\*\*(.+?)\*\*(?!,)/.exec(text);
	if (bold) return bold[1].trim();
	// The markup that closes on the period belongs to the sentence: "…a dependency.** Install…".
	const end = /[.!?][*_`)"']*(?=\s|$)/g;
	for (let m; (m = end.exec(text)); ) {
		if (!ABBREVIATION.test(text.slice(0, m.index + 1))) return text.slice(0, m.index + m[0].length);
	}
	return text;
}

/**
 * The section split at its headings: what comes before the first one, then one block per heading.
 * Each item is a bullet with its continuation lines, or a paragraph, joined into one line.
 */
function sectionBlocks(text) {
	const blocks = [{ heading: null, items: [] }];
	let item = null;
	const close = () => {
		if (item) blocks.at(-1).items.push(item);
		item = null;
	};
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		if (/^#{1,6} /.test(line)) {
			close();
			blocks.push({ heading: line, items: [] });
		} else if (!line.trim()) {
			close();
		} else if (/^[-*+] /.test(line)) {
			close();
			item = { bullet: true, text: line.replace(/^[-*+] +/, "") };
		} else if (item) {
			item.text += ` ${line.trim()}`;
		} else {
			item = { bullet: false, text: line.trim() };
		}
	}
	close();
	return blocks;
}

/**
 * The summary as blocks of `{ head, items }`: the tagline (the line under the version heading, kept
 * whole), then each heading with one line per item. Every item is a change, for the "N more" count.
 */
export function summaryBlocks(text) {
	const [intro, ...sections] = sectionBlocks(text);
	const line = ({ bullet, text }) => (bullet ? "- " : "") + leadPhrase(text);
	const out = [];
	let introItems = intro.items;
	if (introItems[0] && !introItems[0].bullet) {
		out.push({ head: introItems[0].text, items: [] });
		introItems = introItems.slice(1);
	}
	if (introItems.length) out.push({ head: null, items: introItems.map(line) });
	for (const { heading, items } of sections) out.push({ head: heading, items: items.map(line) });
	return out;
}

const renderBlocks = (blocks) =>
	blocks.map(({ head, items }) => [head, ...items].filter((l) => l !== null).join("\n")).join("\n\n");

const changeCount = (blocks) => blocks.reduce((n, b) => n + b.items.length, 0);

/** The tail of a cut summary: how much was left out, linked to the full changelog. */
export function moreLine(n, url) {
	return `**[…and ${n} more change${n === 1 ? "" : "s"}](${url})**`;
}

/**
 * The embed description: the summary of `text`, or its first whole headings up to LIMIT plus the
 * "…and N more changes" line pointing at `moreUrl`. Only when not even the first heading fits is
 * that heading cut, between items.
 */
export function embedBody(text, moreUrl) {
	const blocks = summaryBlocks(text);
	const all = renderBlocks(blocks);
	// Bytes, not characters: never cuts later than Discord's 4096 characters allow.
	if (Buffer.byteLength(all) <= LIMIT) return { body: all, cut: false };
	const total = changeCount(blocks);
	const room = LIMIT - Buffer.byteLength(`\n\n${moreLine(total, moreUrl)}`);
	const fits = (bs) => Buffer.byteLength(renderBlocks(bs)) <= room;
	const kept = [];
	for (const b of blocks) {
		if (fits([...kept, b])) {
			kept.push(b);
			continue;
		}
		if (!changeCount(kept)) {
			const partial = { head: b.head, items: [] };
			for (const item of b.items) {
				if (!fits([...kept, { ...partial, items: [...partial.items, item] }])) break;
				partial.items.push(item);
			}
			if (partial.items.length) kept.push(partial);
		}
		break;
	}
	const body = `${renderBlocks(kept)}\n\n${moreLine(total - changeCount(kept), moreUrl)}`;
	return { body, cut: true };
}

export function buildPayload(announce, version, body, releaseUrl) {
	const payload = {
		content: announce.content.replaceAll("{version}", version),
		embeds: [
			{
				title: `What's new in v${version}`,
				url: changelogUrl(announce.links, releaseUrl),
				description: body,
				color: announce.color,
				footer: { text: announce.footer },
			},
		],
	};
	const components = buttonRows(announce.links);
	if (components.length) payload.components = components;
	return payload;
}

async function diagnose(token, channelId) {
	// "Missing Access" has three causes the error does not tell apart: the token is a DIFFERENT bot
	// than the one invited, the bot is not in that server, or a channel override denies it. Neither
	// call prints the token.
	console.log("--- diagnostics ---");
	const auth = { Authorization: `Bot ${token}` };
	try {
		const who = await (await fetch(`${API}/users/@me`, { headers: auth })).json();
		console.log(`bot identity: ${who.username ?? "?"} id=${who.id ?? "?"}`);
		const res = await fetch(`${API}/channels/${channelId}`, { headers: auth });
		console.log(`GET channel ${channelId} -> HTTP ${res.status}`);
		if (res.ok) {
			const ch = await res.json();
			console.log(`channel: ${ch.name} type=${ch.type} guild=${ch.guild_id}`);
		}
	} catch (e) {
		console.log(`diagnostics failed: ${e.message}`);
	}
}

async function main(argv) {
	const print = argv.includes("--print");
	const [project, version] = argv.filter((a) => a !== "--print");
	if (!project || !version) throw new Error("usage: announce.mjs <project> <version> [--print]");

	const projects = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));
	const entry = projects.find((p) => p.dir === project);
	if (!entry) throw new Error(`projects.json has no project "${project}"`);
	if (!entry.announce) throw new Error(`projects.json: ${project} has no "announce" block`);

	const releaseUrl = process.env.RELEASE_URL;
	if (!releaseUrl) throw new Error("RELEASE_URL is unset");

	const section = changelogSection(readFileSync("CHANGELOG.md", "utf8"));
	if (!section.trim()) {
		console.log("::error::The changelog section came out EMPTY — nothing to announce.");
		return 1;
	}
	const { body, cut } = embedBody(publicText(section), changelogUrl(entry.announce.links, releaseUrl));
	// --print owns stdout for the payload, so its notes go to stderr.
	const log = print ? console.error : console.log;
	if (cut) log(`::warning::Changelog summary over ${LIMIT} chars — cut at a heading, the rest is linked.`);
	const payload = buildPayload(entry.announce, version, body, releaseUrl);

	if (print) {
		process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
		return 0;
	}

	const token = process.env.DISCORD_TOKEN;
	const channelId = entry.announce.channelId;
	if (!token || !channelId) {
		console.log("DISCORD_TOKEN or the project's announce.channelId unset - skipping Discord announcement.");
		return 0;
	}

	const res = await fetch(`${API}/channels/${channelId}/messages`, {
		method: "POST",
		headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	console.log(`Discord API HTTP ${res.status}`);
	// A failure FAILS the job. As a ::warning::, Routes 1.0.33 got a green run for an announcement
	// Discord had refused with 403 "Missing Access". A warning nobody reads is not a check.
	if (res.status !== 200) {
		console.log(await res.text());
		await diagnose(token, channelId);
		console.log(`::error::Discord announcement failed (HTTP ${res.status}). If the bot id above is not the`);
		console.log("::error::application you invited, the DISCORD_TOKEN secret is a different bot.");
		return 1;
	}
	console.log(`Announced ${entry.name} v${version} on Discord.`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e) => {
			console.log(`::error::${e.message}`);
			process.exit(1);
		},
	);
}
