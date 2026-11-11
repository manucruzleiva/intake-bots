// node --test lib/surfaces.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mainVersion, newer } from "./surfaces.mjs";

test("mainVersion reads mod_version or modVersion, and null without either", () => {
	assert.equal(mainVersion("foo=1\nmod_version=2.0.138\n"), "2.0.138");
	assert.equal(mainVersion("modVersion=5.1.0\nmavenGroup=x"), "5.1.0");
	assert.equal(mainVersion("archivesBaseName=x\n"), null);
	assert.equal(mainVersion(null), null);
});

test("newer compares semver, not text, and a release beats its own beta", () => {
	assert.equal(newer("2.0.10", "2.0.9"), true);
	assert.equal(newer("2.0.9", "2.0.10"), false);
	assert.equal(newer("2.0.0", "2.0.0"), false);
	assert.equal(newer("1.0.0", "1.0.0-beta"), true);
	assert.equal(newer("1.0.0-beta", "1.0.0"), false);
	assert.equal(newer("0.0.17", "0.0.16"), true);
});
