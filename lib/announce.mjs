// Release announcement on Discord, for every mod. A mod repo never talks to Discord: its publish.yml
// fires a `mod-released` repository_dispatch once the stores took the jars, and
// .github/workflows/mod-released.yml runs this. One copy of the message format, one bot token.
//
//   node lib/announce.mjs <project> <version> [--print]
//
// <project> is a `dir` of ../projects.json, whose `announce` block holds the per-mod data: the
// header line (`{version}` is replaced), the embed color, the footer and the `links` that become
// buttons.
//
// Every mod posts to ONE channel, `#announcements` of ../server.json (its pinned id), and pings the
// mod's opt-in ROLE — the role named like the project's `tag`, which lib/bootstrap.mjs declares and
// members pick in the onboarding. The role is looked up by name at run time, like everything else
// here. `allowed_mentions` names that one role and nothing else, so an `@everyone` that ends up in a
// changelog pings nobody. A missing role is a warning, not a failure: the card still goes out.
//
// Nothing is taken on the caller's word. The tag must be a published (non-draft) release of the
// mod's repo and name the version announced, and the changelog is the mod's CHANGELOG.md AT THAT TAG,
// read through the GitHub API: intake-bots has no checkout of the mod. The release's page is the
// embed link and the "more changes" link, only for a project with no store link: the mod repos are
// private, so a player who opens a GitHub release gets a 404.
//
// --print writes the payload to stdout and never touches Discord (it still reads GitHub): it is the
// dispatch's dry run, and how a change to this file is checked against the message the previous
// version sent.
//
// Env: MOD_REPO ("owner/repo", the project's <PREFIX>_GH_REPO), GH_TOKEN (reads that repo), TAG
// (default v<version>) and DISCORD_TOKEN (unset → skip).
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
// that stays in the mod's publish.yml, which owns the token that can close them.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { topSection } from "./releases.mjs";

const LIMIT = 3900;
const API = "https://discord.com/api/v10";
const GITHUB = "https://api.github.com";
export const ANNOUNCE_CHANNEL = "announcements";

/** The id of channel `name`, as pinned in ../server.json. */
export function pinnedChannelId(name, spec = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"))) {
	const channels = [...(spec.channels ?? []), ...(spec.categories ?? []).flatMap((c) => c.channels ?? [])];
	const ch = channels.find((c) => c.name === name);
	if (!ch?.id) throw new Error(`server.json has no #${name} with a pinned id`);
	return ch.id;
}

/** The id of the global announcements channel. */
export const announceChannelId = (spec) => pinnedChannelId(ANNOUNCE_CHANNEL, spec);

/**
 * The buttons, one array per action row (Discord: ≤ 5 rows, ≤ 5 buttons each). `key` names an
 * `announce.links` entry. A project without that link gets no button: a store page that does not
 * exist is left out, never guessed. A `tracked` button carries the GitHub Sponsors metadata of the
 * surface it sits on, so the Sponsors export says which mod and which message a sponsorship came from.
 * An `app` button shows the bot's application emoji of that name (server.json's `emojis` uploads it),
 * and its Unicode `emoji` while the app has none: a missing logo never stops a card.
 */
const BUTTON_ROWS = [
	[
		{ key: "modrinth", label: "Modrinth", emoji: "⬇️", app: "modrinth" },
		{ key: "curseforge", label: "CurseForge", emoji: "⬇️", app: "curseforge" },
		{ key: "wiki", label: "Wiki", emoji: "📖" },
		{ key: "sponsor", label: "Sponsor shiero", emoji: "💛", tracked: true },
	],
];

/** The surfaces a tracked button can sit on, as `metadata_src` names them across the stack. */
export const SOURCES = { catalog: "discord-catalog", announce: "discord-announce" };

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
// GitHub Sponsors answers a 404 to a metadata value outside this set or over 100 characters.
const METADATA_VALUE = /^[A-Za-z0-9_-]{1,100}$/;

