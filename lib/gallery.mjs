// Store gallery sync, shared by every mod's publish.yml through .github/workflows/gallery.yml.
// The mod repo's art/gallery/gallery.json is the source; this makes the Modrinth gallery equal to its
// non-placeholder entries, the way DESCRIPTION.md is pushed to the store text.
//
//   node lib/gallery.mjs <modrinth-project-id> [--dir art/gallery] [--dry-run]
//
// gallery.json is an array of { file, title, description, featured, ordering, placeholder }. `file` is
// relative to the manifest. An image not taken yet is a grey 16:9 placeholder PNG with
// `"placeholder": true`: it is never uploaded, and the run lists it as missing.
//
// An entry is matched to its Modrinth image by `title`, so titles must be unique. A changed image under
// the same title is caught by its sha1: Modrinth names the file it stores after the sha1 of the bytes
// uploaded (`.../images/<sha1>.png`), which is not always the sha1 of what its CDN serves back — it
// re-encodes some — so the comparison is against the local file, never against a download. On a
// mismatch the new image goes up first and the old one is deleted after.
//
// Order of writes: uploads, then patches (featured last: Modrinth keeps one featured image and moves
// the flag), then deletes. Nothing changed means no write at all. --dry-run prints the plan, needs no
// token and touches nothing.
//
// CurseForge has no gallery endpoint: every image added or replaced here is listed in a ::notice:: to
// upload there by hand, like the description.
//
// Env: MODRINTH_TOKEN (PROJECT_WRITE). Unset → the run is a dry run with a warning.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.modrinth.com/v2";
const UA = "intake-bots-gallery (+https://github.com/manucruzleiva/intake-bots)";
const MAX_BYTES = 5 * 1024 * 1024;
const EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

export function loadManifest(dir) {
	const path = join(dir, "gallery.json");
	if (!existsSync(path)) return null;
	const entries = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(entries)) throw new Error(`${path} must be a JSON array`);
	const errors = [];
	const titles = new Set();
	entries.forEach((e, i) => {
		const where = `${path}[${i}]`;
		if (!e.title) errors.push(`${where}: no title`);
		else if (titles.has(e.title)) errors.push(`${where}: duplicate title "${e.title}"`);
		titles.add(e.title);
		if (!e.file) return errors.push(`${where}: no file`);
		const file = join(dir, e.file);
		if (!existsSync(file)) return errors.push(`${where}: ${e.file} does not exist`);
		if (e.placeholder) return;
		const ext = extname(file).slice(1).toLowerCase();
		if (!EXTS.has(ext)) errors.push(`${where}: .${ext} is not an image Modrinth takes`);
		if (statSync(file).size > MAX_BYTES) errors.push(`${where}: ${e.file} is over 5 MiB`);
	});
	if (entries.filter((e) => e.featured && !e.placeholder).length > 1) {
		errors.push(`${path}: more than one featured image`);
	}
	if (errors.length) throw new Error(errors.join("\n"));
	return entries.map((e) => ({ ...e, path: join(dir, e.file) }));
}

const sha1 = (path) => createHash("sha1").update(readFileSync(path)).digest("hex");
const storedSha1 = (item) => /\/images\/([0-9a-f]{40})\./.exec(item.raw_url || item.url)?.[1] ?? null;
const norm = (s) => (s ?? "").trim();

// The writes that make `remote` (Modrinth's gallery) equal to the manifest's real entries.
export function plan(entries, remote) {
	const wanted = entries.filter((e) => !e.placeholder);
	const byTitle = new Map();
	const deletes = [];
	for (const item of remote) {
		if (byTitle.has(item.title)) deletes.push({ item, why: "duplicate title" });
		else byTitle.set(item.title, item);
	}
	const uploads = [];
	const patches = [];
	for (const e of wanted) {
		const item = byTitle.get(e.title);
		byTitle.delete(e.title);
		if (!item) {
			uploads.push({ entry: e, why: "new" });
			continue;
		}
		const stored = storedSha1(item);
		if (stored && stored !== sha1(e.path)) {
			uploads.push({ entry: e, why: "image changed" });
			deletes.push({ item, why: "replaced" });
			continue;
		}
		const changed = [];
		if (norm(e.description) !== norm(item.description)) changed.push("description");
		if ((e.ordering ?? 0) !== (item.ordering ?? 0)) changed.push("ordering");
		if (!!e.featured !== !!item.featured) changed.push("featured");
		if (changed.length) patches.push({ entry: e, item, changed });
	}
	for (const item of byTitle.values()) deletes.push({ item, why: "not in the manifest" });
	patches.sort((a, b) => !!a.entry.featured - !!b.entry.featured);
	return { uploads, patches, deletes };
}

