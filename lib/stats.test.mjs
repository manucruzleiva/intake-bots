// node --test lib/stats.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mergeApps } from "./stats.mjs";

test("mergeApps keeps a day's last total and merges the 14-day views window", () => {
	const prior = { pab: { downloads: { "2026-11-09": 10 }, views: { "2026-10-20": [3, 1], "2026-11-08": [5, 2] } } };
	const next = mergeApps(prior, [{ dir: "pab", downloads: 12, views: { "2026-11-08": [6, 3], "2026-11-09": [4, 4] } }], "2026-11-10T12:00:00Z");
	assert.deepEqual(next.pab.downloads, { "2026-11-09": 10, "2026-11-10": 12 });
	assert.deepEqual(next.pab.views, { "2026-10-20": [3, 1], "2026-11-08": [6, 3], "2026-11-09": [4, 4] });
	assert.deepEqual(prior.pab.downloads, { "2026-11-09": 10 }, "prior is not mutated");
});

test("mergeApps: a failed fetch (null) keeps the prior days; a new app starts empty", () => {
	const prior = { ccv: { downloads: { "2026-11-09": 7 }, views: { "2026-11-09": [1, 1] } } };
	const next = mergeApps(prior, [{ dir: "ccv", downloads: null, views: null }, { dir: "tcgkb", downloads: null, views: { "2026-11-09": [9, 2] } }], "2026-11-10T00:00:00Z");
	assert.deepEqual(next.ccv, prior.ccv);
	assert.deepEqual(next.tcgkb, { downloads: {}, views: { "2026-11-09": [9, 2] } });
});

test("mergeApps sums the per-version split into the day's kinds", () => {
	const versions = { "1.0.0": { exe: 5, portable: 2, update: 40 }, "1.1.0": { exe: 3, update: 9 } };
	const next = mergeApps({}, [{ dir: "pab", downloads: 10, versions, views: null }], "2026-11-10T00:00:00Z");
	assert.deepEqual(next.pab.kinds, { "2026-11-10": { exe: 8, portable: 2, update: 49 } });
	assert.deepEqual(next.pab.versions, versions);
});