const linkUrl = (links, { key, path, base }) => {
	const url = links?.[key];
	if (!url || (base && !base.test(url))) return null;
	return path ? url.replace(/\/+$/, "") + path : url;
};

/** `url` with `metadata_<key>` appended for each of `metadata`. Throws on a value Sponsors 404s on. */
function withMetadata(url, metadata) {
	const u = new URL(url);
	for (const [key, value] of Object.entries(metadata)) {
		if (!METADATA_VALUE.test(value)) throw new Error(`bad sponsor metadata ${key}=${value}`);
		u.searchParams.set(`metadata_${key}`, value);
	}
	return u.href;
}

/**
 * The action rows for a project's links. `mod` (the project's `dir`) and `src` (one of SOURCES) go
 * on the tracked buttons; without them those buttons keep the bare link. `emojis` maps an
 * application emoji's name to its id (appEmojis). Throws on a link Discord would refuse with a 400.
 */
export function buttonRows(links, { mod, src, emojis } = {}) {
	const metadata = mod && src ? { mod, src } : null;
	const rows = BUTTON_ROWS.map((row) =>
		row
			.map((b) => ({ ...b, url: linkUrl(links, b) }))
			.map((b) => (b.url && b.tracked && metadata ? { ...b, url: withMetadata(b.url, metadata) } : b))
			.filter((b) => b.url)
			.map(({ label, emoji, app, url }) => {
				if (!/^https:\/\/\S+$/.test(url) || url.length > MAX_URL) throw new Error(`bad button URL: ${url}`);
				if (label.length > MAX_LABEL) throw new Error(`button label over ${MAX_LABEL}: ${label}`);
				const id = app && emojis?.get(app);
				return { type: BUTTON, style: LINK_STYLE, label, emoji: id ? { id, name: app } : { name: emoji }, url };
			}),
	).filter((row) => row.length);
	if (rows.length > MAX_ROWS || rows.some((r) => r.length > MAX_PER_ROW)) throw new Error("too many buttons");
	return rows.map((components) => ({ type: ACTION_ROW, components }));
}

/**
 * The bot's application emojis, name → id. Each `app` button missing from them is a warning, and so
 * is a failed lookup (an empty map): the buttons fall back to their Unicode emoji.
 */