function query(params) {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
	}
	return q.toString();
}

async function write(token, method, path, body, contentType) {
	const headers = { Authorization: token, "User-Agent": UA };
	if (contentType) headers["Content-Type"] = contentType;
	const res = await fetch(`${API}${path}`, { method, headers, body });
	if (res.status !== 204) {
		throw new Error(`Modrinth ${method} ${path.split("?")[0]} failed (HTTP ${res.status}): ${await res.text()}`);
	}
}

const fields = (e) => ({
	featured: !!e.featured,
	title: e.title,
	description: e.description,
	ordering: e.ordering ?? 0,
});

async function apply(token, projectId, { uploads, patches, deletes }) {
	const gallery = `/project/${projectId}/gallery`;
	for (const { entry } of uploads) {
		const ext = extname(entry.path).slice(1).toLowerCase();
		await write(token, "POST", `${gallery}?${query({ ext, ...fields(entry) })}`, readFileSync(entry.path), `image/${ext === "jpg" ? "jpeg" : ext}`);
	}
	for (const { entry, item } of patches) {
		await write(token, "PATCH", `${gallery}?${query({ url: item.url, ...fields(entry) })}`);
	}
	for (const { item } of deletes) {
		await write(token, "DELETE", `${gallery}?${query({ url: item.url })}`);
	}
}

export async function main(argv) {
	const dirAt = argv.indexOf("--dir");
	const dir = dirAt >= 0 ? argv[dirAt + 1] : "art/gallery";
	const projectId = argv.filter((a, i) => !a.startsWith("--") && (dirAt < 0 || i !== dirAt + 1))[0];
	const token = process.env.MODRINTH_TOKEN;
	let dryRun = argv.includes("--dry-run");
	if (!projectId) {
		console.log("usage: node lib/gallery.mjs <modrinth-project-id> [--dir art/gallery] [--dry-run]");
		return 2;
	}

	const entries = loadManifest(dir);
	if (!entries) {
		console.log(`::notice::No ${dir}/gallery.json in this repo — gallery sync skipped.`);
		return 0;
	}
	if (!token && !dryRun) {
		console.log("::warning::MODRINTH_TOKEN is not set — the gallery sync only prints its plan.");
		dryRun = true;
	}

	const res = await fetch(`${API}/project/${projectId}`, { headers: { "User-Agent": UA } });
	if (res.status !== 200) throw new Error(`Modrinth GET /project/${projectId} failed (HTTP ${res.status})`);
	const remote = (await res.json()).gallery ?? [];

	const p = plan(entries, remote);
	for (const { entry, why } of p.uploads) console.log(`upload  "${entry.title}" (${why})`);
	for (const { entry, changed } of p.patches) console.log(`patch   "${entry.title}" (${changed.join(", ")})`);
	for (const { item, why } of p.deletes) console.log(`delete  "${item.title}" (${why})`);
	const writes = p.uploads.length + p.patches.length + p.deletes.length;
	console.log(writes ? `${writes} write(s)${dryRun ? " planned (dry run)" : ""}.` : "The Modrinth gallery already matches the manifest.");

	if (writes && !dryRun) await apply(token, projectId, p);

	const missing = entries.filter((e) => e.placeholder).map((e) => e.title);
	if (missing.length) console.log(`::notice::${missing.length} gallery image(s) still placeholders: ${missing.join(" · ")}`);
	if (p.uploads.length) {
		const hand = p.uploads.map(({ entry }) => `${entry.file} ("${entry.title}")`).join(" · ");
		console.log(`::notice::CurseForge has no gallery API — upload by hand: ${hand}`);
	}
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// exitCode, not exit(): on Windows, exit() with fetch's sockets still open trips a libuv assert.
	main(process.argv.slice(2)).then(
		(code) => (process.exitCode = code),
		(e) => {
			for (const line of e.message.split("\n")) console.log(`::error::${line}`);
			process.exitCode = 1;
		},
	);
}
