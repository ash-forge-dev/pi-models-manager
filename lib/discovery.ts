// Generic model discovery: ask an endpoint for its model list and map it onto pi's
// model shape.
//
// The rule here is no provider-specific knowledge. Everything comes from what the
// server reports (id, display name, context length, vision, reasoning efforts,
// whether a model is loaded, whether it is a chat model) and falls back to pi's own
// defaults when the server says nothing. Values a server cannot report are corrected
// once, per model, in the TUI — those land in models.json `modelOverrides` and win
// over anything derived here.
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * Fallbacks when the endpoint does not report a limit.
 *
 * Context is deliberately conservative (not pi's 128k default): over-claiming makes
 * pi send a request the model cannot take, which surfaces as a hard failure, while
 * under-claiming only compacts a little early. Raise it per provider (endpoint
 * form → "all ctx") or per model when the server is silent but you know better.
 */
const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_MAX_TOKENS = 16384;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const num = (...values: unknown[]): number | undefined => {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
};
const str = (...values: unknown[]): string | undefined => {
	for (const value of values) {
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
};

/** `/v1/models` bodies in the wild: `{data:[…]}`, `{models:[…]}`, or a bare array. */
export function extractEntries(body: unknown): unknown[] {
	if (Array.isArray(body)) return body;
	if (!isObject(body)) return [];
	const data = body.data ?? body.models;
	return Array.isArray(data) ? data : [];
}

/**
 * Thinking-level map derived from the levels the server says it supports.
 * `levels` is the raw list, so a server-reported "none" can map to pi's `off`.
 */
function thinkingMap(reasoning: Json, levels: string[]): Record<string, string | null> | undefined {
	if (levels.length === 0) return undefined;
	const supports = (level: string) => (levels.includes(level) ? level : null);
	const map: Record<string, string | null> = {
		off: reasoning.mandatory === true ? null : levels.includes("none") ? "none" : "off",
		minimal: supports("minimal"),
		low: supports("low"),
		medium: supports("medium"),
		high: supports("high"),
		xhigh: supports("xhigh"),
		max: supports("max"),
	};
	return map;
}

export interface MapOptions {
	/** Provider-level compat, copied onto each model (pi does not merge it for extension models). */
	compat?: unknown;
	/** Overrides for the built-in defaults, e.g. from the endpoint form. */
	defaultContextWindow?: number;
	defaultMaxTokens?: number;
}

/**
 * Map one raw `/v1/models` entry. Returns undefined for entries this tool cannot use
 * (no id, or explicitly a non-chat model such as an embedding or image model).
 */
export function mapModel(entry: unknown, options: MapOptions = {}): ProviderModelConfig | undefined {
	if (typeof entry === "string") {
		if (entry.trim() === "") return undefined;
		return {
			id: entry,
			name: entry,
			reasoning: false,
			input: ["text"],
			contextWindow: options.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...(isObject(options.compat) ? { compat: options.compat as ProviderModelConfig["compat"] } : {}),
		};
	}
	if (!isObject(entry)) return undefined;

	const id = str(entry.id, entry.model, entry.name);
	if (!id) return undefined;

	const meta = isObject(entry.localdesk) ? entry.localdesk : {};
	// Only trust an explicit kind. Servers that report nothing are assumed chat,
	// because hiding a model with no explanation is worse than a failed request.
	const kind = str(entry.kind, meta.kind);
	if (kind && kind.toLowerCase() !== "chat") return undefined;

	const reasoning = isObject(entry.reasoning) ? entry.reasoning : {};
	const capabilities = strings(meta.capabilities ?? entry.capabilities).map((value) => value.toLowerCase());
	// Keep the raw list for the thinking-level map, but "none" alone is not a
	// reasoning capability — it just means the server has a way to turn thinking off.
	const rawEfforts = strings(reasoning.supported_efforts);
	const efforts = rawEfforts.filter((level) => level !== "none");
	const reasoningEnabled =
		efforts.length > 0 ||
		reasoning.default_enabled === true ||
		reasoning.mandatory === true ||
		entry.reasoning === true ||
		capabilities.includes("reasoning") ||
		capabilities.includes("thinking");

	const vision =
		meta.vision === true ||
		entry.vision === true ||
		capabilities.includes("vision") ||
		capabilities.includes("image");

	const loaded = meta.loaded ?? entry.loaded;
	const displayName = str(meta.display_name, entry.display_name, entry.name) ?? id;
	// A server that says a model is not loaded yet is advertising it anyway; keep the
	// name honest so nobody wonders why the first request is slow.
	const name = loaded === false ? `${displayName} (not loaded)` : displayName;

	const model: ProviderModelConfig = {
		id,
		name,
		reasoning: reasoningEnabled,
		...(reasoningEnabled && rawEfforts.length > 0 ? { thinkingLevelMap: thinkingMap(reasoning, rawEfforts) } : {}),
		input: vision ? ["text", "image"] : ["text"],
		contextWindow:
			num(meta.loaded_context_length, meta.context_length, meta.max_context_length, entry.context_length, entry.contextWindow, entry.max_context_window, options.defaultContextWindow) ??
			DEFAULT_CONTEXT_WINDOW,
		maxTokens: num(entry.max_output_tokens, entry.maxTokens, meta.max_output_tokens, options.defaultMaxTokens) ?? DEFAULT_MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	if (isObject(options.compat)) model.compat = options.compat as ProviderModelConfig["compat"];
	return model;
}

/** Map a whole response body, dropping duplicates and unusable entries. */
export function mapModels(body: unknown, options: MapOptions = {}): ProviderModelConfig[] {
	const models: ProviderModelConfig[] = [];
	const seen = new Set<string>();
	for (const entry of extractEntries(body)) {
		const model = mapModel(entry, options);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	// Loaded models first, then alphabetical, so the ones that work now are on top.
	models.sort((left, right) => {
		const leftLoaded = left.name.endsWith("(not loaded)") ? 1 : 0;
		const rightLoaded = right.name.endsWith("(not loaded)") ? 1 : 0;
		return leftLoaded - rightLoaded || left.name.localeCompare(right.name);
	});
	return models;
}

export interface DiscoveryConfig {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string | null>;
	compat?: unknown;
	timeoutMs?: number;
}

export interface DiscoveryResult {
	models: ProviderModelConfig[];
	/** Present when the request itself failed (server down, bad URL, non-2xx). */
	error?: string;
	url?: string;
}

/** GET `<baseUrl>/models` and map the result. Never throws. */
export async function discoverModels(config: DiscoveryConfig, signal?: AbortSignal): Promise<DiscoveryResult> {
	const base = config.baseUrl?.replace(/\/+$/, "");
	if (!base) return { models: [], error: "provider has no baseUrl" };
	const url = `${base}/models`;
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.headers ?? {})) {
		if (typeof value === "string") headers[key] = value;
	}
	if (config.apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
		headers.Authorization = `Bearer ${config.apiKey}`;
	}
	const timeout = AbortSignal.timeout(config.timeoutMs ?? 4000);
	try {
		const response = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
		if (!response.ok) {
			return { models: [], url, error: `HTTP ${response.status} ${response.statusText}` };
		}
		const body: unknown = await response.json().catch(() => undefined);
		if (body === undefined) return { models: [], url, error: "response was not JSON" };
		return { models: mapModels(body, { compat: config.compat }), url };
	} catch (error) {
		const message = error instanceof Error ? (error.name === "TimeoutError" ? "timed out" : error.message) : String(error);
		return { models: [], url, error: message };
	}
}

/** pi thinking levels, re-exported for the TUI's thinking-level rows. */
export const DISCOVERY_THINKING_LEVELS = THINKING_LEVELS;