export async function appEmojis(token) {
	const get = async (path) => {
		const res = await fetch(API + path, { headers: { Authorization: `Bot ${token}` } });
		if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
		return res.json();
	};
	let emojis = new Map();
	try {
		const { id } = await get("/applications/@me");
		emojis = new Map((await get(`/applications/${id}/emojis`)).items.map((e) => [e.name, e.id]));
	} catch (e) {
		console.log(`::warning::Application emoji lookup failed (${e.message}): the store buttons keep their Unicode emoji.`);
		return emojis;
	}
	const missing = BUTTON_ROWS.flat().map((b) => b.app).filter((n) => n && !emojis.has(n));
	if (missing.length) console.log(`::warning::No application emoji ${missing.join(", ")}: those buttons keep their Unicode emoji. server.json's \`emojis\` uploads them.`);
	return emojis;
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

/** The card's first line. lib/releases.mjs looks for it to know a release is really out. */
export const announceHeader = (announce, version) => announce.content.replaceAll("{version}", version);

/**
 * `roleId` is the mod's opt-in role, mentioned under the header; without one the card pings nobody.
 * `mod` is the project's `dir`, for the Sponsor button's metadata; `emojis` is appEmojis().
 */
export function buildPayload(announce, version, body, releaseUrl, roleId, mod, emojis) {
	const header = announceHeader(announce, version);
	const payload = {
		content: roleId ? `${header}
<@&${roleId}>` : header,
		allowed_mentions: { parse: [], roles: roleId ? [roleId] : [] },
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
	const components = buttonRows(announce.links, { mod, src: SOURCES.announce, emojis });
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

/** The id of the role named like `tag` in the channel's guild, or "" — with a warning — when there is none. */
async function modRole(token, channelId, tag) {
	if (!tag) return "";
	const get = async (path) => {
		const res = await fetch(API + path, { headers: { Authorization: `Bot ${token}` } });
		if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
		return res.json();
	};
	try {
		const { guild_id } = await get(`/channels/${channelId}`);
		const role = (await get(`/guilds/${guild_id}/roles`)).find((r) => r.name.toLowerCase() === tag.toLowerCase());
		if (role) return role.id;
		console.log(`::warning::No role "${tag}" in the server: the card goes out without a ping. lib/bootstrap.mjs declares it.`);
	} catch (e) {
		console.log(`::warning::Role lookup failed (${e.message}): the card goes out without a ping.`);
	}
	return "";
}

/** GET on the GitHub API with GH_TOKEN; `raw` returns a file's contents instead of JSON. */
async function github(path, raw = false) {
	const token = process.env.GH_TOKEN;
	if (!token) throw new Error("GH_TOKEN is unset");
	const res = await fetch(GITHUB + path, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	return raw ? res.text() : res.json();
}

async function githubRaw(path) {
	const text = await github(path, true);
	if (text === null) throw new Error(`GitHub ${path}: not found`);
	return text;
}

/** The release behind `tag`, which must be published and name `version`: a dispatch is not proof. */
async function publishedRelease(repo, tag, version) {
	if (tag.replace(/^v/, "") !== version) throw new Error(`tag ${tag} does not name version ${version}`);
	const release = await github(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
	if (!release) throw new Error(`${repo} has no release ${tag}`);
	if (release.draft) throw new Error(`${repo} release ${tag} is still a draft`);
	return release;
}

async function main(argv) {
	const print = argv.includes("--print");
	const [project, version] = argv.filter((a) => a !== "--print");
	if (!project || !version) throw new Error("usage: announce.mjs <project> <version> [--print]");

	const projects = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));
	const entry = projects.find((p) => p.dir === project);
	if (!entry) throw new Error(`projects.json has no project "${project}"`);
	if (!entry.announce) throw new Error(`projects.json: ${project} has no "announce" block`);

	const repo = process.env.MOD_REPO;
	if (!repo) throw new Error(`MOD_REPO is unset (the ${entry.prefix}_GH_REPO variable)`);
	const tag = process.env.TAG || `v${version}`;
	const release = await publishedRelease(repo, tag, version);
	const releaseUrl = release.html_url;

	const changelog = await githubRaw(`/repos/${repo}/contents/CHANGELOG.md?ref=${encodeURIComponent(tag)}`);
	const top = topSection(changelog)?.version;
	if (top !== version) throw new Error(`CHANGELOG.md at ${tag} opens with [${top ?? "nothing"}], not [${version}]`);
	const section = changelogSection(changelog);
	if (!section.trim()) {
		console.log("::error::The changelog section came out EMPTY — nothing to announce.");
		return 1;
	}
	const { body, cut } = embedBody(publicText(section), changelogUrl(entry.announce.links, releaseUrl));
	// --print owns stdout for the payload, so its notes go to stderr.
	const log = print ? console.error : console.log;
	if (cut) log(`::warning::Changelog summary over ${LIMIT} chars — cut at a heading, the rest is linked.`);
	const channelId = announceChannelId();

	if (print) {
		// No network here, so the role is a placeholder and the store buttons keep their Unicode
		// emoji: the live run looks both up by name.
		const payload = buildPayload(entry.announce, version, body, releaseUrl, entry.tag && `ROLE:${entry.tag}`, entry.dir);
		process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
		return 0;
	}

	const token = process.env.DISCORD_TOKEN;
	if (!token) {
		console.log("DISCORD_TOKEN unset - skipping Discord announcement.");
		return 0;
	}
	const payload = buildPayload(entry.announce, version, body, releaseUrl, await modRole(token, channelId, entry.tag), entry.dir, await appEmojis(token));

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
