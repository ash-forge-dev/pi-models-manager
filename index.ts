// models-manager: one screen for the models list of your own endpoints.
//
// It edits the files pi already understands, so nothing here is a private format:
//   ~/.pi/agent/models.json    provider connection + per-model modelOverrides
//   ~/.pi/agent/settings.json  enabledModels (cycle scope) + default model
//
// It also discovers the model list itself (`GET <baseUrl>/models`) for custom
// providers that nothing else registers, so a bare models.json provider block is
// enough to get a working model list. If another extension already registers a
// provider, that extension keeps ownership.
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRegistry,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { asObject, asStringArray } from "./lib/util.ts";
import { deleteProviderBlock, providerBlock } from "./lib/catalog.ts";
import { discoverModels } from "./lib/discovery.ts";
import { removeProviderFromScope } from "./lib/settings.ts";
import { modelsJsonPath, readJsonFile, settingsJsonPath, updateJsonFile } from "./lib/store.ts";
import { ModelsManagerComponent } from "./lib/ui.ts";
import type { ManagerHost, ManagerResult } from "./lib/ui.ts";

interface DiscoveryRegistration {
	baseUrl: string;
	api: string;
	apiKey?: string;
	headers?: Record<string, string>;
	compat?: unknown;
	lastGood: ProviderModelConfig[];
}

/** Providers this extension registered, so a refresh loop does not re-register them. */
const discovered = new Set<string>();

/**
 * Register a discovery-backed provider when nothing else owns it.
 * Returns true when this call registered the provider.
 */
async function ensureDiscovery(
	pi: ExtensionAPI,
	ctx: { modelRegistry: ModelRegistry },
	providerId: string,
): Promise<boolean> {
	const registry = ctx.modelRegistry;
	if (discovered.has(providerId)) return false;
	// Never take over a provider that already produces models: another extension
	// registered it, or models.json lists them explicitly. This check does not depend
	// on extension load order, unlike getRegisteredProviderIds().
	if (registry.getRegisteredProviderIds().includes(providerId)) return false;
	if (registry.getAll().some((model) => model.provider === providerId)) return false;

	const read = readJsonFile(modelsJsonPath());
	const block = providerBlock(asObject(read.data), providerId);
	if (!block) return false;
	// An explicit `models` list is configuration the user wrote; do not replace it.
	if (Array.isArray(block.models) && block.models.length > 0) return false;

	const baseUrl = typeof block.baseUrl === "string" ? block.baseUrl : undefined;
	if (!baseUrl) return false;

	const state: DiscoveryRegistration = {
		baseUrl,
		api: typeof block.api === "string" ? block.api : "openai-completions",
		apiKey: typeof block.apiKey === "string" ? block.apiKey : undefined,
		headers: undefined,
		compat: block.compat,
		lastGood: [],
	};
	const rawHeaders = asObject(block.headers);
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(rawHeaders)) {
		if (typeof value === "string") headers[key] = value;
	}
	if (Object.keys(headers).length > 0) state.headers = headers;

	const load = async (signal?: AbortSignal, allowNetwork = true) => {
		if (!allowNetwork) return state.lastGood;
		const result = await discoverModels(
			{ baseUrl: state.baseUrl, api: state.api, apiKey: state.apiKey, headers: state.headers, compat: state.compat },
			signal,
		);
		if (result.models.length > 0) state.lastGood = result.models;
		return result.models.length > 0 ? result.models : state.lastGood;
	};

	const models = await load();
	pi.registerProvider(providerId, {
		baseUrl: state.baseUrl,
		api: state.api as never,
		apiKey: state.apiKey,
		...(state.headers ? { headers: state.headers } : {}),
		models,
		refreshModels: (context) => load(context.signal, context.allowNetwork !== false),
	});
	discovered.add(providerId);
	return true;
}

