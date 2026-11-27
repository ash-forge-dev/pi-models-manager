// Headless test for models-manager.
//
//   node test/headless.mjs [installDir]
//
// Loads the real extension through pi's own TypeScript loader (jiti), with pi's
// virtual modules aliased to an installed pi, then drives the TUI component with
// scripted keystrokes against a throwaway agent directory.
//
// It refuses to run unless the resolved agent dir is under the temp dir, so a
// mistake cannot edit real config.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSandboxed, findInstall, makeSandbox } from "./install.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = dirname(HERE);

const INSTALL = findInstall(process.argv[2]);
const { createJiti } = await import(join(INSTALL, "jiti/lib/jiti.mjs"));

const { agentDir, cwd } = makeSandbox("models-manager-");
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(INSTALL, "@earendil-works/pi-coding-agent/dist/index.js"),
		"@earendil-works/pi-tui": join(INSTALL, "@earendil-works/pi-tui/dist/index.js"),
		"@earendil-works/pi-ai/providers/all": join(INSTALL, "@earendil-works/pi-ai/dist/providers/all.js"),
	},
	interopDefault: true,
	moduleCache: false,
});

const pi = await jiti.import(join(INSTALL, "@earendil-works/pi-coding-agent/dist/index.js"));
const tui = await jiti.import(join(INSTALL, "@earendil-works/pi-tui/dist/index.js"));
const extension = await jiti.import(join(EXT, "index.ts"));

// ---------------------------------------------------------------- guard rails

const resolved = assertSandboxed(() => pi.getAgentDir());

const failures = [];
const check = (label, ok, detail) => {
	if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

// ------------------------------------------------------------------- fixtures

const chat = (provider, id, extra = {}) => ({
	id,
	name: id,
	provider,
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:9/v1",
	contextWindow: 262144,
	maxTokens: 50000,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	...extra,
});

const providerModels = [
	chat("local-endpoint", "vendor::chat", { reasoning: true, contextWindow: 1048576, maxTokens: 100000, input: ["text", "image"] }),
	chat("local-endpoint", "vendor::reasoner", { reasoning: true }),
	chat("local-endpoint", "vendor/big-model", { reasoning: true }),
];

const baseModelsJson = () => ({
	$schema: "https://pi.dev/schemas/models.schema.json",
	providers: {
		"local-endpoint": {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			apiKey: "test-key-123456",
			compat: { supportsStore: false, thinkingFormat: "qwen-chat-template" },
			piGuiCustomEndpoint: true,
			modelOverrides: { "vendor::reasoner": { maxTokens: 1234 } },
		},
	},
});

/** Registry stub that, like pi, applies models.json modelOverrides last. */
function makeRegistry() {
	const builtins = [chat("anthropic", "claude-sonnet-4-5"), chat("openai", "gpt-5.2")];
	const compose = () => {
		let doc = { providers: {} };
		try {
			doc = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		} catch {
			// keep empty
		}
		return [...providerModels, ...builtins].map((model) => {
			const override = doc.providers?.[model.provider]?.modelOverrides?.[model.id];
			if (!override) return model;
			const known = {};
			for (const key of ["name", "contextWindow", "maxTokens", "reasoning", "input", "cost", "thinkingLevelMap"]) {
				if (override[key] !== undefined) known[key] = override[key];
			}
			return { ...model, ...known };
		});
	};
	return {
		getAll: compose,
		getAvailable: compose,
		getRegisteredProviderIds: () => ["local-endpoint"],
		getProviderAuthStatus: () => ({ configured: true, source: "models_json_key", label: "models.json apiKey" }),
		getProvider: (id) => ({ id, name: id, baseUrl: "http://127.0.0.1:9/v1" }),
		getProviderDisplayName: (id) => id,
		getError: () => undefined,
		refresh: async () => ({ aborted: false, errors: new Map() }),
		getApiKeyForProvider: async () => "test-key",
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, baseUrl: "http://127.0.0.1:9/v1" }),
	};
}

const theme = { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text };
const keys = { matches: () => false };

