// The posts of the shared tickets forum that no project picks up: the ones without a mod tag.
//
// Every intake row reads the shared forum but keeps only the posts carrying its own mod tag (`tag` in
// ../projects.json), so a post with none belongs to nobody. Discord's "require tag" cannot prevent
// it: it forces SOME tag, and a kind tag alone satisfies it. Without this step that post would sit
// unanswered forever, which reads exactly like a bot that is down.
//
// So once per intake run this replies in each such post, ONCE, asking for the mod tag, and files
// nothing. The asked threads are kept in ../unrouted.json. Once the reporter adds the tag, the owning
// row files the post on its next run like any other — nothing here has to notice.
//
// Env:
//   DISCORD_BOT_TOKEN        the bot (`DISCORD_TOKEN` in the workflow)
//   DISCORD_GUILD_ID         the guild: active threads are listed per guild
//   TICKETS_FORUM_ID         the shared forum
//   DRY_RUN                  "1": print what would be asked, post and write nothing
//
// Exit code: 1 when the run could not do its job (the forum or the thread lists could not be read, a
// reply did not go through), so the row goes red instead of green-and-silent.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { projects } from "./gates.mjs";

const D = "https://discord.com/api/v10";
const UA = "intake-unrouted (+https://github.com/manucruzleiva/intake-bots)";
const DRY_RUN = process.env.DRY_RUN === "1";
const FILE = new URL("../unrouted.json", import.meta.url);
const KEEP = 1000;
// The forum's pinned post is the how-to-report example (server.json `pinned`): no mod tag, on purpose.
const PINNED = 1 << 1;

// The poller imports it: in a test thread the bot is the owner, and this must not come back as a follow-up.
export const ASK =
	"🏷️ **Which mod is this about?** Add its tag to this post (the **…** menu → **Edit Tags**) — " +
	"until it has one, it is not tracked anywhere. Nothing else to do: it is picked up as soon as the tag is there.";

function env(name) {
	// Same stripping as the poller: a BOM in a secret has already shipped once.
	const v = (process.env[name] || "").replace(/^﻿/, "").trim();
	if (!v) {
		console.error(`Missing required env ${name}`);
		process.exit(1);
	}
	return v;
}

let TOKEN;

async function discord(path, init = {}) {
	const res = await fetch(D + path, {
		...init,
		headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": UA, "Content-Type": "application/json" },
	});
	if (!res.ok) throw new Error(`Discord ${init.method || "GET"} ${path} -> ${res.status} ${await res.text()}`);
	return res.json();
}

async function main() {
	TOKEN = env("DISCORD_BOT_TOKEN");
	const GUILD = env("DISCORD_GUILD_ID");
	const FORUM = env("TICKETS_FORUM_ID");
	const asked = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")).asked || [] : [];
	const done = new Set(asked);
	const failures = [];

	const forum = await discord(`/channels/${FORUM}`);
	const mods = new Set(projects.map((p) => p.tag?.toLowerCase()).filter(Boolean));
	const modTagIds = new Set((forum.available_tags || []).filter((t) => mods.has(t.name.toLowerCase())).map((t) => t.id));
	if (!modTagIds.size) throw new Error(`#${forum.name} has none of the mod tags of projects.json: every post would be asked`);

	const threads = new Map();
	for (const t of (await discord(`/guilds/${GUILD}/threads/active`)).threads || []) {
		if (t.parent_id === FORUM) threads.set(t.id, t);
	}
	for (const t of (await discord(`/channels/${FORUM}/threads/archived/public?limit=25`)).threads || []) threads.set(t.id, t);

	let n = 0;
	for (const t of threads.values()) {
		if (done.has(t.id) || t.flags & PINNED || (t.applied_tags || []).some((id) => modTagIds.has(id))) continue;
		if (DRY_RUN) {
			console.log(`[dry run] would ask for a mod tag in "${t.name}" (${t.id})`);
			n++;
			continue;
		}
		try {
			await discord(`/channels/${t.id}/messages`, { method: "POST", body: JSON.stringify({ content: ASK }) });
			asked.push(t.id);
			done.add(t.id);
			n++;
			console.log(`Asked for a mod tag in "${t.name}" (${t.id})`);
		} catch (e) {
			console.log(`::error::${e.message}`);
			failures.push(e.message);
		}
	}

	if (!DRY_RUN) writeFileSync(FILE, JSON.stringify({ asked: asked.slice(-KEEP) }, null, 2) + "\n");
	console.log(`${DRY_RUN ? "Dry run. " : ""}${n} post(s) asked for a mod tag; ${threads.size} post(s) in #${forum.name} looked at.`);
	if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
