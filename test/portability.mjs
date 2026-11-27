// Portability test: copy this folder somewhere isolated, point it at an endpoint it
// has never seen, and check that it discovers models with no personal config.
//
//   node test/portability.mjs [installDir]
//
// Proves the two claims that matter when moving the folder to another machine:
//   1. the copy is self-contained (every import resolves inside the copy),
//   2. discovery works from nothing but a baseUrl.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findInstall } from "./install.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = dirname(HERE);
const INSTALL = findInstall(process.argv[2]);

const failures = [];
const check = (label, ok, detail) => {
	if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const dir = mkdtempSync(join(tmpdir(), "models-manager-portable-"));
process.on("exit", () => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

try {
	// 1. A fresh copy, standing alone: no agent dir, no models.json, no cache files.
	const pkg = join(dir, "pkg");
	// A plain recursive copy, exactly what `cp -r` / `scp -r` would do.
	cpSync(EXT, join(pkg, "models-manager"), { recursive: true });
	const copiedExt = join(pkg, "models-manager");
	const copiedFiles = readdirSync(copiedExt, { recursive: true }).map(String);
	console.log(`copied ${copiedFiles.length} entries to ${relative(tmpdir(), copiedExt)}\n`);

	check("copy contains index.ts", copiedFiles.includes("index.ts"));
	check("copy contains the lib/ modules", copiedFiles.some((file) => file.startsWith("lib") && file.endsWith(".ts")));

	// The copy must not need anything from the original location.
	const sourceOf = (file) => readFileSync(join(copiedExt, file), "utf8");
	const offenders = [];
	for (const file of copiedFiles.filter((entry) => entry.endsWith(".ts"))) {
		const text = sourceOf(file);
		if (text.includes(EXT)) offenders.push(`${file} references the original path`);
		for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
			const specifier = match[1];
			if (specifier.startsWith(".") && !specifier.endsWith(".ts")) offenders.push(`${file} imports ${specifier} without .ts`);
			if (specifier.includes("/home/") || specifier.includes("\\")) offenders.push(`${file} imports an absolute path`);
		}
	}
	check("copied sources reference nothing outside the folder", offenders.length === 0, offenders.join("; "));

	// 2. A machine with only a baseUrl: fake endpoint, agent dir, one provider block.
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const server = createServer((request, response) => {
		if (request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					data: [
						{ id: "fresh-chat", localdesk: { kind: "chat", display_name: "Fresh Chat", loaded: true, context_length: 65536, vision: true } },
						{ id: "fresh-reasoner", reasoning: { supported_efforts: ["low", "high"] }, localdesk: { kind: "chat", context_length: 131072 } },
						{ id: "fresh-embed", localdesk: { kind: "embedding" } },
					],
				}),
			);
			return;
		}
		response.writeHead(404);
		response.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify({ providers: { "brand-new": { baseUrl, api: "openai-completions" } } }, null, 2)}\n`,
	);

	const { createJiti } = await import(join(INSTALL, "jiti/lib/jiti.mjs"));
	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-coding-agent": join(INSTALL, "@earendil-works/pi-coding-agent/dist/index.js"),
			"@earendil-works/pi-tui": join(INSTALL, "@earendil-works/pi-tui/dist/index.js"),
			"@earendil-works/pi-ai/providers/all": join(INSTALL, "@earendil-works/pi-ai/dist/providers/all.js"),
		},
		interopDefault: true,
		moduleCache: false,
	});
	const extension = await jiti.import(join(copiedExt, "index.ts"));

	const commands = new Map();
	const handlers = new Map();
	const providers = new Map();
	extension.default({
		registerCommand: (name, options) => commands.set(name, options),
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: (name, config) => providers.set(name, config),
	});

	check("copied extension loads", commands.has("models-manager") && commands.has("mm"), [...commands.keys()].join(", "));

	const stubRegistry = { getRegisteredProviderIds: () => [], getAll: () => [] };
	const start = handlers.get("session_start");
	check("copied extension registers the discovery hook", typeof start === "function");

	if (start) await start({ type: "session_start", reason: "startup" }, { modelRegistry: stubRegistry });
	await new Promise((resolve) => setTimeout(resolve, 50));

	const registered = providers.get("brand-new");
	check("a new endpoint is adopted automatically", Boolean(registered), [...providers.keys()].join(", "));
	const models = registered?.models ?? [];
	check("discovered only chat models", models.length === 2, models.map((model) => model.id).join(", "));
	check("discovered ids match the endpoint", models.some((model) => model.id === "fresh-chat") && models.some((model) => model.id === "fresh-reasoner"), models.map((model) => model.id).join(", "));
	check("read the reported context length", models.find((model) => model.id === "fresh-chat")?.contextWindow === 65536, String(models.find((model) => model.id === "fresh-chat")?.contextWindow));
	check("read vision", JSON.stringify(models.find((model) => model.id === "fresh-chat")?.input) === '["text","image"]');
	check("read reasoning efforts", models.find((model) => model.id === "fresh-reasoner")?.thinkingLevelMap?.high === "high", JSON.stringify(models.find((model) => model.id === "fresh-reasoner")?.thinkingLevelMap));
	check("only the endpoint's own models are registered", models.every((model) => model.id.startsWith("fresh-")), models.map((model) => model.id).join(", "));

	server.close();
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`${failures.length} failure(s):`);
	for (const failure of failures) console.log(` - ${failure}`);
	process.exitCode = 1;
} else {
	console.log("all checks passed");
}
