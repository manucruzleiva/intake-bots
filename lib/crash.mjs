// Crash triage (#63): read the crash in a report and say whose code it is — one of our mods, someone
// else's, or both — so a crash that is not ours is not worked on as if it were.
//
// Pure: it reads the text it is handed (the issue body, with the attached files folded in, or a
// follow-up comment), never the network. It finds the crash: a crash report's `Description:` and the
// stack under it, else the last `Encountered an unexpected exception` block of a latest.log, else a
// bare `…Exception: …` line followed by `at` frames (a stack pasted into the message). Each frame is
// attributed by package prefix (ours), by the mod id Mixin writes into a merged handler's name
// (`handler$zza000$modid$method`), by the jar NeoForge prints after it (`~[mod-1.0.jar%23...]`), or
// by its package. The exception's own message is read for resource ids too, so a datapack's script
// that killed a Cobblemon battle (`legendarymonuments:…`) names its mod although no frame does.
//
// shortcut: a stack cut by the issue body's size limit, or one behind an mclo.gs link, is not read;
// fetch the link here if reports start arriving that way.

// Our code, by package and by mod id, to the repo that fixes it.
const OURS = [
	["com.shier.midbattleexp.", "cobblemon_mid_battle_exp", "cobblemon-mid-battle-exp"],
	["com.shier.actioncombat.", "cobblemon_action_combat", "cobblemon-action-combat"],
	["com.shier.cobblemonhms.", "cobblemon_hms", "cobblemon-hms"],
	["com.shier.dittohms.", "cobblemon_hms", "cobblemon-hms"],
	["com.shier.championstraining.", "cobblemon_champions_training", "cobblemon-champions-training"],
	["com.shier.pokegyms.", "cobblemon_pokegyms", "cobblemon-pokegyms"],
	["com.shier.poketowns.", "cobblemon_poketowns", "cobblemon-poketowns"],
	["com.shier.poketrades.", "cobblemon_poketrades", "cobblemon-poketrades"],
	["com.shier.raidicons.", "cobblemon_raid_icons", "cobblemon-raid-icons"],
	["com.shier.treecarve.", "tree_carve", "tree-carve"],
	["com.routes.", "routes", "routes"],
	["com.cobblemonnuzlocke.", "cobblemon_nuzlocke", "cobblemon-nuzlocke"],
	["com.cobblemonpicnic.", "cobblemon_picnic", "cobblemon-picnic"],
];

// The game, the loaders and the libraries every stack runs through: they are where a crash passes, not who caused it.
const PLATFORM = /^(?:java|javax|jdk|sun|kotlin|kotlinx|net\.minecraft|com\.mojang|net\.fabricmc|net\.neoforged|cpw|org\.spongepowered|com\.llamalad7|com\.google|it\.unimi|io\.netty|org\.apache|org\.slf4j|com\.electronwill|dev\.architectury|thedarkcolour)\./;
const PLATFORM_IDS = new Set(["minecraft", "fabric", "fabricloader", "neoforge", "forge", "java", "mixinextras", "architectury", "kotlinforforge", "fabric_language_kotlin"]);
// Third-party packages whose name does not say the mod.
const KNOWN = [
	["com.cobblemon.", "cobblemon"],
	["qouteall.imm_ptl.", "immersive_portals"],
	["com.bedrockk.molang.", "cobblemon"], // Cobblemon's MoLang runtime
];

const FRAME = /^\s*at\s+(?:[\w.$@+-]+\/+)*([\w.$]+)\.([\w$<>]+)\(([^)]*)\)\s*(?:~?\[([^\]]*)\])?/;
const EXCEPTION = /^\s*(?:Caused by:\s*)?([a-zA-Z_$][\w$]*(?:\.[\w$]+)+(?:Exception|Error|Throwable)\b.*)$/;