/** Every custom provider declared in models.json (never a built-in catalog id). */
async function ensureAllDiscovery(
	pi: ExtensionAPI,
	ctx: { modelRegistry: ModelRegistry },
): Promise<void> {
	const read = readJsonFile(modelsJsonPath());
	if (read.error) return;
	const providers = asObject(asObject(read.data).providers);
	for (const providerId of Object.keys(providers)) {
		try {
			await ensureDiscovery(pi, ctx, providerId);
		} catch (error) {
			// One broken endpoint must not stop pi from starting.
			console.warn(`models-manager: discovery for ${providerId} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function openManager(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("models-manager needs interactive mode (run pi in the terminal)", "error");
		return;
	}

	const host: ManagerHost = {
		registry: ctx.modelRegistry,
		cwd: ctx.cwd,
		ui: ctx.ui,

		async saveModels(mutate) {
			// Backs up, then rewrites atomically. Throws when models.json is unparsable.
			updateJsonFile(modelsJsonPath(), mutate);
			// Reload models.json without touching the network so the change is visible now.
			await ctx.modelRegistry.refresh({ allowNetwork: false });
		},

		async saveSettings(mutate) {
			updateJsonFile(settingsJsonPath(), mutate);
		},

		async refreshEndpoint(providerId) {
			try {
				const result = await ctx.modelRegistry.refresh({
					allowNetwork: true,
					providers: [providerId],
					force: true,
				});
				const problems = [...result.errors.entries()].map(([id, error]) => `${id}: ${error.message}`);
				if (problems.length === 0) {
					const count = ctx.modelRegistry.getAll().filter((model) => model.provider === providerId).length;
					if (count === 0) problems.push("endpoint returned no usable models");
				}
				return problems;
			} catch (error) {
				return [error instanceof Error ? error.message : String(error)];
			}
		},

		async removeEndpoint(providerId) {
			updateJsonFile(modelsJsonPath(), (models) => {
				deleteProviderBlock(models, providerId);
			});
			// Drop its cycle-scope patterns too, so settings.json does not keep dangling ids.
			updateJsonFile(settingsJsonPath(), (settings) => {
				const next = removeProviderFromScope(asStringArray(settings.enabledModels), providerId);
				if (!next || next.length === 0) delete settings.enabledModels;
				else settings.enabledModels = next;
			});
			// Only drop the registration if this extension created it.
			if (discovered.delete(providerId)) pi.unregisterProvider(providerId);
			await ctx.modelRegistry.refresh({ allowNetwork: false });
		},

		async adoptEndpoint(providerId) {
			// A new provider block: take ownership of discovery if nobody else has it,
			// then let the registry pick the list up.
			await ensureDiscovery(pi, ctx, providerId);
			await ctx.modelRegistry.refresh({ allowNetwork: true, providers: [providerId], force: true });
		},
	};

	const result = await ctx.ui.custom<ManagerResult>(
		async (tui, theme, keybindings, done) => {
			const manager = new ModelsManagerComponent(tui, theme, keybindings, done, host);
			await manager.load();
			return manager;
		},
		{ blocked: { kind: "question", message: "Managing endpoint models" } },
	);

	if (result?.settingsChanged) {
		ctx.ui.notify(
			"Cycle scope / default model saved to settings.json. Run /reload (or restart pi) to apply it to this session.",
			"info",
		);
	}
}

export default function modelsManager(pi: ExtensionAPI): void {
	// Discover model lists for custom endpoints that no other extension provides, so
	// a bare models.json provider block is enough to get usable models.
	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		await ensureAllDiscovery(pi, ctx);
	});

	pi.registerCommand("models-manager", {
		description: "Manage models for your own endpoint: metadata, cycle scope, connection",
		handler: async (_args, ctx) => {
			await openManager(pi, ctx);
		},
	});

	pi.registerCommand("mm", {
		description: "Short alias for /models-manager",
		handler: async (_args, ctx) => {
			await openManager(pi, ctx);
		},
	});
}
