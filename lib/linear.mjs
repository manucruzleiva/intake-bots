// Linear triage of the issues intake files (#9).
//
// Linear's GitHub integration mirrors every new issue into team COB in state `Triage`, with no project
// and no priority, and it stays there until someone sweeps it — invisible to every board and to "pick
// the highest priority". This plans the mirror instead: the project, the priority the post's kind maps
// to, and `Backlog`.
//
// The mirror is found BY ITS GITHUB URL in the Linear issue's attachments, never by title: the
// integration attaches the issue's URL to the COB it creates. It lands seconds to a minute after the
// GitHub create, so a caller that finds nothing tries again on a later run.
//
// Only what is still empty is filled: a project someone set, a priority someone set, a state someone
// moved out of Triage are theirs. And nothing is ever created here — the sync is bidirectional, and an
// issue created in Linear files a second one in GitHub.
//
// The project is named, not pinned by id, and resolved in the same request: like the forum tags, a
// name is what a human can check by reading projects.json. A renamed project fails with that name.
//
// The key is a personal API key (Linear -> Settings -> Security & access), sent bare, with no
// "Bearer": the secret LINEAR_API_KEY of this repo, loaded by cargar-secrets.ps1 from the root .env.

const API = "https://api.linear.app/graphql";

/** Linear's `priority` per post kind (workspace directive 2026-09-11). 0 is No priority: `other` is a human's call. */
export const PRIORITY = { crash: 1, bug: 2, idea: 4, feedback: 4, other: 0 };

/** How long a mirror may take before its absence is a problem: the repo is not syncing. */
export const MIRROR_WAIT_MS = 60 * 60 * 1000;

const FIND = `query($url: String!, $project: String!) {
	attachmentsForURL(url: $url) {
		nodes {
			issue {
				id identifier priority
				project { id }
				state { type }
				team { states(filter: { type: { eq: "backlog" } }) { nodes { id name position } } }
			}
		}
	}
	projects(filter: { name: { eq: $project } }) { nodes { id name } }
}`;

const UPDATE = `mutation($id: String!, $input: IssueUpdateInput!) {
	issueUpdate(id: $id, input: $input) { success }
}`;

/** One GraphQL call. Linear answers most errors with a 200 and `errors`, so both shapes throw. */
export async function linear(key, query, variables) {
	const res = await fetch(API, {
		method: "POST",
		headers: { Authorization: key, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`Linear -> ${res.status} ${text.slice(0, 300)}`);
	}
	if (!res.ok || body.errors?.length) {
		const err = new Error(`Linear -> ${res.status} ${(body.errors || []).map((e) => e.message).join("; ") || text.slice(0, 300)}`);
		// A bad key fails every call the same way: the caller stops at the first instead of repeating it.
		err.auth = res.status === 401 || (body.errors || []).some((e) => e.extensions?.code === "AUTHENTICATION_ERROR");
		throw err;
	}
	return body.data;
}

/**
 * Plan the Linear mirror of the GitHub issue at `url`: project `project`, priority `priority` (0
 * leaves it), state Backlog. Null when there is no mirror yet; otherwise its identifier and what was
 * set — an empty list when everything was already planned.
 */
export async function triageMirror(key, url, { project, priority }) {
	const data = await linear(key, FIND, { url, project });
	const issue = data.attachmentsForURL.nodes.map((a) => a.issue).find(Boolean);
	if (!issue) return null;
	const input = {};
	const changed = [];
	if (!issue.project) {
		const found = data.projects.nodes[0];
		if (!found) throw new Error(`Linear has no project named "${project}" (the \`linear\` of this project in projects.json)`);
		input.projectId = found.id;
		changed.push(`project ${found.name}`);
	}
	if (priority && !issue.priority) {
		input.priority = priority;
		changed.push(`priority ${priority}`);
	}
	if (issue.state?.type === "triage") {
		const backlog = [...issue.team.states.nodes].sort((a, b) => a.position - b.position)[0];
		if (!backlog) throw new Error(`the team of ${issue.identifier} has no backlog state`);
		input.stateId = backlog.id;
		changed.push(`state ${backlog.name}`);
	}
	if (changed.length) {
		const done = await linear(key, UPDATE, { id: issue.id, input });
		if (!done.issueUpdate?.success) throw new Error(`issueUpdate of ${issue.identifier} did not succeed`);
	}
	return { identifier: issue.identifier, changed };
}
