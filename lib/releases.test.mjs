// node --test lib/releases.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { releasedIn } from "./releases.mjs";

test("releasedIn finds the released section naming the issue, never Unreleased", () => {
	const log = "# Changelog\n\n## [Unreleased]\n- Fix (#9)\n\n## [2.1.0] - 2026-11-01\n- Fix (#7)\n\n## [2.0.0]\n- Old (#3)\n";
	assert.equal(releasedIn(log, 7), "2.1.0");
	assert.equal(releasedIn(log, 3), "2.0.0");
	assert.equal(releasedIn(log, 9), null);
	assert.equal(releasedIn(log, 70), null);
});
