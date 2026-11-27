// Reading and writing the parts of models.json this tool manages: provider
// connection blocks and per-model `modelOverrides`.
//
// `modelOverrides` is the right home for per-model tuning because pi's provider
// composer applies it last — after built-in models, models.json `models` entries,
// and models supplied by extensions — so an override wins even for a model that
// an extension discovers at runtime.
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { asObject, asStringArray, deletePath, isObject, type JsonObject, setPath } from "./util.ts";

/**
 * Built-in catalog provider ids. Used to keep this tool off providers pi already
 * ships, so a stray edit cannot break a subscription provider's defaults.
 */
export function builtinProviderIds(): Set<string> {
	try {
		// Returns provider id strings (typed as the BuiltinProvider key union). Accept
		// objects too, in case the shape ever changes, but never rely on `.id` alone.
		const entries = getBuiltinProviders() as unknown as Array<string | { id?: string }>;
		const ids = entries
			.map((entry) => (typeof entry === "string" ? entry : entry?.id))
			.filter((id): id is string => typeof id === "string" && id.length > 0);
		if (ids.length === 0) throw new Error("empty built-in provider catalog");
		return new Set(ids);
	} catch {
		// If the bundled catalog cannot be read, fall back to the documented ids.
		return new Set([
			"amazon-bedrock", "ant-ling", "anthropic", "google", "google-vertex", "openai", "azure",
			"openai-codex", "radius", "typesafe", "nvidia", "deepseek", "github-copilot", "xai", "groq",
			"cerebras", "openrouter", "vercel-ai-gateway", "zai", "zai-coding-cn", "mistral", "minimax",
			"minimax-cn", "moonshotai", "moonshotai-cn", "huggingface", "fireworks", "together", "baseten",
			"opencode", "opencode-go", "kimi-coding", "meta", "cloudflare-workers-ai",
			"cloudflare-ai-gateway", "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual",
			"xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
		]);
	}
}

export interface EndpointRow {
	id: string;
	name: string;
	baseUrl?: string;
	api?: string;
	/** Declared in models.json, so this tool can write to it. */
	inModelsJson: boolean;
	/** Registered by an extension (dynamic discovery, custom streaming). */
	registered: boolean;
	models: number;
	available: number;
	authConfigured: boolean;
	authSource?: string;
	/** True for providers that are part of pi's built-in catalog. */
	builtin: boolean;
}

