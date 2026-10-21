// The bot's other surfaces, for the status page: what the Discord server, the release cards and the
// store pages look like right now, read without writing anything. health.mjs writes it next to
// status.json as surfaces.json; the page draws the pillar cards and the per-project table from it.
//
// Where each piece comes from:
//   discord    this repo's own runs: the newest apply and dry run of server.yml, and the newest run
//              of catalog.yml (the #mods cards). server.yml only runs by hand, so its age is how long
//              the guild has gone without a look (ARCHITECTURE.md, pillar 2)
//   modrinth   api.modrinth.com through catalog.mjs's fetchModrinth: newest version, its date,
//              downloads and the published body
//   card       the last 50 messages of #announcements, read with DISCORD_TOKEN and matched by the
//              project's `announce.content` header, the same rule releases.mjs uses (cardPosted in
//              poller.mjs). Whether the newest Modrinth version has its card is the gap pillar 3's
//              phase 0 closes
//   dispatch   this repo's mod-released.yml runs, by their run-name "Mod released (<dir> v<version>)".
//              Runs from before that run-name carry no project and are left out
//   text       DESCRIPTION.md of the mod repo's default branch (MODS_GH_TOKEN) against Modrinth's
//              body, as the publish workflows send it (with or without the metadata_src rewrite).
//              "behind" is a DESCRIPTION.md edit no sync has pushed yet (pillar 4)
//
// Like backlog.mjs, nothing here may fail the health check: a source that cannot be read leaves its
// fields null, and the reason goes into `errors`, which the page shows under the table.

import { pinnedChannelId, ANNOUNCE_CHANNEL } from "./announce.mjs";
import { fetchModrinth } from "./catalog.mjs";

const UA = "intake-health (+https://github.com/manucruzleiva/intake-bots)";
const GH = "https://api.github.com";
const DISCORD = "https://discord.com/api/v10";
const RUNS_TO_READ = 50;
const CARDS_TO_READ = 50;
const RUN_NAME = /^Mod released \((\S+) v(\S+?)( · dry run)?\)$/;

async function getJson(url, headers) {
	const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`${url.replace(/\?.*/, "")} → ${res.status}`);
	return res.json();
}

const run = (r) => r && { at: r.created_at, url: r.html_url, conclusion: r.conclusion ?? r.status, title: r.display_title };

async function runs(repo, token, workflow) {
	const headers = { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
	const list = await getJson(`${GH}/repos/${repo}/actions/workflows/${workflow}/runs?per_page=${RUNS_TO_READ}`, headers);
	return list?.workflow_runs ?? [];
}

/** The release card header with the version left as a capture group. */
function headerPattern(content) {
	const [before, after = ""] = content.split("{version}");
	const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${esc(before)}(\\S+?)${esc(after)}(?:\\n|$)`);
}

/** CRLF and the trailing newline `$(cat …)` drops: the only differences a sync leaves. */
const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "");

async function description(repo, token) {
	const res = await fetch(`${GH}/repos/${repo}/contents/DESCRIPTION.md`, {
		headers: { "User-Agent": UA, Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json" },
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`DESCRIPTION.md → ${res.status}`);
	return res.text();
}

/**
 * surfaces.json: `projects` every entry of projects.json, `vars` the repo variables (for the repos
 * without `repo`), `repo` this repository, `token` its GITHUB_TOKEN, `modsToken` the PAT that reads
 * the mod repos, `discordToken` the bot's.
 */
export async function collectSurfaces(projects, vars, { repo, token, modsToken, discordToken }) {
	const errors = [];
	const settle = async (what, fn, fallback) => {
		try {
			return await fn();
		} catch (e) {
			errors.push(`${what}: ${e.message}`);
			return fallback;
		}
	};

	const [server, catalog, released] = await Promise.all(
		["server.yml", "catalog.yml", "mod-released.yml"].map((wf) => settle(wf, () => runs(repo, token, wf), null)),
	);
	const discord = {
		apply: server && run(server.find((r) => /\(apply/.test(r.display_title))),
		dry_run: server && run(server.find((r) => /\(dry run/.test(r.display_title))),
		catalog: catalog && run(catalog[0]),
	};

	let messages = null;
	if (!discordToken) errors.push("Discord: DISCORD_TOKEN is not set, so the release cards are unknown");
	else {
		messages = await settle("#announcements", async () => {
			const list = await getJson(`${DISCORD}/channels/${pinnedChannelId(ANNOUNCE_CHANNEL)}/messages?limit=${CARDS_TO_READ}`, {
				Authorization: `Bot ${discordToken}`,
			});
			return list ?? [];
		}, null);
	}

	const rows = await Promise.all(projects.map(async (p) => {
		const links = p.announce?.links || {};
		const row = {
			dir: p.dir,
			name: p.name,
			intake: p.intake !== false,
			announces: Boolean(p.announce),
			links: { modrinth: links.modrinth || null, curseforge: links.curseforge || null, wiki: links.wiki || null },
			modrinth: null,
			card: null,
			dispatch: null,
			text: null,
		};

		let body = null;
		if (links.modrinth) {
			const m = await settle(`${p.name} on Modrinth`, () => fetchModrinth(links.modrinth), undefined);
			// null: a 404, a project still in review. undefined: could not be read.
			if (m === null) row.modrinth = { state: "review" };
			else if (m) {
				row.modrinth = { state: "live", version: m.version, released_at: m.version_at, downloads: m.downloads };
				body = m.body;
			}
		}

		if (p.announce) {
			if (messages) {
				const pattern = headerPattern(p.announce.content);
				// Newest first, as Discord returns them.
				const last = messages.find((msg) => pattern.test(msg.content || ""));
				row.card = {
					last: last ? { version: last.content.match(pattern)[1], at: last.timestamp } : null,
					// Within the messages read: an older card scrolled out reads as missing.
					current: row.modrinth?.version ? messages.some((msg) => msg.content?.match(pattern)?.[1] === row.modrinth.version) : null,
				};
			}
			const dispatch = released?.find((r) => RUN_NAME.exec(r.display_title)?.[1] === p.dir && !RUN_NAME.exec(r.display_title)[3]);
			if (dispatch) row.dispatch = { ...run(dispatch), version: RUN_NAME.exec(dispatch.display_title)[2] };
		}

		const modRepo = p.repo || (p.prefix && vars[`${p.prefix}_GH_REPO`]) || null;
		if (body !== null && modRepo && modsToken) {
			const source = await settle(`${p.name} DESCRIPTION.md`, () => description(modRepo, modsToken), undefined);
			if (source === null) row.text = "no-source";
			else if (source !== undefined) {
				const live = normalize(body);
				const sent = [source, source.replaceAll("metadata_src=curseforge", "metadata_src=modrinth")].map(normalize);
				row.text = sent.includes(live) ? "in-sync" : "behind";
			}
		}
		return row;
	}));
	if (!modsToken) errors.push("GitHub: MODS_GH_TOKEN is not set, so no DESCRIPTION.md was compared");

	return { generated_at: new Date().toISOString(), discord, projects: rows, errors };
}
