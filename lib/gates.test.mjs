import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolveGates } from "./gates.mjs";

test("every project that can poll has its state folder", () => {
	for (const p of resolveGates({}, true).filter((p) => p.run)) {
		assert.ok(existsSync(new URL(`../${p.dir}`, import.meta.url)), `${p.dir}/ is missing: the poll job cannot start in it`);
	}
});
