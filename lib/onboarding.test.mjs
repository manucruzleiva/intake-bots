import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate, ONBOARDING_OPTIONS_MAX } from "./server.mjs";
import { addMod, PROMPT_TITLE, MORE_PROMPT_TITLE } from "./bootstrap.mjs";

const spec = () => JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const prompt = (s, title) => s.onboarding.prompts.find((p) => p.title === title);

test("server.json keeps every onboarding prompt within Discord's option cap (#117)", () => {
	for (const p of spec().onboarding.prompts) assert.ok(p.options.length <= ONBOARDING_OPTIONS_MAX, `"${p.title}" has ${p.options.length} options`);
	assert.deepEqual(validate(spec()).filter((e) => e.startsWith("onboarding")), []);
});

test("validate refuses a prompt with a 13th option, the PUT Discord answered 400", () => {
	const s = spec();
	const p = prompt(s, PROMPT_TITLE);
	while (p.options.length <= ONBOARDING_OPTIONS_MAX) p.options.push({ title: `Mod ${p.options.length}`, channels: [], roles: [] });
	assert.ok(validate(s).some((e) => e.includes(`"${PROMPT_TITLE}"`) && e.includes("split it")));
});

test("addMod puts the option in the second mods prompt once the first is full", () => {
	// A bare spec: the real forum may be at Discord's 20-tag cap, which is not what this test is about.
	const filler = Array.from({ length: ONBOARDING_OPTIONS_MAX }, (_, i) => ({ title: `Mod ${i}`, channels: [], roles: [`Mod ${i}`] }));
	const other = { title: "Which TCG tools and apps do you use?", options: [] };
	const s = {
		channels: [{ name: "mod-tickets", type: "forum", available_tags: [] }],
		roles: [{ name: "@everyone", permissions: [] }],
		onboarding: { prompts: [{ title: PROMPT_TITLE, options: filler }, other] },
	};
	const first = prompt(s, PROMPT_TITLE);
	const added = addMod(s, { tag: "Test Mod", emoji: "🧪" });
	assert.equal(first.options.length, ONBOARDING_OPTIONS_MAX);
	const more = prompt(s, MORE_PROMPT_TITLE);
	assert.ok(more, added.join("\n"));
	assert.deepEqual(more.options.map((o) => o.roles), [["Test Mod"]]);
	// Right after the first mods prompt, and a second run adds nothing.
	const titles = s.onboarding.prompts.map((p) => p.title);
	assert.equal(titles.indexOf(MORE_PROMPT_TITLE), titles.indexOf(PROMPT_TITLE) + 1);
	assert.deepEqual(addMod(s, { tag: "Test Mod", emoji: "🧪" }), []);
	assert.deepEqual(validate(s).filter((e) => e.startsWith("onboarding")), []);
});
