// node --test lib/catalog.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { assetKind, byVersion } from "./catalog.mjs";

test("assetKind tells installer, portable and update checks apart, and skips checksums", () => {
	assert.equal(assetKind("PtcglAutoBattleLog.exe"), "exe");
	assert.equal(assetKind("PtcglAutoBattleLog-portable.zip"), "portable");
	assert.equal(assetKind("update.json"), "update");
	assert.equal(assetKind("SHA256SUMS.txt"), null);
	assert.equal(assetKind("ccv-1.0.zip"), "other");
});

test("byVersion splits each release's downloads per kind, oldest first, without the v", () => {
	const releases = [
		{ tag_name: "v1.1.0", assets: [{ name: "a.exe", download_count: 3 }, { name: "update.json", download_count: 9 }] },
		{ tag_name: "v1.0.0", assets: [{ name: "a.exe", download_count: 5 }, { name: "SHA256SUMS.txt", download_count: 1 }] },
	];
	const out = byVersion(releases);
	assert.deepEqual(Object.keys(out), ["1.0.0", "1.1.0"]);
	assert.deepEqual(out["1.1.0"], { exe: 3, update: 9 });
	assert.deepEqual(out["1.0.0"], { exe: 5 });
});
