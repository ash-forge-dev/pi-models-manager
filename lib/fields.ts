// Field definitions for the two editable forms.
//
// A field knows how to display its effective value, whether that value is an
// explicit override in models.json, and how to persist a change. Writes always
// target the config file (`modelOverrides` / the provider block), never the
// in-memory model, so a rediscovered model keeps the tuning.
import {
	deleteModelOverride,
	deleteProviderField,
	modelOverrides,
	providerBlock,
	setModelOverride,
	setProviderField,
	type ModelRow,
} from "./catalog.ts";
import { maskSecret } from "./probe.ts";
import { THINKING_LEVELS } from "./settings.ts";
import { asObject, describeValue, formatCost, isObject, type JsonObject } from "./util.ts";

export type FieldKind = "text" | "int" | "number" | "bool" | "enum" | "optionalText";

export interface FieldSpec {
	key: string;
	label: string;
	kind: FieldKind;
	/** Choices for `enum`, including the "(inherit)" pseudo-choice. */
	options?: readonly string[];
	/** Formatted effective value. */
	display: string;
	/** True when models.json sets this field explicitly. */
	isSet: boolean;
	/** Text prefilled into the editor. */
	raw: string;
	/**
	 * "prefill" (default) opens the input with the current value, so text edits
	 * start from what is there. "blank" opens empty with the value as placeholder,
	 * which is what numbers need: appending digits to "1234" is never what you mean,
	 * and an empty submit then cancels instead of clearing.
	 */
	editStyle?: "prefill" | "blank";
	/** Short help line shown under the field list. */
	hint?: string;
	/** Persist a new value. `undefined` removes the override. */
	apply?(value: string | undefined): Promise<void>;
	/** Remove the override (bool/enum fields do not go through `apply`). */
	clear?(): Promise<void>;
	/** bool/enum: advance the value in place. */
	step?(delta: 1 | -1): Promise<void>;
}

export interface FieldWriter {
	/** Update models.json (read-modify-write) then refresh the model registry. */
	models(mutate: (models: JsonObject) => void): Promise<void>;
	/** Write one value into modelOverrides for every discovered model of a provider. */
	allModels?(providerId: string, key: string, value: number): Promise<void>;
}

const INHERIT = "(inherit)";

function parseNumber(raw: string | undefined, label: string): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw.trim());
	if (!Number.isFinite(value)) throw new Error(`${label} must be a number`);
	return value;
}

function parseInteger(raw: string | undefined, label: string): number | undefined {
	const value = parseNumber(raw, label);
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
	return value;
}

function parseJsonObject(raw: string | undefined, label: string): JsonObject | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isObject(parsed)) throw new Error(`${label} must be a JSON object`);
	return parsed;
}

