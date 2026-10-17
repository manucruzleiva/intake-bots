// Adds a mod to the Discord server as code: the "add a mod" pass over ../server.json.
//
//   node lib/bootstrap.mjs --dir <dir> [--tag <Tag>] [--emoji <emoji>] [--name <Name>] [--prefix <PREFIX>] [--write] [--file <path>]
//
// A mod no longer gets channels of its own. It gets, in server.json:
//   - its MOD TAG in the shared `tickets` forum, which is how the poller routes its posts (#19);
//   - a ROLE named like the tag, with no permissions: the opt-in ping of its release card (#21);
//   - that role as an option of the onboarding prompt PROMPT_TITLE, where members pick it.
// and an empty <dir>/state.json, the dedup ledger its intake row starts from.
//
// Only what is missing is added; nothing is renamed or removed, so it runs as often as you like and
// a second run says "nothing to do". Without --write it is a dry run: it prints what it would add.
// It never touches Discord: `server.yml` (or `node lib/server.mjs --apply`) does that afterwards,
// from the file this wrote. And it never writes ids or variables anywhere — what is left to do by
// hand (projects.json, secrets, the registry) is printed at the end, because the registry in
// Publishing Standard and cargar-secrets.ps1 are the authority, and a second writer is how four
// wrong ids happened at once.
//
// A mod already in projects.json reads dir, name, prefix and tag from there; --emoji is still needed
// the first time, since the emoji lives only in the tag and the onboarding option.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatJson, validate } from "./server.mjs";
import { projects } from "./gates.mjs";

export const FORUM_NAME = "tickets";
export const PROMPT_TITLE = "Which mods do you want release pings for?";
const MAX_TAGS = 20; // Discord's cap per forum
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Adds `mod` ({ tag, emoji }) to `spec` (server.json, parsed) in place. Returns the list of what it
 * added, as diff lines; empty means the file already had all of it. Throws on what it cannot do.
 */
export function addMod(spec, mod) {
	const added = [];
	const forum = [...(spec.channels ?? []), ...(spec.categories ?? []).flatMap((c) => c.channels ?? [])].find(
		(c) => c.name === FORUM_NAME && c.type === "forum",
	);
	if (!forum) throw new Error(`server.json has no "${FORUM_NAME}" forum`);
	const tags = (forum.available_tags ??= []);
	const tag = tags.find((t) => same(t.name, mod.tag));
	if (!tag) {
		if (!mod.emoji) throw new Error(`"${mod.tag}" is not in #${FORUM_NAME} yet: --emoji is needed`);
		if (tags.length >= MAX_TAGS) throw new Error(`#${FORUM_NAME} already has ${MAX_TAGS} tags, Discord's limit`);
		// Before the status tags (the moderated ones), so the forum keeps kinds, mods, statuses in that order.
		const statuses = tags.findIndex((t) => t.moderated);
		tags.splice(statuses < 0 ? tags.length : statuses, 0, { name: mod.tag, emoji_name: mod.emoji });
		added.push(`+ tag "${mod.tag}" ${mod.emoji} in #${FORUM_NAME}`);
	}
	const emoji = mod.emoji || tag?.emoji_name;

	// Just above @everyone, so it never outranks a role that means something.
	if (!spec.roles.some((r) => same(r.name, mod.tag))) {
		spec.roles.splice(spec.roles.length - 1, 0, { name: mod.tag, permissions: [] });
		added.push(`+ role "${mod.tag}"`);
	}

	if (!spec.onboarding) throw new Error("server.json has no onboarding block: declare it (export the guild) before adding a mod");
	const prompts = (spec.onboarding.prompts ??= []);
	let prompt = prompts.find((p) => p.title === PROMPT_TITLE);
	if (!prompt) {
		prompt = { title: PROMPT_TITLE, type: 0, single_select: false, required: false, in_onboarding: true, options: [] };
		prompts.push(prompt);
		added.push(`+ onboarding prompt "${PROMPT_TITLE}"`);
	}
	if (!prompt.options.some((o) => (o.roles ?? []).some((r) => same(r, mod.tag)))) {
		prompt.options.push({ title: mod.tag, ...(emoji ? { emoji_name: emoji } : {}), channels: [], roles: [mod.tag] });
		added.push(`+ onboarding option "${mod.tag}" → role "${mod.tag}"`);
	}
	return added;
}

