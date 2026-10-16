// Release announcement on Discord, shared by every mod's publish.yml through
// .github/workflows/announce.yml. One copy of the message format instead of seven pasted ones.
//
//   node lib/announce.mjs <project> <version> [--print]
//
// <project> is a `dir` of ../projects.json, whose `announce` block holds the per-mod data: the
// channel, the header line (`{version}` is replaced), the embed color and the footer. The changelog
// is the CHANGELOG.md of the current directory — in the reusable workflow, the CALLER's checkout.
// --print writes the payload to stdout and touches no network: it is how a change to this file is
// checked against the message the previous version sent.
//
// Env: DISCORD_TOKEN (unset → skip, like the inline steps did) and RELEASE_URL (the embed link and
// the "read the full changelog" link).
//
// The message carries the WHOLE changelog section, in an embed (description holds 4096), never in
// `content` (2000). Only a section over LIMIT is cut, at a line break, with a link to the rest.
// Ticket refs `(#N)` come out of the public text; the raw section is what closes the tickets, and
// that stays in the caller's publish.yml, which owns the token that can close them.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 3900;
const API = "https://discord.com/api/v10";

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

const stripTrailingNewlines = (s) => s.replace(/\n+$/, "");

/** The embed description: the whole text, or its first lines up to LIMIT plus a link out. */
export function embedBody(text, releaseUrl) {
	if (Buffer.byteLength(text) <= LIMIT) return { body: stripTrailingNewlines(text), cut: false };
	const kept = [];
	let n = 0;
	for (const line of text.replace(/\n$/, "").split("\n")) {
		// Bytes, like the threshold above: never cuts later than Discord's 4096 characters allow.
		const len = Buffer.byteLength(line) + 1;
		if (n + len > LIMIT) break;
		kept.push(line);
		n += len;
	}
	const body = `${stripTrailingNewlines(kept.join("\n"))}\n\n…\n**[Read the full changelog](${releaseUrl})**`;
	return { body, cut: true };
}

export function buildPayload(announce, version, body, releaseUrl) {
	return {
		content: announce.content.replaceAll("{version}", version),
		embeds: [
			{
				title: `What's new in v${version}`,
				url: releaseUrl,
				description: body,
				color: announce.color,
				footer: { text: announce.footer },
			},
		],
	};
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
	const { body, cut } = embedBody(publicText(section), releaseUrl);
	// --print owns stdout for the payload, so its notes go to stderr.
	const log = print ? console.error : console.log;
	if (cut) log(`::warning::Changelog section over ${LIMIT} chars — the embed links out for the rest.`);
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