/** Model fields: everything pi's modelOverrides schema accepts per model. */
export function modelFields(options: {
	providerId: string;
	row: ModelRow;
	modelsJson: JsonObject;
	write: FieldWriter;
}): FieldSpec[] {
	const { providerId, row, write } = options;
	const override = modelOverrides(options.modelsJson, providerId, row.id) ?? {};
	const isSet = (key: string) => override[key] !== undefined;

	const setValue = (path: string[], value: unknown) =>
		write.models((models) => setModelOverride(models, providerId, row.id, path, value));
	const clearValue = (path: string[]) =>
		write.models((models) => deleteModelOverride(models, providerId, row.id, path));

	const fields: FieldSpec[] = [
		{
			key: "name",
			label: "name",
			kind: "text",
			display: row.name,
			isSet: isSet("name"),
			raw: typeof override.name === "string" ? override.name : row.name,
			apply: (raw) => (raw === undefined || raw.trim() === "" ? clearValue(["name"]) : setValue(["name"], raw.trim())),
		},
		{
			key: "contextWindow",
			label: "context",
			kind: "int",
			editStyle: "blank",
			display: String(row.contextWindow),
			isSet: isSet("contextWindow"),
			raw: String(row.contextWindow),
			hint: "contextWindow — tokens pi may send in one request",
			apply: (raw) => {
				const value = parseInteger(raw, "context");
				return value === undefined ? clearValue(["contextWindow"]) : setValue(["contextWindow"], value);
			},
		},
		{
			key: "maxTokens",
			label: "maxTokens",
			kind: "int",
			editStyle: "blank",
			display: String(row.maxTokens),
			isSet: isSet("maxTokens"),
			raw: String(row.maxTokens),
			hint: "maxTokens — output budget per response",
			apply: (raw) => {
				const value = parseInteger(raw, "maxTokens");
				return value === undefined ? clearValue(["maxTokens"]) : setValue(["maxTokens"], value);
			},
		},
		{
			key: "reasoning",
			label: "reasoning",
			kind: "bool",
			display: row.reasoning ? "yes" : "no",
			isSet: isSet("reasoning"),
			raw: String(row.reasoning),
			hint: "reasoning — model accepts thinking/reasoning requests",
			step: () => setValue(["reasoning"], !row.reasoning),
			clear: () => clearValue(["reasoning"]),
		},
		{
			key: "vision",
			label: "vision",
			kind: "bool",
			display: row.input.includes("image") ? "yes" : "no",
			isSet: isSet("input"),
			raw: row.input.join(","),
			hint: "input modalities — image support enables read/tool images",
			step: () =>
				setValue(["input"], row.input.includes("image") ? ["text"] : ["text", "image"]),
			clear: () => clearValue(["input"]),
		},
	];

	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const current = row.cost[key];
		fields.push({
			key: `cost.${key}`,
			label: `cost ${key}`,
			kind: "number",
			editStyle: "blank",
			display: formatCost(current),
			isSet: isObject(override.cost) && (override.cost as JsonObject)[key] !== undefined,
			raw: current === undefined ? "" : String(current),
			hint: "USD per million tokens (informational)",
			apply: (raw) => {
				const value = parseNumber(raw, `cost ${key}`);
				return value === undefined ? clearValue(["cost", key]) : setValue(["cost", key], value);
			},
		});
	}

	// Thinking levels: a value the provider accepts, "null" for unsupported, or unset.
	const map = asObject(override.thinkingLevelMap);
	for (const level of THINKING_LEVELS) {
		const effective = row.thinkingLevelMap?.[level];
		const value = map[level];
		fields.push({
			key: `thinking.${level}`,
			label: `think ${level}`,
			kind: "optionalText",
			display:
				value === undefined
					? effective === undefined
						? "inherit"
						: `${describeValue(effective)} (inherited)`
					: describeValue(value),
			isSet: value !== undefined,
			raw: value === null ? "null" : typeof value === "string" ? value : effective === null ? "null" : effective ?? "",
			hint: "provider value for this level · empty = inherit · null = unsupported",
			apply: (raw) => {
				const trimmed = raw?.trim();
				if (trimmed === undefined || trimmed === "") return clearValue(["thinkingLevelMap", level]);
				if (trimmed === "null") return setValue(["thinkingLevelMap", level], null);
				return setValue(["thinkingLevelMap", level], trimmed);
			},
		});
	}
	return fields;
}

interface CompatField {
	key: string;
	type: "bool" | "enum" | "number";
	options?: readonly string[];
}

const SESSION_AFFINITY = ["openai", "openai-nosession", "openrouter"] as const;

