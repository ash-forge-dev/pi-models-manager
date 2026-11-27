// Shared test plumbing: locate an installed pi, and make throwaway agent dirs
// that clean themselves up.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Find a node_modules directory that contains an installed pi.
 *
 * Order: explicit argument, PI_TEST_INSTALL, node resolution from this file (works
 * when the extension itself lives inside a node_modules tree), the pi installer's
 * releases layout, then common global locations.
 */
export function findInstall(explicit) {
	const candidates = [];
	const looksRight = (dir) => {
		try {
			readFileSync(join(dir, "@earendil-works/pi-coding-agent/dist/index.js"));
			return true;
		} catch {
			return false;
		}
	};

	if (explicit) candidates.push(explicit);
	if (process.env.PI_TEST_INSTALL) candidates.push(process.env.PI_TEST_INSTALL);

	// Resolved from here: works when this package is installed under node_modules.
	try {
		const require = createRequire(import.meta.url);
		const pkgJson = require.resolve("@earendil-works/pi-coding-agent/package.json");
		candidates.push(pkgJson.slice(0, pkgJson.lastIndexOf("/@earendil-works/")));
	} catch {
		// not resolvable from here
	}

	// pi's own install layout.
	const releases = join(homedir(), ".pi", "agent", "install", "releases");
	try {
		const versions = readdirSync(releases).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		for (const version of versions.reverse()) candidates.push(join(releases, version, "node_modules"));
	} catch {
		// no local install layout
	}

	candidates.push(
		join(homedir(), ".pi", "agent", "npm", "node_modules"),
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
	);

	for (const candidate of candidates) {
		if (candidate && looksRight(candidate)) return candidate;
	}
	throw new Error(
		"could not locate an installed pi; pass its node_modules directory as the first argument or set PI_TEST_INSTALL",
	);
}

/**
 * Create a sandbox agent dir and register its removal on exit, so repeated test
 * runs do not litter the temp directory.
 */
export function makeSandbox(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const agentDir = join(dir, "agent");
	const cwd = join(dir, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.on("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});
	return { dir, agentDir, cwd };
}

/** Refuse to keep going if pi resolved a real agent directory. */
export function assertSandboxed(getAgentDir) {
	const resolved = getAgentDir();
	if (!resolved.startsWith(tmpdir())) {
		throw new Error(`refusing to run: agent dir resolved to ${resolved}`);
	}
	return resolved;
}