async function session(models, settings) {
	writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`);
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	const state = { component: undefined, result: undefined };
	const ui = {
		custom: async (factory) => {
			let resolve;
			const promise = new Promise((r) => (resolve = r));
			const component = await factory({ requestRender() {} }, theme, keys, (result) => {
				state.result = result;
				resolve(result);
			});
			state.component = component;
			await wait();
			return promise;
		},
		notify: () => undefined,
	};
	const commands = new Map();
	const handlers = new Map();
	const providers = new Map();
	extension.default({
		registerCommand: (name, options) => commands.set(name, options),
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider: (name, config) => providers.set(name, config),
		unregisterProvider: (name) => providers.delete(name),
	});
	const running = commands.get("mm").handler("", { mode: "tui", cwd, modelRegistry: makeRegistry(), ui });
	await wait();
	if (!state.component) throw new Error("component was not created");
	state.providers = providers;
	state.handlers = handlers;
	return {
		state,
		render: (width = 100) =>
			state.component.render(width).map((line) => line.replace(/\u001b\[[0-9;]*m/g, "")),
		press: async (...sequence) => {
			for (const key of sequence) {
				state.component.handleInput(key);
				await wait();
			}
		},
		close: async () => {
			await running;
			return state.result;
		},
	};
}

const wait = () => new Promise((r) => setTimeout(r, 40));
const readModels = () => JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
const readSettings = () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));

const DOWN = "\u001b[B";
const ENTER = "\r";
const TAB = "\t";
const ESC = "\u001b";
const SHIFT_DOWN = "\u001b[1;2B";

// -------------------------------------------------------------------- tests

console.log(`install: ${INSTALL}`);
console.log(`sandbox: ${agentDir}\n`);

// 1. Model metadata override writes only the edited key, keeps everything else.
{
	const s = await session(baseModelsJson(), {
		defaultProvider: "local-endpoint",
		defaultModel: "vendor::chat",
		enabledModels: ["local-endpoint/vendor::chat", "local-endpoint/vendor::reasoner"],
		packages: ["npm:keep-me"],
	});
	await s.press(DOWN, TAB, DOWN, DOWN, ENTER); // form → maxTokens
	await s.press("7", "7", "7", ENTER);
	const overrides = readModels().providers["local-endpoint"].modelOverrides;
	check("edit writes modelOverrides entry", overrides["vendor::reasoner"].maxTokens === 777, JSON.stringify(overrides["vendor::reasoner"]));
	check("other override keys untouched", overrides["vendor::reasoner"].name === undefined);
	check("provider compat preserved", readModels().providers["local-endpoint"].compat.thinkingFormat === "qwen-chat-template");
	check("unknown provider key preserved", readModels().providers["local-endpoint"].piGuiCustomEndpoint === true);
	check("settings packages preserved", readSettings().packages[0] === "npm:keep-me");

	await s.press("x"); // reset the focused field
	check("reset removes the override", readModels().providers["local-endpoint"].modelOverrides?.["vendor::reasoner"] === undefined, JSON.stringify(readModels().providers["local-endpoint"].modelOverrides));
	await s.press("q");
	await s.close();
}

// 2. Disabling a model materializes the scope but keeps other providers usable.
{
	const s = await session(baseModelsJson(), { defaultProvider: "local-endpoint", defaultModel: "vendor::chat" });
	await s.press(" "); // first row = vendor::chat, toggled off
	await s.press("q");
	const result = await s.close();
	const scope = readSettings().enabledModels;
	check("scope excludes the toggled model", !scope.includes("local-endpoint/vendor::chat"), JSON.stringify(scope));
	check("scope keeps the provider's other models", scope.includes("local-endpoint/vendor::reasoner") && scope.includes("local-endpoint/vendor/big-model"), JSON.stringify(scope));
	check("scope keeps built-in providers via wildcards", scope.includes("anthropic/*") && scope.includes("openai/*"), JSON.stringify(scope));
	check("closing reports a settings change", result?.settingsChanged === true);
}

// 3. Scope reorder and default model.
{
	const s = await session(baseModelsJson(), {
		defaultProvider: "local-endpoint",
		defaultModel: "vendor::reasoner",
		enabledModels: ["local-endpoint/vendor::chat", "local-endpoint/vendor::reasoner"],
	});
	await s.press(SHIFT_DOWN); // move first row down
	check("reorder swaps the scope entries", JSON.stringify(readSettings().enabledModels) === JSON.stringify(["local-endpoint/vendor::reasoner", "local-endpoint/vendor::chat"]), JSON.stringify(readSettings().enabledModels));
	// The default model is /model's business; /mm must never write it.
	const before = readSettings();
	await s.press("d");
	const after = readSettings();
	check(
		"/mm never writes defaultProvider/defaultModel",
		JSON.stringify([before.defaultProvider, before.defaultModel]) === JSON.stringify([after.defaultProvider, after.defaultModel]),
		JSON.stringify([after.defaultProvider, after.defaultModel]),
	);
	await s.press("q");
	await s.close();
}

// 4. Endpoint fields, a new provider, and the API key never rendered in full.
{
	const s = await session(baseModelsJson(), { enabledModels: ["local-endpoint/vendor::chat"] });
	await s.press("e");
	const endpointLines = s.render().join("\n");
	check("endpoint form lists baseUrl", endpointLines.includes("http://127.0.0.1:9/v1"));
	check("api key is masked", endpointLines.includes("test...3456") && !endpointLines.includes("test-key-123456"));
	await s.press(ESC, "n");
	await s.press("l", "o", "c", "a", "l", ENTER, ENTER);
	await wait();
	const providers = Object.keys(readModels().providers);
	check("new provider created from prompts", providers.includes("local") , JSON.stringify(providers));
	check("new provider has usable defaults", readModels().providers.local?.api === "openai-completions" && Boolean(readModels().providers.local?.baseUrl), JSON.stringify(readModels().providers.local));
	check("new provider has no empty modelOverrides", readModels().providers.local?.modelOverrides === undefined);
	check("new provider is adopted for discovery", s.state.providers.has("local"), [...s.state.providers.keys()].join(", "));
	await s.press("q");
	await s.close();
}

// 5. Filtering, diagnostics, and unparsable config handling.
{
	const s = await session(baseModelsJson(), { enabledModels: ["local-endpoint/vendor::chat"] });
	await s.press("/", "r", "e", "a", "s", ENTER);
	const filtered = s.render().join("\n");
	check("filter narrows the list", filtered.includes("vendor::reasoner") && !filtered.includes("vendor::chat"), filtered.split("\n")[3]);
	await s.press("v");
	await new Promise((r) => setTimeout(r, 600));
	const checks = s.render().join("\n");
	check("checks reports config parse state", checks.includes("models.json parses") && checks.includes("settings.json parses"));
	check("checks reports the unreachable endpoint", checks.includes("/models") && /✗|fetch failed|ECONNREFUSED/.test(checks));
	await s.press("q");
	await s.close();

	// A broken models.json must be reported, not overwritten: corrupt it while a
	// session is open, then attempt a write through the form.
	const broken = await session(baseModelsJson(), { enabledModels: ["local-endpoint/vendor::chat"] });
	writeFileSync(join(agentDir, "models.json"), '{ "providers": { oops\n');
	await broken.press(TAB, DOWN, DOWN, ENTER); // maxTokens edit
	await broken.press("5", "5", "5", ENTER);
	await wait();
	check(
		"broken models.json is left untouched",
		readFileSync(join(agentDir, "models.json"), "utf8") === '{ "providers": { oops\n',
	);
	check(
		"the refusal is reported in the UI",
		broken.render().join("\n").includes("refusing to overwrite"),
		broken.render().join("\n").split("\n").slice(-3).join(" | "),
	);
	await broken.press("q");
	await broken.close();
}

// 6. Render must never exceed the requested width.
{
	const s = await session(baseModelsJson(), { enabledModels: ["local-endpoint/vendor::chat"] });
	let overflow = "";
	for (const width of [40, 50, 60, 80, 100, 120, 160]) {
		for (const [index, line] of s.state.component.render(width).entries()) {
			const actual = tui.visibleWidth(line);
			if (actual > width) overflow = `width=${width} line=${index} actual=${actual}`;
		}
	}
	check("no line exceeds its width (40..160)", overflow === "", overflow);
	await s.press("q");
	await s.close();
}

// 7. Bulk endpoint defaults write plain modelOverrides for every model.
{
	const s = await session(baseModelsJson(), { enabledModels: ["local-endpoint/vendor::chat"] });
	await s.press("e");
	// Jump to the end of the endpoint form, then up one: "all maxTokens".
	await s.press("\u001b[6~", "\u001b[6~", "\u001b[6~", "\u001b[6~");
	await s.press(DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN);
	await s.press("\u001b[A", "\u001b[A"); // last field is compat (raw); step back twice to "all ctx"
	const shown = s.render().join("\n");
	await s.press(ENTER);
	await s.press("5", "0", "0", "0", "0", ENTER);
	await wait();
	const overrides = readModels().providers["local-endpoint"].modelOverrides ?? {};
	const ids = ["vendor::chat", "vendor::reasoner", "vendor/big-model"];
	check("bulk edit fills modelOverrides for every model", ids.every((id) => overrides[id]?.contextWindow === 50000), JSON.stringify(ids.map((id) => [id, overrides[id]?.contextWindow])));
	check("bulk edit preserves other override keys", overrides["vendor::reasoner"]?.maxTokens === 1234, JSON.stringify(overrides["vendor::reasoner"]));
	check("endpoint form offers bulk fields", shown.includes("all ctx") || shown.includes("all maxTokens"), shown.split("\n").slice(-6).join(" | "));
	await s.press("q");
	await s.close();
}

// 8. Discovery must not hijack a provider that already has models.
{
	const s = await session(baseModelsJson(), { enabledModels: ["local-endpoint/vendor::chat"] });
	const startHandlers = s.state.handlers.get("session_start") ?? [];
	check("session_start discovery hook is registered", startHandlers.length === 1, String(startHandlers.length));
	for (const handler of startHandlers) {
		await handler({ type: "session_start", reason: "startup" }, { cwd, modelRegistry: makeRegistry(), ui: {} });
	}
	await wait();
	// The stub registry already returns local-endpoint models, so nothing should be registered.
	check("existing provider is left alone", s.state.providers.size === 0, [...s.state.providers.keys()].join(", "));
	await s.press("q");
	await s.close();
}

// 9. Multiple endpoints: the legend, switching, and deleting one.
{
	const doc = baseModelsJson();
	doc.providers.second = { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions" };
	const s = await session(doc, { enabledModels: ["local-endpoint/vendor::chat", "second/anything"] });

	const initial = s.render().join("\n");
	check("legend explains the column flags", /R reasoning/.test(initial) && /V vision/.test(initial) && /D default/.test(initial), initial.split("\n").slice(-2).join(" | "));
	check("header advertises the endpoint count", initial.includes("1/2"), initial.split("\n")[0]);

	await s.press("]");
	check("] switches to the next endpoint", s.render()[0].includes("2/2") && s.render()[0].includes("second"), s.render()[0]);

	await s.press("e");
	const pane = s.render().join("\n");
	check("endpoint pane names the endpoint being edited", pane.includes("second"), pane.split("\n").slice(0, 4).join(" | "));

	// First press only arms the delete; any other key cancels it.
	await s.press("D");
	check("delete asks for confirmation", s.render().join("\n").includes("press D again"), s.render().join("\n").split("\n").slice(-2).join(" | "));
	await s.press("z");
	check("delete can be cancelled", Object.keys(readModels().providers).includes("second"), Object.keys(readModels().providers).join(", "));

	// Now confirm it.
	await s.press("D", "D");
	await wait();
	check("confirmed delete removes the provider block", !Object.keys(readModels().providers).includes("second"), Object.keys(readModels().providers).join(", "));
	check("delete keeps the other provider", Object.keys(readModels().providers).includes("local-endpoint"), Object.keys(readModels().providers).join(", "));
	check("delete drops that endpoint's scope patterns", JSON.stringify(readSettings().enabledModels) === JSON.stringify(["local-endpoint/vendor::chat"]), JSON.stringify(readSettings().enabledModels));
	check("delete returns to the models screen", s.render()[0].includes("Models"), s.render()[0]);

	await s.press("q");
	const result = await s.close();
	check("delete reports a settings change", result?.settingsChanged === true);
}

// ------------------------------------------------------------------- summary

console.log("");
if (failures.length > 0) {
	console.log(`${failures.length} failure(s):`);
	for (const failure of failures) console.log(` - ${failure}`);
	process.exitCode = 1;
} else {
	console.log("all checks passed");
}