/** Compatibility flags pi documents for each API, in a sensible edit order. */
const COMPAT_FIELDS: Record<string, readonly CompatField[]> = {
	"openai-completions": [
		{ key: "supportsStore", type: "bool" },
		{ key: "supportsDeveloperRole", type: "bool" },
		{ key: "supportsReasoningEffort", type: "bool" },
		{ key: "supportsUsageInStreaming", type: "bool" },
		{ key: "supportsFinishReason", type: "bool" },
		{ key: "requiresToolResultName", type: "bool" },
		{ key: "requiresAssistantAfterToolResult", type: "bool" },
		{ key: "requiresThinkingAsText", type: "bool" },
		{ key: "requiresReasoningContentOnAssistantMessages", type: "bool" },
		{
			key: "thinkingFormat",
			type: "enum",
			options: [
				"openai",
				"openrouter",
				"deepseek",
				"together",
				"baseten",
				"zai",
				"qwen",
				"chat-template",
				"qwen-chat-template",
				"string-thinking",
				"ant-ling",
			],
		},
		{ key: "maxTokensField", type: "enum", options: ["max_tokens", "max_completion_tokens"] },
		{
			key: "thinkingTokenBudgetField",
			type: "enum",
			options: ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"],
		},
		{ key: "supportsMidConvoSystemMessages", type: "bool" },
		{ key: "supportsMidConvoToolAdditions", type: "bool" },
		{ key: "supportsStrictMode", type: "bool" },
		{ key: "supportsOpenAIGrammarTools", type: "bool" },
		{ key: "cacheControlFormat", type: "enum", options: ["anthropic"] },
		{ key: "supportsLongCacheRetention", type: "bool" },
		{ key: "sendSessionAffinityHeaders", type: "bool" },
		{ key: "sessionAffinityFormat", type: "enum", options: SESSION_AFFINITY },
		{ key: "zaiToolStream", type: "bool" },
		{ key: "vllmPriority", type: "number" },
	],
	"openai-responses": [
		{ key: "supportsDeveloperRole", type: "bool" },
		{ key: "supportsMidConvoSystemMessages", type: "bool" },
		{ key: "supportsMidConvoEffort", type: "bool" },
		{ key: "supportsLongCacheRetention", type: "bool" },
		{ key: "supportsStrictMode", type: "bool" },
		{ key: "supportsOpenAIGrammarTools", type: "bool" },
		{ key: "supportsAdditionalTools", type: "bool" },
		{ key: "supportsToolSearch", type: "bool" },
		{ key: "supportsExplicitPromptCacheMode", type: "bool" },
		{ key: "supportsMaxOutputTokens", type: "bool" },
		{ key: "sessionAffinityFormat", type: "enum", options: SESSION_AFFINITY },
	],
	"anthropic-messages": [
		{ key: "supportsEagerToolInputStreaming", type: "bool" },
		{ key: "supportsLongCacheRetention", type: "bool" },
		{ key: "supportsCacheControlOnTools", type: "bool" },
		{ key: "supportsTemperature", type: "bool" },
		{ key: "supportsStrictTools", type: "bool" },
		{ key: "supportsMidConvoEffort", type: "bool" },
		{ key: "supportsMidConvoSystemMessages", type: "bool" },
		{ key: "supportsMidConvoToolChanges", type: "bool" },
		{ key: "forceAdaptiveThinking", type: "bool" },
		{ key: "allowEmptySignature", type: "bool" },
		{ key: "sendSessionAffinityHeaders", type: "bool" },
		{ key: "sessionAffinityFormat", type: "enum", options: ["openrouter"] },
	],
};

export const KNOWN_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
	"bedrock-converse-stream",
	"azure-openai-responses",
	"openai-codex-responses",
] as const;

