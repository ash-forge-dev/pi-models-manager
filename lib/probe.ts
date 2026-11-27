// Live checks against a configured endpoint. These never write config: they only
// report what the server says, so a broken endpoint shows up here instead of as a
// silent "model missing" in the picker.
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const PROBE_TIMEOUT_MS = 8000;

export interface ProbeResult {
	ok: boolean;
	url: string;
	status?: number;
	ms: number;
	detail?: string;
	error?: string;
	/** Model ids returned by GET /models. */
	ids?: string[];
}

interface RegistryModelLike {
	id: string;
	provider: string;
	api: string;
	baseUrl?: string;
}

export interface EndpointAuth {
	baseUrl?: string;
	apiKey?: string;
	headers?: Record<string, string | null>;
	error?: string;
}

/**
 * Resolve base URL, key, and headers exactly like pi does for a request by asking
 * the model registry to resolve them for one of the provider's models.
 */
export async function resolveEndpointAuth(registry: ModelRegistry, providerId: string): Promise<EndpointAuth> {
	const model = (registry.getAll() as RegistryModelLike[]).find((entry) => entry.provider === providerId);
	if (!model) {
		const baseUrl = registry.getProvider(providerId)?.baseUrl;
		const apiKey = await registry.getApiKeyForProvider(providerId).catch(() => undefined);
		return { baseUrl, apiKey };
	}
	const resolved = await registry.getApiKeyAndHeaders(model).catch((error: unknown) => ({
		ok: false as const,
		error: error instanceof Error ? error.message : String(error),
	}));
	if (!resolved.ok) return { baseUrl: model.baseUrl, error: resolved.error };
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved.headers ?? {})) {
		if (typeof value === "string") headers[key] = value;
	}
	return { baseUrl: resolved.baseUrl ?? model.baseUrl, apiKey: resolved.apiKey, headers };
}

function requestHeaders(auth: EndpointAuth): Record<string, string> {
	const headers: Record<string, string> = { ...(auth.headers ?? {}) };
	const hasAuthHeader = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
	if (auth.apiKey && !hasAuthHeader) headers.Authorization = `Bearer ${auth.apiKey}`;
	return headers;
}

function endpointBase(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	return baseUrl.replace(/\/+$/, "");
}

/** GET <baseUrl>/models — the near-universal OpenAI-compatible discovery route. */
export async function probeModels(baseUrl: string | undefined, auth: EndpointAuth): Promise<ProbeResult> {
	const base = endpointBase(baseUrl);
	const started = Date.now();
	if (!base) return { ok: false, url: "(no baseUrl)", ms: 0, error: "provider has no baseUrl" };
	const url = `${base}/models`;
	try {
		const response = await fetch(url, { headers: requestHeaders(auth), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		const ms = Date.now() - started;
		if (!response.ok) {
			const body = (await response.text().catch(() => "")).slice(0, 200);
			return { ok: false, url, status: response.status, ms, error: `HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ""}` };
		}
		const body = (await response.json().catch(() => undefined)) as unknown;
		const ids = extractModelIds(body);
		return { ok: true, url, status: response.status, ms, ids, detail: ids ? `${ids.length} models` : "no model list in response" };
	} catch (error) {
		return { ok: false, url, ms: Date.now() - started, error: messageOf(error) };
	}
}

function extractModelIds(body: unknown): string[] | undefined {
	if (!body || typeof body !== "object") return undefined;
	const data = (body as { data?: unknown; models?: unknown }).data ?? (body as { models?: unknown }).models;
	if (!Array.isArray(data)) return undefined;
	const ids: string[] = [];
	for (const entry of data) {
		if (typeof entry === "string") ids.push(entry);
		else if (entry && typeof entry === "object") {
			const id = (entry as { id?: unknown; name?: unknown; model?: unknown }).id ?? (entry as { name?: unknown }).name ?? (entry as { model?: unknown }).model;
			if (typeof id === "string") ids.push(id);
		}
	}
	return ids;
}

export interface ChatProbeOptions {
	api?: string;
	maxTokens?: number;
}

/** POST one tiny chat completion to prove the model actually answers. */
export async function probeChat(
	baseUrl: string | undefined,
	auth: EndpointAuth,
	modelId: string,
	options: ChatProbeOptions = {},
): Promise<ProbeResult> {
	const base = endpointBase(baseUrl);
	const started = Date.now();
	if (!base) return { ok: false, url: "(no baseUrl)", ms: 0, error: "provider has no baseUrl" };
	const api = options.api ?? "openai-completions";
	if (api !== "openai-completions") {
		return { ok: false, url: base, ms: 0, error: `chat probe supports openai-completions only (provider uses ${api})` };
	}
	const url = `${base}/chat/completions`;
	const body = {
		model: modelId,
		messages: [{ role: "user", content: "Reply with the single word: ok" }],
		max_tokens: options.maxTokens ?? 16,
		stream: false,
	};
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...requestHeaders(auth) },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		const ms = Date.now() - started;
		const text = await response.text().catch(() => "");
		if (!response.ok) {
			return { ok: false, url, status: response.status, ms, error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
		}
		let reply: string | undefined;
		try {
			const parsed = JSON.parse(text) as {
				choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
			};
			const content = parsed.choices?.[0]?.message?.content ?? parsed.choices?.[0]?.text;
			reply = typeof content === "string" ? content.trim().slice(0, 80) : undefined;
		} catch {
			reply = text.trim().slice(0, 80);
		}
		return { ok: true, url, status: response.status, ms, detail: reply ? `reply: ${reply}` : "empty reply" };
	} catch (error) {
		return { ok: false, url, ms: Date.now() - started, error: messageOf(error) };
	}
}

/** Mask a secret for display: keep a short prefix and suffix only. */
export function maskSecret(value: string | undefined): string {
	if (!value) return "";
	if (value.startsWith("$") || value.startsWith("!")) return value;
	if (value.length <= 8) return "*".repeat(value.length);
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || /aborted|timeout/i.test(error.message)) return "timed out";
		return error.message;
	}
	return String(error);
}