/** The crash in `text`: its description, the exception line and its frames (with Caused by). Null if none. */
export function findCrash(text) {
	const lines = (text || "").split(/\r?\n/);
	let start = lines.findIndex((l) => /^\s*Description:\s/.test(l));
	let description = start >= 0 ? lines[start].replace(/^\s*Description:\s*/, "").trim() : "";
	if (start < 0) {
		start = lines.findLastIndex((l) => /Encountered an unexpected exception/.test(l));
		if (start >= 0) description = "Encountered an unexpected exception";
	}
	// Else the first exception line that has a frame under it.
	if (start < 0) start = lines.findIndex((l, i) => EXCEPTION.test(l) && FRAME.test(lines[i + 1] || "")) - 1;
	if (start < -1) return null;

	let exception = "";
	const frames = [];
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i];
		const f = FRAME.exec(l);
		if (f) {
			frames.push({ cls: f[1], method: f[2], where: f[3], jar: f[4] || "", line: l.trim() });
			continue;
		}
		if (!exception && EXCEPTION.test(l)) exception = EXCEPTION.exec(l)[1].trim();
		else if (/^\s*Caused by:|^\s*\.\.\. \d+ more|^\s*Suppressed:/.test(l)) continue;
		else if (frames.length && !l.trim()) break; // the stack ends at its first blank line
		else if (frames.length && !/^\s/.test(l) && !EXCEPTION.test(l)) break;
	}
	if (!exception || !frames.length) return null;
	return { description, exception, frames };
}

/** Whose code a frame is: { ours: repo } or { theirs: mod } or null (platform, unknown). */
export function attribute(frame) {
	const own = OURS.find(([pkg]) => frame.cls.startsWith(pkg));
	if (own) return { ours: own[2] };
	// A mixin merged into another class names its mod in the handler: handler$abc000$modid$method.
	const mixin = /^(?:handler|redirect|modify|wrapOperation|localvar|constant)\$\w+?\$([a-z][a-z0-9_]*)\$/i.exec(frame.method);
	if (mixin) return mod(mixin[1]);
	// NeoForge: ~[modname-1.2.3.jar%23123!/:?]
	const jar = /^([A-Za-z][\w.+-]*?)(?:[-_][Vv]?\d[\w.+-]*)?\.jar/.exec(frame.jar);
	if (jar && !/^(?:client|server|minecraft|neoforge|forge|fabric|loader)/i.test(jar[1])) return mod(jar[1].toLowerCase().replace(/[-_](?:fabric|neoforge|forge)$/, ""));
	if (PLATFORM.test(frame.cls)) return null;
	const known = KNOWN.find(([pkg]) => frame.cls.startsWith(pkg));
	if (known) return { theirs: known[1] };
	// Else the package says it: com.author.mod.x → mod, mod.x → mod.
	const parts = frame.cls.split(".");
	return { theirs: /^(?:com|net|org|io|dev|me|fr|de)$/.test(parts[0]) && parts.length > 2 ? parts[2] : parts[0] };
}

function mod(id) {
	const own = OURS.find(([, modId, repo]) => id === modId || id === repo);
	if (own) return { ours: own[2] };
	return PLATFORM_IDS.has(id) ? null : { theirs: id };
}

/**
 * The verdict on the crash in `text`, or null when there is none:
 * { exception, description, frame (first), culprit (first frame of ours, else of any mod), ours[], theirs[], label }.
 * Cobblemon is named among the others but only decides the verdict when no other mod is in the stack:
 * every one of our mods runs inside it.
 */
export function triage(text) {
	const crash = findCrash(text);
	if (!crash) return null;
	const ours = new Set();
	const theirs = new Set();
	let culprit = null;
	for (const f of crash.frames) {
		const who = attribute(f);
		if (!who) continue;
		if (!culprit || (who.ours && !culprit.ours)) culprit = { ...who, line: f.line };
		if (who.ours) ours.add(who.ours);
		else theirs.add(who.theirs);
	}
	// A datapack or script's resource id in the message names the mod no frame does.
	const said = `${crash.description}\n${crash.exception}`;
	for (const [, ns] of said.matchAll(/(?<![\w./:])([a-z][a-z0-9_.-]*):(?!\/\/)[a-z0-9_/.-]+/g)) {
		const who = mod(ns);
		if (!who) continue;
		if (who.ours) ours.add(who.ours);
		else theirs.add(who.theirs);
	}
	const verdict = ours.size && [...theirs].some((m) => m !== "cobblemon") ? "mixed" : ours.size ? "ours" : theirs.size ? "third-party" : "unknown";
	return {
		...crash,
		frame: crash.frames[0].line,
		culprit,
		ours: [...ours],
		theirs: [...theirs],
		verdict,
		label: ours.size ? "crash:ours" : theirs.size ? "crash:third-party" : null,
	};
}

