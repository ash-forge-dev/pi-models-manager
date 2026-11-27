// Discovery tests: a real HTTP server serving both a metadata-rich `/v1/models`
// payload (LocalDesk style) and a minimal OpenAI-compatible one, to prove the
// mapping is generic and that nothing provider-specific is required.
//
//   node test/discovery.mjs [installDir]
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findInstall } from "./install.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = dirname(HERE);
const INSTALL = findInstall(process.argv[2]);
const { createJiti } = await import(join(INSTALL, "jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(INSTALL, "@earendil-works/pi-coding-agent/dist/index.js"),
		"@earendil-works/pi-tui": join(INSTALL, "@earendil-works/pi-tui/dist/index.js"),
		"@earendil-works/pi-ai/providers/all": join(INSTALL, "@earendil-works/pi-ai/dist/providers/all.js"),
	},
	interopDefault: true,
});
const discovery = await jiti.import(join(EXT, "lib/discovery.ts"));

const failures = [];
const check = (label, ok, detail) => {
	if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

// ------------------------------------------------------- metadata-rich payload

const localDesk = {
	data: [
		{
			id: "vendor::chat",
			reasoning: { supported_efforts: ["none", "low", "medium", "high"], default_enabled: true },
			localdesk: {
				kind: "chat",
				display_name: "deepseek",
				arch: "deepseek_v3",
				capabilities: ["tool_use", "vision"],
				vision: true,
				loaded: true,
				context_length: 262144,
				loaded_context_length: 1048576,
			},
		},
		{
			id: "vendor::always-thinks",
			reasoning: { supported_efforts: [], mandatory: true },
			localdesk: { kind: "chat", display_name: "always-thinks", loaded: true, context_length: 131072 },
		},
		{
			id: "some-embedding",
			localdesk: { kind: "embedding", display_name: "embed" },
		},
		{
			id: "unloaded-model",
			localdesk: { kind: "chat", display_name: "gemma", loaded: false, context_length: 32768 },
		},
	],
};

const rich = discovery.mapModels(localDesk, { compat: { supportsStore: false } });
const byId = (id) => rich.find((model) => model.id === id);

check("maps every chat model, skips non-chat kinds", rich.length === 3, rich.map((m) => m.id).join(", "));
check("prefers the loaded context length", byId("vendor::chat")?.contextWindow === 1048576, String(byId("vendor::chat")?.contextWindow));
check("uses display_name for the label", byId("vendor::chat")?.name === "deepseek", byId("vendor::chat")?.name);
check("detects vision from capabilities", JSON.stringify(byId("vendor::chat")?.input) === '["text","image"]', JSON.stringify(byId("vendor::chat")?.input));
check("marks reasoning models", byId("vendor::chat")?.reasoning === true);
check(
	"maps supported efforts onto pi levels",
	JSON.stringify(byId("vendor::chat")?.thinkingLevelMap) ===
		JSON.stringify({ off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }),
	JSON.stringify(byId("vendor::chat")?.thinkingLevelMap),
);
check(
	"an empty effort list still means reasoning when mandatory",
	byId("vendor::always-thinks")?.reasoning === true && byId("vendor::always-thinks")?.thinkingLevelMap === undefined,
	JSON.stringify(byId("vendor::always-thinks")),
);
check("off is unsupported when thinking is mandatory", discovery.mapModels({
	data: [{ id: "m", reasoning: { supported_efforts: ["low"], mandatory: true }, localdesk: { kind: "chat" } }],
})[0]?.thinkingLevelMap?.off === null);
check("unloaded models are labelled", byId("unloaded-model")?.name === "gemma (not loaded)", byId("unloaded-model")?.name);
check("provider compat is copied onto each model", JSON.stringify(byId("vendor::chat")?.compat) === '{"supportsStore":false}', JSON.stringify(byId("vendor::chat")?.compat));
check("defaults are applied when a limit is missing", byId("vendor::always-thinks")?.maxTokens === 16384, String(byId("vendor::always-thinks")?.maxTokens));
check("loaded models sort first", rich[0]?.id === "vendor::chat" || rich[0]?.id === "vendor::always-thinks", rich.map((m) => m.id).join(", "));

// --------------------------------------------------------- minimal payload

const minimal = discovery.mapModels({
	object: "list",
	data: [
		{ id: "qwen3-coder", object: "model", owned_by: "library" },
		{ id: "qwen3-coder", object: "model", owned_by: "library" },
		{ id: "llama-3.2", object: "model" },
	],
});
check("minimal OpenAI payload maps", minimal.length === 2, minimal.map((m) => m.id).join(", "));
check("duplicate ids are deduped", minimal.filter((m) => m.id === "qwen3-coder").length === 1);
check("falls back to a conservative context default", minimal[0]?.contextWindow === 32768, String(minimal[0]?.contextWindow));
check("falls back to pi's maxTokens default", minimal[0]?.maxTokens === 16384, String(minimal[0]?.maxTokens));
check("no phantom reasoning", minimal.every((m) => m.reasoning === false));
check("text-only input", minimal.every((m) => JSON.stringify(m.input) === '["text"]'));

check("bare string arrays are accepted", discovery.mapModels(["a/b", "c/d"]).length === 2);
check("`models` key is accepted", discovery.mapModels({ models: [{ id: "x" }] }).length === 1);
check("explicit defaults win", discovery.mapModels({ data: [{ id: "x" }] }, { defaultContextWindow: 32768, defaultMaxTokens: 4096 })[0]?.maxTokens === 4096);
check("entries without an id are dropped", discovery.mapModels({ data: [{ object: "model" }, "  "] }).length === 0);

// ------------------------------------------------------------ real HTTP round trip

const server = createServer((request, response) => {
	if (request.headers.authorization !== "Bearer secret") {
		response.writeHead(401, { "content-type": "application/json" });
		response.end('{"error":"unauthorized"}');
		return;
	}
	if (request.url === "/v1/models") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(localDesk));
		return;
	}
	response.writeHead(404);
	response.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

try {
	const ok = await discovery.discoverModels({ baseUrl, apiKey: "secret" });
	check("GET /models succeeds with a bearer key", ok.error === undefined && ok.models.length === 3, ok.error ?? ok.models.map((m) => m.id).join(", "));

	const unauthorized = await discovery.discoverModels({ baseUrl, apiKey: "wrong" });
	check("a 401 is reported, not thrown", unauthorized.error?.includes("401") === true && unauthorized.models.length === 0, unauthorized.error);

	const unreachable = await discovery.discoverModels({ baseUrl: "http://127.0.0.1:9/v1" });
	check("an unreachable endpoint is reported, not thrown", typeof unreachable.error === "string" && unreachable.models.length === 0, unreachable.error);

	const noBase = await discovery.discoverModels({});
	check("a missing baseUrl is reported", noBase.error === "provider has no baseUrl", noBase.error);
} finally {
	server.close();
}

console.log("");
if (failures.length > 0) {
	console.log(`${failures.length} failure(s):`);
	for (const failure of failures) console.log(` - ${failure}`);
	process.exitCode = 1;
} else {
	console.log("all checks passed");
}
