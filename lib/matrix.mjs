// Builds the intake workflow's job matrix from ../projects.json and decides, per project, whether
// its gate lets it run. The gate is resolved here and not in the poll job because a job-level `if:`
// is evaluated before the matrix is expanded, so it cannot see which project it belongs to.
//
// Env (set by the workflow):
//   REPO_VARS   toJSON(vars) — every repository variable, so a gate can read `<PREFIX>_*` by name
//   EVENT_NAME  github.event_name
//
// Gates:
//   enabled-var  runs on a manual dispatch, or when <PREFIX>_INTAKE_ENABLED is "true"
//   channel-set  runs only once <PREFIX>_TICKETS_CHANNEL_ID has a value (the forum exists)
//
// A gated-off project stays in the matrix with run=false, so its row says why instead of vanishing.

import { readFileSync, appendFileSync } from "node:fs";

const projects = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));
const vars = JSON.parse(process.env.REPO_VARS || "{}");
const dispatched = process.env.EVENT_NAME === "workflow_dispatch";

const GATES = {
	"enabled-var": (p) => {
		const name = `${p.prefix}_INTAKE_ENABLED`;
		if (dispatched) return [true, "manual dispatch bypasses " + name];
		return vars[name] === "true" ? [true, name + " is true"] : [false, name + " is not 'true'"];
	},
	"channel-set": (p) => {
		const name = `${p.prefix}_TICKETS_CHANNEL_ID`;
		return vars[name] ? [true, name + " is set"] : [false, name + " is empty"];
	},
};

const include = projects.map((p) => {
	for (const key of ["dir", "name", "prefix", "ua"]) {
		if (!p[key]) throw new Error(`projects.json: ${p.dir || "?"} is missing "${key}"`);
	}
	let run = true;
	let reason = "no gate";
	if (p.gate) {
		const gate = GATES[p.gate];
		if (!gate) throw new Error(`projects.json: ${p.dir} has unknown gate "${p.gate}"`);
		[run, reason] = gate(p);
	}
	console.log(`${p.dir}: ${run ? "run" : "skip"} (${reason})`);
	return { dir: p.dir, name: p.name, prefix: p.prefix, ua: p.ua, skipBeforeId: p.skipBeforeId || "", run, reason };
});

const out = process.env.GITHUB_OUTPUT;
const line = `matrix=${JSON.stringify({ include })}\n`;
if (out) appendFileSync(out, line);
else process.stdout.write(line);
