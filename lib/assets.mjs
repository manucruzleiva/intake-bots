// Re-hosts the images of a Discord report on an orphan branch of the mod repo, so they outlive the
// Discord link: an attachment URL is signed and dies 24 h after the message, and every screenshot on a
// `[Discord]` issue used to turn into a broken image the next day.
//
// The branch is `intake-assets` of the issues repo itself. The mod repos are private, so a
// `/raw/intake-assets/…` link renders for anyone logged in with access and is a 404 for everyone else —
// GitHub does not proxy github.com links through camo, the reader's browser fetches them with its own
// session (intake-bots#7). intake-bots itself is public and would publish the reporter's screenshot.
//
// Every commit carries `[skip ci]`: some mod repos build on a push to any branch. The path is
// `<threadId>/<attachmentId>-<filename>`, unique per attachment, so a retry after a failed issue or
// comment finds its file already there instead of writing it twice. A failed upload never blocks
// filing: that image keeps its Discord link, with a warning.

const BRANCH = "intake-assets";
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

export const isImage = (att) => IMAGE.test(att?.filename || "");

const assetPath = (threadId, att) => `${threadId}/${att.id}-${(att.filename || "file").replace(/[^\w.-]+/g, "_")}`;
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
const message = (what) => `intake: ${what} [skip ci]`;

/**
 * `send(method, path, body)` is the poller's GitHub call; a failure throws an Error with `status`.
 * Whether the branch exists is asked once per run, the first time it matters.
 */
export function assetStore({ repo, send, get, ua, dryRun }) {
	let branch; // Promise<boolean>: does the branch exist yet

	const exists = () =>
		(branch ??= get(`/repos/${repo}/git/ref/heads/${BRANCH}`).then(
			() => true,
			(e) => {
				if (e.status === 404) return false;
				throw e;
			},
		));

	/** First write to the repo: blob, tree and a parentless commit, then the ref. */
	async function createBranch(path, content) {
		const blob = await send("POST", `/repos/${repo}/git/blobs`, { content, encoding: "base64" });
		const tree = await send("POST", `/repos/${repo}/git/trees`, { tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }] });
		const commit = await send("POST", `/repos/${repo}/git/commits`, { message: message(path), tree: tree.sha, parents: [] });
		await send("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
	}

	async function put(path, content) {
		try {
			await send("PUT", `/repos/${repo}/contents/${encodePath(path)}`, { message: message(path), content, branch: BRANCH });
		} catch (e) {
			// A 422 is what a file already there gets (no sha given): a retry of an earlier run.
			if (e.status !== 422) throw e;
			await get(`/repos/${repo}/contents/${encodePath(path)}?ref=${BRANCH}`).catch(() => {
				throw e;
			});
		}
	}

	async function upload(path, url) {
		const res = await fetch(url, { headers: { "User-Agent": ua } });
		if (!res.ok) throw new Error(`Discord CDN ${res.status}`);
		const content = Buffer.from(await res.arrayBuffer()).toString("base64");
		if (await exists()) return put(path, content);
		try {
			await createBranch(path, content);
			branch = Promise.resolve(true);
		} catch (e) {
			// Another run made the ref in between: the branch is there now.
			if (e.status !== 422) throw e;
			branch = Promise.resolve(true);
			await put(path, content);
		}
	}

	return {
		/** The images of these messages, re-hosted: attachment id -> the link the issue should use. */
		async rehost(threadId, msgs) {
			const urls = new Map();
			for (const att of msgs.flatMap((m) => m?.attachments || []).filter(isImage)) {
				const path = assetPath(threadId, att);
				const link = `https://github.com/${repo}/raw/${BRANCH}/${encodePath(path)}`;
				if (dryRun) {
					console.log(`[dry run] would re-host ${att.filename} at ${BRANCH}/${path}`);
					urls.set(att.id, link);
					continue;
				}
				try {
					await upload(path, att.url);
					urls.set(att.id, link);
				} catch (e) {
					if (e.fatal) throw e;
					console.log(`::warning::image ${att.filename} of thread ${threadId} not re-hosted, keeps its Discord link: ${e.message}`);
				}
			}
			return urls;
		},

		/** Removes a thread's folder from the branch. Already gone (or never made) counts as done. */
		async remove(threadId) {
			let files;
			try {
				files = await get(`/repos/${repo}/contents/${threadId}?ref=${BRANCH}`);
			} catch (e) {
				if (e.status === 404) return 0;
				throw e;
			}
			for (const f of files) {
				try {
					await send("DELETE", `/repos/${repo}/contents/${encodePath(f.path)}`, { message: message(`remove ${f.path}`), sha: f.sha, branch: BRANCH });
				} catch (e) {
					if (e.status !== 404) throw e;
				}
			}
			return files.length;
		},
	};
}
