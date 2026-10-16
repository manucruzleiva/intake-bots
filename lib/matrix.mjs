// Builds the intake workflow's job matrix from ../projects.json and decides, per project, whether
// its gate lets it run (lib/gates.mjs). The gate is resolved here and not in the poll job because a
// job-level `if:` is evaluated before the matrix is expanded, so it cannot see which project it
// belongs to.
//
// Env (set by the workflow):
//   REPO_VARS   toJSON(vars) — every repository variable, so a gate can read `<PREFIX>_*` by name
//   EVENT_NAME  github.event_name
//   TRIGGER     inputs.trigger — "scheduler" when intake-pacer.yml dispatched the run, empty on a schedule
//
// A gated-off project stays in the matrix with run=false, so its row says why instead of vanishing.

import { appendFileSync } from "node:fs";
import { resolveGates } from "./gates.mjs";

const vars = JSON.parse(process.env.REPO_VARS || "{}");
const manual = process.env.EVENT_NAME === "workflow_dispatch" && process.env.TRIGGER !== "scheduler";

const include = resolveGates(vars, manual).map((p) => {
	console.log(`${p.dir}: ${p.run ? "run" : "skip"} (${p.reason})`);
	return { dir: p.dir, name: p.name, prefix: p.prefix, ua: p.ua, tag: p.tag || "", skipBeforeId: p.skipBeforeId || "", run: p.run, reason: p.reason };
});

const out = process.env.GITHUB_OUTPUT;
const line = `matrix=${JSON.stringify({ include })}\n`;
if (out) appendFileSync(out, line);
else process.stdout.write(line);
