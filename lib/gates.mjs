// Which projects of ../projects.json run, and why. Shared by matrix.mjs, which turns it into the
// intake workflow's job matrix, and health.mjs, which must not call a project broken for not running
// when its gate keeps it off on purpose.
//
// Gates:
//   enabled-var  runs on a manual dispatch, or when <PREFIX>_INTAKE_ENABLED is "true". A dispatch
//                from the pacer is not manual: it fires every ~10 minutes, so letting it bypass the
//                variable would make the gate meaningless.

import { readFileSync } from "node:fs";

export const projects = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));

const GATES = {
	"enabled-var": (p, vars, manual) => {
		const name = `${p.prefix}_INTAKE_ENABLED`;
		if (manual) return [true, "manual dispatch bypasses " + name];
		return vars[name] === "true" ? [true, name + " is true"] : [false, name + " is not 'true'"];
	},
};

/** Every project with `run` and the `reason` its gate gave. `vars` is toJSON(vars) of the repo. */
export function resolveGates(vars, manual) {
	return projects.map((p) => {
		for (const key of ["dir", "name", "prefix", "ua"]) {
			if (!p[key]) throw new Error(`projects.json: ${p.dir || "?"} is missing "${key}"`);
		}
		if (!p.gate) return { ...p, run: true, reason: "no gate" };
		const gate = GATES[p.gate];
		if (!gate) throw new Error(`projects.json: ${p.dir} has unknown gate "${p.gate}"`);
		const [run, reason] = gate(p, vars, manual);
		return { ...p, run, reason };
	});
}