/** Provider (endpoint) fields, including the compat flags for its API. */
export function providerFields(options: {
	providerId: string;
	modelsJson: JsonObject;
	write: FieldWriter;
	/** Discovered models of this provider, so bulk edits can describe themselves. */
	modelIds?: string[];
}): FieldSpec[] {
	const { providerId, write } = options;
	const block = providerBlock(options.modelsJson, providerId) ?? {};
	const compat = asObject(block.compat);
	const api = typeof block.api === "string" ? block.api : "";
	const headers = asObject(block.headers);

	const setField = (path: string[], value: unknown) =>
		write.models((models) => setProviderField(models, providerId, path, value));
	const clearField = (path: string[]) => write.models((models) => deleteProviderField(models, providerId, path));

	const fields: FieldSpec[] = [
		{
			key: "name",
			label: "name",
			kind: "text",
			display: typeof block.name === "string" ? block.name : "(provider id)",
			isSet: block.name !== undefined,
			raw: typeof block.name === "string" ? block.name : "",
			apply: (raw) => (raw === undefined || raw.trim() === "" ? clearField(["name"]) : setField(["name"], raw.trim())),
		},
		{
			key: "baseUrl",
			label: "baseUrl",
			kind: "text",
			display: typeof block.baseUrl === "string" ? block.baseUrl : "(unset)",
			isSet: block.baseUrl !== undefined,
			raw: typeof block.baseUrl === "string" ? block.baseUrl : "",
			hint: "OpenAI-compatible endpoints usually end in /v1",
			apply: (raw) => (raw === undefined || raw.trim() === "" ? clearField(["baseUrl"]) : setField(["baseUrl"], raw.trim())),
		},
		{
			key: "api",
			label: "api",
			kind: "enum",
			options: KNOWN_APIS,
			display: api || "(unset)",
			isSet: block.api !== undefined,
			raw: api,
			hint: "request/response protocol pi speaks to this endpoint",
			step: (delta) => {
				const index = KNOWN_APIS.indexOf(api as (typeof KNOWN_APIS)[number]);
				const next = KNOWN_APIS[(index + delta + KNOWN_APIS.length * 2) % KNOWN_APIS.length]!;
				return setField(["api"], next);
			},
		},
		{
			key: "apiKey",
			label: "apiKey",
			kind: "text",
			display: typeof block.apiKey === "string" ? maskSecret(block.apiKey) : "(unset)",
			isSet: block.apiKey !== undefined,
			raw: typeof block.apiKey === "string" ? block.apiKey : "",
			hint: 'literal, "$NAME" env reference, or "!command" output',
			apply: (raw) => (raw === undefined || raw === "" ? clearField(["apiKey"]) : setField(["apiKey"], raw)),
		},
		{
			key: "authHeader",
			label: "authHeader",
			kind: "bool",
			display: block.authHeader === true ? "yes" : "no",
			isSet: block.authHeader !== undefined,
			raw: String(block.authHeader === true),
			hint: "send the resolved key as Authorization: Bearer",
			step: () => setField(["authHeader"], block.authHeader !== true),
			clear: () => clearField(["authHeader"]),
		},
		{
			key: "headers",
			label: "headers",
			kind: "text",
			display: Object.keys(headers).length > 0 ? JSON.stringify(headers) : "(unset)",
			isSet: block.headers !== undefined,
			raw: Object.keys(headers).length > 0 ? JSON.stringify(headers) : "",
			hint: "JSON object; values resolve like apiKey",
			apply: (raw) => {
				const value = parseJsonObject(raw, "headers");
				return value === undefined ? clearField(["headers"]) : setField(["headers"], value);
			},
		},
	];

	// Compat flags documented for this API, then the raw object for anything else.
	for (const spec of COMPAT_FIELDS[api] ?? []) {
		const current = compat[spec.key];
		if (spec.type === "bool") {
			fields.push({
				key: `compat.${spec.key}`,
				label: spec.key,
				kind: "bool",
				hint: `compat.${spec.key} — leave unset unless the endpoint is verified to need it`,
				display: describeValue(current),
				isSet: current !== undefined,
				raw: String(current === true),
				step: () =>
					current === undefined
						? setField(["compat", spec.key], true)
						: clearField(["compat", spec.key]),
				clear: () => clearField(["compat", spec.key]),
			});
			continue;
		}
		if (spec.type === "number") {
			fields.push({
				key: `compat.${spec.key}`,
				label: spec.key,
				kind: "number",
				hint: `compat.${spec.key}`,
				display: describeValue(current),
				isSet: current !== undefined,
				raw: typeof current === "number" ? String(current) : "",
				apply: (raw) => {
					const value = parseNumber(raw, spec.key);
					return value === undefined ? clearField(["compat", spec.key]) : setField(["compat", spec.key], value);
				},
			});
			continue;
		}
		fields.push({
			key: `compat.${spec.key}`,
			label: spec.key,
			kind: "enum",
			options: [INHERIT, ...(spec.options ?? [])],
			display: describeValue(current),
			isSet: current !== undefined,
			raw: typeof current === "string" ? current : "",
			hint: `compat.${spec.key} — leave on (inherit) unless the endpoint is verified to need it`,
			step: (delta) => {
				const choices: readonly string[] = [INHERIT, ...(spec.options ?? [])];
				const index = choices.indexOf(typeof current === "string" ? current : INHERIT);
				const next = choices[(index + delta + choices.length * 2) % choices.length]!;
				return next === INHERIT ? clearField(["compat", spec.key]) : setField(["compat", spec.key], next);
			},
			clear: () => clearField(["compat", spec.key]),
		});
	}

	// Endpoint-wide defaults: one action instead of hand-editing every model. The
	// result is plain modelOverrides data, so a per-model edit still wins.
	const modelIds = options.modelIds ?? [];
	for (const spec of [
		{ key: "contextWindow", label: "all ctx", hint: "write contextWindow into modelOverrides for every model here" },
		{ key: "maxTokens", label: "all maxTokens", hint: "write maxTokens into modelOverrides for every model here" },
	] as const) {
		fields.push({
			key: `all.${spec.key}`,
			label: spec.label,
			kind: "int",
			editStyle: "blank",
			display: modelIds.length > 0 ? `${modelIds.length} model(s)` : "no models",
			isSet: false,
			raw: "",
			hint: spec.hint,
			apply: async (raw) => {
				const value = parseInteger(raw, spec.label);
				if (value === undefined) return;
				if (!write.allModels) throw new Error("bulk edit is unavailable");
				await write.allModels(providerId, spec.key, value);
			},
		});
	}

	fields.push({
		key: "compat",
		label: "compat (raw)",
		kind: "text",
		display: Object.keys(compat).length > 0 ? JSON.stringify(compat) : "(unset)",
		isSet: block.compat !== undefined,
		raw: Object.keys(compat).length > 0 ? JSON.stringify(compat) : "",
		hint: "raw compat object — for flags this form does not list",
		apply: (raw) => {
			const value = parseJsonObject(raw, "compat");
			return value === undefined ? clearField(["compat"]) : setField(["compat"], value);
		},
	});

	return fields;
}