function args(argv) {
	const out = { write: argv.includes("--write") };
	for (const k of ["dir", "tag", "emoji", "name", "prefix", "file"]) {
		const i = argv.indexOf(`--${k}`);
		if (i >= 0) out[k] = argv[i + 1];
	}
	return out;
}

/** dir, name, prefix and tag: from projects.json when the mod is there, from the flags when it is new. */
function resolveMod(a) {
	if (!a.dir) throw new Error("--dir is required");
	const known = projects.find((p) => p.dir === a.dir);
	if (known?.tag && a.tag && !same(known.tag, a.tag)) throw new Error(`projects.json gives ${a.dir} the tag "${known.tag}", not "${a.tag}"`);
	const tag = known?.tag || a.tag;
	if (!tag) throw new Error("--tag is required for a mod that is not in projects.json");
	return {
		known: Boolean(known),
		dir: a.dir,
		tag,
		emoji: a.emoji,
		name: known?.name || a.name || tag,
		prefix: known?.prefix || a.prefix || a.dir.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
	};
}

function nextSteps(mod) {
	const P = mod.prefix;
	const lines = ["", "Left to do by hand:", ""];
	if (!mod.known) {
		lines.push(
			"1. Load its variable (cargar-secrets.ps1 registry with Intake = $true, or by hand):",
			`     ${P}_GH_REPO. The secrets are the shared DISCORD_TOKEN and GH_TOKEN.`,
			`   No ${P}_TICKETS_CHANNEL_ID: its posts arrive through the shared forum.`,
			"2. Then add it to projects.json (an entry before its secrets is a red row on every run):",
			"",
			formatJson({
				dir: mod.dir,
				name: mod.name,
				prefix: P,
				tag: mod.tag,
				ua: `${mod.dir}-intake (+https://modrinth.com/project/<modrinth id or slug>)`,
			}).replace(/^/gm, "     "),
			"",
			"   and an `announce` block when it publishes (see README, projects.json).",
		);
	}
	lines.push(
		`${mod.known ? "1" : "3"}. Commit server.json${mod.known ? "" : `, ${mod.dir}/state.json and projects.json`}, push, and apply:`,
		"     gh workflow run server.yml --repo manucruzleiva/intake-bots                    # read the dry run first",
		"     gh workflow run server.yml --repo manucruzleiva/intake-bots -f dry_run=false",
		`${mod.known ? "2" : "4"}. Registry (Reference/Publishing Standard), the mod's column:`,
		`     | Discord tickets | #${FORUM_NAME}, tag \`${mod.tag}\` |`,
		`     | Discord rol | \`${mod.tag}\` |`,
		`     | Bot de intake | sí (\`${P}\`) |`,
	);
	return lines.join("\n");
}

function main(argv) {
	const a = args(argv);
	const mod = resolveMod(a);
	const file = a.file ? resolve(a.file) : resolve(ROOT, "server.json");
	const spec = JSON.parse(readFileSync(file, "utf8"));
	const added = addMod(spec, mod);
	const errors = validate(spec);
	if (errors.length) throw new Error(`server.json would not validate:\n  ${errors.join("\n  ")}`);

	const state = resolve(ROOT, mod.dir, "state.json");
	if (!existsSync(state)) added.push(`+ ${mod.dir}/state.json (empty ledger)`);

	const mode = a.write ? "write" : "dry run";
	console.log(`bootstrap ${mod.dir} (tag "${mod.tag}") → ${file} [${mode}]: ${added.length ? `${added.length} addition(s)` : "nothing to do"}`);
	for (const line of added) console.log(line);
	if (a.write && added.length) {
		writeFileSync(file, formatJson(spec) + "\n");
		if (!existsSync(state)) {
			mkdirSync(resolve(ROOT, mod.dir), { recursive: true });
			writeFileSync(state, formatJson({ processed: [], tracked: {} }) + "\n");
		}
	} else if (added.length) {
		console.log("Dry run: nothing written. Pass --write.");
	}
	console.log(nextSteps(mod));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
}