/** Providers this tool manages: user-defined endpoints, never built-in catalog providers. */
export function listEndpoints(registry: ModelRegistry, modelsJson: JsonObject): EndpointRow[] {
	const builtins = builtinProviderIds();
	const providerBlocks = asObject(modelsJson.providers);
	const registered = new Set(registry.getRegisteredProviderIds());
	const ids = new Set<string>([...Object.keys(providerBlocks), ...registered]);
	const allModels = registry.getAll();
	const available = new Set(registry.getAvailable().map((model) => `${model.provider}\u0000${model.id}`));

	const rows: EndpointRow[] = [];
	for (const id of ids) {
		if (builtins.has(id)) continue;
		const block = asObject(providerBlocks[id]);
		const models = allModels.filter((model) => model.provider === id);
		const status = registry.getProviderAuthStatus(id);
		const providerName = typeof block.name === "string" ? block.name : registry.getProviderDisplayName(id);
		rows.push({
			id,
			name: providerName && providerName !== id ? providerName : id,
			baseUrl: typeof block.baseUrl === "string" ? block.baseUrl : registry.getProvider(id)?.baseUrl,
			api: typeof block.api === "string" ? block.api : models[0]?.api,
			inModelsJson: id in providerBlocks,
			registered: registered.has(id),
			models: models.length,
			available: models.filter((model) => available.has(`${model.provider}\u0000${model.id}`)).length,
			authConfigured: status?.configured ?? false,
			authSource: status?.label ?? status?.source,
			builtin: false,
		});
	}
	return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export interface ModelRow {
	id: string;
	name: string;
	provider: string;
	api: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: string[];
	cost: Record<string, number | undefined>;
	/** False when only an override exists and the provider no longer lists the model. */
	inRegistry: boolean;
	available: boolean;
	/** Top-level override keys present in models.json for this model. */
	overriddenKeys: string[];
}

interface RegistryModelLike {
	id: string;
	name?: string;
	provider: string;
	api: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: string[];
	cost?: Record<string, number>;
}

export function providerBlock(modelsJson: JsonObject, providerId: string): JsonObject | undefined {
	const block = asObject(modelsJson.providers)[providerId];
	return isObject(block) ? block : undefined;
}

export function modelOverrides(modelsJson: JsonObject, providerId: string, modelId: string): JsonObject | undefined {
	const overrides = asObject(providerBlock(modelsJson, providerId)?.modelOverrides)[modelId];
	return isObject(overrides) ? overrides : undefined;
}

/** Models of one provider, including override-only entries that discovery no longer returns. */
export function modelRows(registry: ModelRegistry, modelsJson: JsonObject, providerId: string): ModelRow[] {
	const available = new Set(registry.getAvailable().map((model) => `${model.provider}\u0000${model.id}`));
	const overrides = asObject(providerBlock(modelsJson, providerId)?.modelOverrides);
	const registryModels = (registry.getAll() as RegistryModelLike[]).filter((model) => model.provider === providerId);

	const rows: ModelRow[] = registryModels.map((model) => {
		const override = asObject(overrides[model.id]);
		return {
			id: model.id,
			name: model.name ?? model.id,
			provider: providerId,
			api: model.api,
			contextWindow: model.contextWindow ?? 0,
			maxTokens: model.maxTokens ?? 0,
			reasoning: model.reasoning ?? false,
			thinkingLevelMap: model.thinkingLevelMap,
			input: Array.isArray(model.input) ? model.input : ["text"],
			cost: model.cost ?? {},
			inRegistry: true,
			available: available.has(`${providerId}\u0000${model.id}`),
			overriddenKeys: Object.keys(override),
		};
	});

	// Keep stale overrides visible: without a row, they could never be cleaned up.
	const known = new Set(rows.map((row) => row.id));
	for (const modelId of Object.keys(overrides)) {
		if (known.has(modelId)) continue;
		const override = asObject(overrides[modelId]);
		rows.push({
			id: modelId,
			name: typeof override.name === "string" ? override.name : modelId,
			provider: providerId,
			api: typeof override.api === "string" ? override.api : "?",
			contextWindow: typeof override.contextWindow === "number" ? override.contextWindow : 0,
			maxTokens: typeof override.maxTokens === "number" ? override.maxTokens : 0,
			reasoning: override.reasoning === true,
			thinkingLevelMap: isObject(override.thinkingLevelMap) ? (override.thinkingLevelMap as Record<string, string | null>) : undefined,
			input: asStringArray(override.input) ?? ["text"],
			cost: isObject(override.cost) ? (override.cost as Record<string, number>) : {},
			inRegistry: false,
			available: false,
			overriddenKeys: Object.keys(override),
		});
	}
	return rows;
}

/** Provider ids (other than `except`) that have at least one usable model. */
export function providersWithUsableModels(registry: ModelRegistry, except: string): string[] {
	const ids = new Set(registry.getAvailable().map((model) => model.provider));
	ids.delete(except);
	return [...ids].sort();
}

function ensureProvider(modelsJson: JsonObject, providerId: string): JsonObject {
	const providers = isObject(modelsJson.providers) ? modelsJson.providers : {};
	modelsJson.providers = providers;
	const existing = providers[providerId];
	if (isObject(existing)) return existing;
	const created: JsonObject = {};
	providers[providerId] = created;
	return created;
}

/** Set one nested override field (e.g. ["cost", "input"]). */
export function setModelOverride(
	modelsJson: JsonObject,
	providerId: string,
	modelId: string,
	path: readonly string[],
	value: unknown,
): void {
	const provider = ensureProvider(modelsJson, providerId);
	const overrides = isObject(provider.modelOverrides) ? provider.modelOverrides : {};
	provider.modelOverrides = overrides;
	const target = isObject(overrides[modelId]) ? (overrides[modelId] as JsonObject) : {};
	overrides[modelId] = target;
	setPath(target, path, value);
}

export function deleteModelOverride(
	modelsJson: JsonObject,
	providerId: string,
	modelId: string,
	path: readonly string[],
): void {
	const provider = providerBlock(modelsJson, providerId);
	const overrides = provider?.modelOverrides;
	if (!isObject(overrides)) return;
	const target = overrides[modelId];
	if (!isObject(target)) return;
	deletePath(target, path);
	if (Object.keys(target).length === 0) delete overrides[modelId];
	if (Object.keys(overrides).length === 0) delete provider!.modelOverrides;
	if (provider && Object.keys(provider).length === 0) delete asObject(modelsJson.providers)[providerId];
}

export function clearModelOverrides(modelsJson: JsonObject, providerId: string, modelId: string): void {
	const provider = providerBlock(modelsJson, providerId);
	const overrides = provider?.modelOverrides;
	if (!isObject(overrides) || !(modelId in overrides)) return;
	delete overrides[modelId];
	if (Object.keys(overrides).length === 0) delete provider!.modelOverrides;
	if (provider && Object.keys(provider).length === 0) delete asObject(modelsJson.providers)[providerId];
}

export function setProviderField(modelsJson: JsonObject, providerId: string, path: readonly string[], value: unknown): void {
	setPath(ensureProvider(modelsJson, providerId), path, value);
}

export function deleteProviderField(modelsJson: JsonObject, providerId: string, path: readonly string[]): void {
	const provider = providerBlock(modelsJson, providerId);
	if (!provider) return;
	deletePath(provider, path);
	if (Object.keys(provider).length === 0) delete asObject(modelsJson.providers)[providerId];
}

/** Remove a provider block entirely. */
export function deleteProviderBlock(modelsJson: JsonObject, providerId: string): boolean {
	const providers = asObject(modelsJson.providers);
	if (!(providerId in providers)) return false;
	delete providers[providerId];
	if (Object.keys(providers).length === 0) delete modelsJson.providers;
	return true;
}

/** Create an empty provider block (used when adopting an extension-only endpoint). */
export function ensureEndpointBlock(modelsJson: JsonObject, providerId: string, baseUrl: string, api: string): void {
	const provider = ensureProvider(modelsJson, providerId);
	if (typeof provider.baseUrl !== "string") provider.baseUrl = baseUrl;
	if (typeof provider.api !== "string") provider.api = api;
}