export const CRASH_LABELS = {
	"crash:ours": { name: "crash:ours", color: "b60205", description: "The crash's stack points at one of our mods" },
	"crash:third-party": { name: "crash:third-party", color: "c5def5", description: "The crash's stack points at another mod" },
};

/** The internal comment on the issue. A third-party verdict carries a draft reply for the author to send, never sent by the bot. */
export function triageComment(t) {
	const code = (s) => "`" + s.replace(/`/g, "'").slice(0, 300) + "`";
	const lines = [
		`**Crash triage** · ${t.label ? code(t.label) : "no mod in the stack"}`,
		"",
		`- Exception: ${code(t.exception)}`,
		...(t.description ? [`- Description: ${code(t.description)}`] : []),
		`- First frame: ${code(t.frame)}`,
		...(t.culprit && t.culprit.line !== t.frame ? [`- First ${t.culprit.ours ? "frame of ours" : "mod frame"}: ${code(t.culprit.line)}`] : []),
		`- Verdict: ${
			{
				ours: `ours → ${t.ours.join(", ")}`,
				mixed: `both → ours: ${t.ours.join(", ")}; theirs: ${t.theirs.join(", ")}`,
				"third-party": `theirs → ${t.theirs.join(", ")}`,
				unknown: "only the game and the loader are in the stack",
			}[t.verdict]
		}${t.verdict === "ours" && t.theirs.length ? ` (inside ${t.theirs.join(", ")})` : ""}`,
	];
	if (t.verdict === "third-party") {
		const others = t.theirs.filter((m) => m !== "cobblemon");
		const whom = others.length ? others.join(", ") : t.theirs.join(", ");
		lines.push(
			"",
			"Draft reply (not sent — post it as a `/reply` comment if it reads right):",
			"",
			`> The crash comes from **${whom}**, not from this mod: its code is where the game stopped. Please report it to ${whom}'s author with the same crash report. If it still crashes without ${whom} installed, post here and we look again.`,
		);
	}
	return lines.join("\n");
}

// Self-check: node lib/crash.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
	const { readFileSync, readdirSync } = await import("node:fs");
	const assert = (await import("node:assert/strict")).default;
	const dir = new URL("./crash-fixtures/", import.meta.url);
	const expect = {
		"cac-mbe.txt": { label: "crash:ours", ours: ["cobblemon-mid-battle-exp", "cobblemon-action-combat"] },
		"legendary-monuments.log": { label: "crash:third-party", theirs: ["cobblemon", "legendarymonuments"] },
		"immersive-portals.txt": { label: "crash:third-party", theirs: ["immersive_portals"] },
		"neoforge-jar.txt": { label: "crash:third-party", theirs: ["waystones"] },
		"pasted.txt": { label: "crash:ours", ours: ["routes"] },
		"no-crash.txt": null,
	};
	for (const name of readdirSync(dir)) {
		const t = triage(readFileSync(new URL(name, dir), "utf8"));
		const want = expect[name];
		if (want === null) assert.equal(t, null, name);
		else {
			assert.equal(t?.label, want.label, name);
			for (const k of ["ours", "theirs"]) if (want[k]) assert.deepEqual(t[k].sort(), want[k].sort(), `${name} ${k}`);
		}
		console.log(`ok ${name}: ${t ? `${t.verdict} ${[...t.ours, ...t.theirs].join(", ")}` : "no crash"}`);
	}
	assert.equal(Object.keys(expect).length, readdirSync(dir).length, "every fixture has an expectation");
}
