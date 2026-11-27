// Loads this extension through pi's *own* extension loader, not a hand-rolled
// jiti setup. That is what proves the packaged form works: pi supplies the
// virtual modules (@earendil-works/pi-coding-agent, pi-tui, pi-ai/providers/all),
// transpiles the TypeScript, and calls the default export.
//
//   node test/loader.mjs [installDir]
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSandboxed, findInstall, makeSandbox } from "./install.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = dirname(HERE);

const INSTALL = findInstall(process.argv[2]);
const sandbox = makeSandbox("models-manager-loader-");

const failures = [];
const check = (label, ok, detail) => {
	if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

try {
	process.env.PI_CODING_AGENT_DIR = sandbox.agentDir;
	const pi = await import(join(INSTALL, "@earendil-works/pi-coding-agent/dist/index.js"));

	const resolvedAgentDir = assertSandboxed(() => pi.getAgentDir());
	console.log(`install: ${INSTALL}`);
	console.log(`sandbox: ${sandbox.dir}\n`);

	// 1. The package manifest must point at a file that exists. pi resolves a
	//    directory under extensions/ by `pi.extensions` first, then index.ts.
	const manifest = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8"));
	const manifestEntries = manifest.pi?.extensions;
	check("package.json declares a pi.extensions manifest", Array.isArray(manifestEntries) && manifestEntries.length > 0, JSON.stringify(manifest.pi));
	if (Array.isArray(manifestEntries) && manifestEntries.length > 0) {
		for (const entry of manifestEntries) {
			const target = resolve(EXT, entry);
			let exists = true;
			try {
				readFileSync(target);
			} catch {
				exists = false;
			}
			check(`manifest entry resolves: ${entry}`, exists, target);
		}
	}
	// The no-manifest path (dir with index.ts) must also work, so the extension
	// keeps loading if someone strips package.json.
	check("index.ts exists for directory auto-discovery", (() => {
		try {
			readFileSync(join(EXT, "index.ts"));
			return true;
		} catch {
			return false;
		}
	})());

	// 2. pi's real loader must accept it and register both commands.
	mkdirSync(resolvedAgentDir, { recursive: true });
	const result = await pi.discoverAndLoadExtensions([join(EXT, "index.ts")], EXT, resolvedAgentDir);
	for (const error of result.errors) console.log(`  loader error: ${error.path}: ${error.error}`);
	check("no loader errors", result.errors.length === 0, JSON.stringify(result.errors));
	check("one extension loaded", result.extensions.length === 1, `got ${result.extensions.length}`);

	const extension = result.extensions[0];
	if (extension) {
		const commands = [...extension.commands.keys()];
		check("registers /models-manager", extension.commands.has("models-manager"), commands.join(", "));
		check("registers /mm", extension.commands.has("mm"), commands.join(", "));
		check("registers no tools (UI only)", extension.tools.size === 0, [...extension.tools.keys()].join(", "));
		check("registers the session_start discovery hook", extension.handlers.has("session_start"), [...extension.handlers.keys()].join(", "));
		check("adds no other event handlers", extension.handlers.size === 1, [...extension.handlers.keys()].join(", "));
	}
} finally {
	rmSync(sandbox.dir, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`${failures.length} failure(s):`);
	for (const failure of failures) console.log(` - ${failure}`);
	process.exitCode = 1;
} else {
	console.log("all checks passed");
}
