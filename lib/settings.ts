// settings.json: the model scope (`enabledModels`) and default model.
//
// Pattern syntax follows pi's own resolver:
//   - a trailing `:level` pins a thinking level, and is only a suffix when the
//     tail is a real thinking level (so `local-endpoint/vendor::chat` is safe),
//   - patterns containing `*`, `?` or `[` are minimatch globs tested against
//     `provider/modelId` and against the bare model id,
//   - everything else is an exact (pi also allows fuzzy) reference.
import { asObject, asStringArray, globToRegExp, type JsonObject } from "./util.ts";
import { readJsonFile, settingsJsonPath, updateJsonFile } from "./store.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export interface SettingsView {
	data: JsonObject;
	error?: string;
	/** undefined or empty means "no scoping": every available model is usable. */
	enabledModels: string[] | undefined;
	defaultProvider?: string;
	defaultModel?: string;
}

export function readSettings(): SettingsView {
	const read = readJsonFile(settingsJsonPath());
	const data = asObject(read.data);
	return {
		data,
		error: read.error,
		enabledModels: asStringArray(data.enabledModels),
		defaultProvider: typeof data.defaultProvider === "string" ? data.defaultProvider : undefined,
		defaultModel: typeof data.defaultModel === "string" ? data.defaultModel : undefined,
	};
}

/** Write `enabledModels`, removing the key when the scope is empty. */
export function writeEnabledModels(patterns: string[] | undefined): void {
	updateJsonFile(settingsJsonPath(), (settings) => {
		const cleaned = (patterns ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
		if (cleaned.length === 0) delete settings.enabledModels;
		else settings.enabledModels = cleaned;
	});
}

export function isThinkingLevel(value: string): value is ThinkingLevelName {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export interface SplitPattern {
	/** Pattern without its thinking-level suffix. */
	base: string;
	level?: ThinkingLevelName;
}

export function splitThinkingSuffix(pattern: string): SplitPattern {
	const colon = pattern.lastIndexOf(":");
	if (colon === -1) return { base: pattern };
	const suffix = pattern.slice(colon + 1);
	if (!isThinkingLevel(suffix)) return { base: pattern };
	return { base: pattern.slice(0, colon), level: suffix };
}

export function isGlobPattern(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

/** Whether a single scope pattern selects one model. */
export function patternMatchesModel(pattern: string, provider: string, modelId: string): boolean {
	const { base } = splitThinkingSuffix(pattern);
	if (isGlobPattern(base)) {
		const matcher = globToRegExp(base);
		return matcher.test(`${provider}/${modelId}`) || matcher.test(modelId);
	}
	if (base === `${provider}/${modelId}`) return true;
	// A bare model id is provider-agnostic in pi's resolver.
	return base === modelId;
}

/** Whether the pattern set makes this model reachable for startup/Ctrl+P cycling. */
export function isModelInScope(scope: string[] | undefined, provider: string, modelId: string): boolean {
	if (!scope || scope.length === 0) return true;
	return scope.some((pattern) => patternMatchesModel(pattern, provider, modelId));
}

function belongsToProvider(pattern: string, provider: string): boolean {
	const { base } = splitThinkingSuffix(pattern);
	return base.startsWith(`${provider}/`);
}

function exactEntry(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/** Replace `${provider}/*` with the provider's explicit model ids, keeping any thinking suffix. */
function expandProviderGlob(scope: string[], provider: string, modelIds: string[]): string[] {
	const globBase = `${provider}/*`;
	const out: string[] = [];
	for (const pattern of scope) {
		const { base, level } = splitThinkingSuffix(pattern);
		if (base !== globBase) {
			out.push(pattern);
			continue;
		}
		for (const modelId of modelIds) {
			out.push(level ? `${provider}/${modelId}:${level}` : `${provider}/${modelId}`);
		}
	}
	return out;
}

/**
 * Turn "no scoping" into an explicit list, so excluding one model keeps every
 * other model in scope. The edited provider gets explicit ids (which preserves
 * cursor order); other providers collapse to `provider/*`.
 */
export function materializeScope(
	scope: string[] | undefined,
	provider: string,
	providerModelIds: string[],
	otherProviderIds: string[],
): string[] {
	if (scope && scope.length > 0) return [...scope];
	return [...providerModelIds.map((modelId) => exactEntry(provider, modelId)), ...otherProviderIds.map((id) => `${id}/*`)];
}

export interface ToggleArgs {
	provider: string;
	modelId: string;
	/** Every scoped-capable model id of the edited provider, in display order. */
	providerModelIds: string[];
	/** Providers other than the edited one that have usable models. */
	otherProviderIds: string[];
}

/** Add or remove one model from the scope, returning the new pattern list. */
export function toggleModelInScope(scope: string[] | undefined, args: ToggleArgs): string[] {
	const { provider, modelId, providerModelIds, otherProviderIds } = args;
	let patterns = materializeScope(scope, provider, providerModelIds, otherProviderIds);
	patterns = expandProviderGlob(patterns, provider, providerModelIds);

	const target = exactEntry(provider, modelId);
	const index = patterns.findIndex((pattern) => splitThinkingSuffix(pattern).base === target);
	if (index >= 0) {
		patterns.splice(index, 1);
		return patterns;
	}

	// Insert next to the provider's other entries so Ctrl+P order stays grouped.
	let insertAt = patterns.length - 1;
	for (let cursor = patterns.length - 1; cursor >= 0; cursor--) {
		if (belongsToProvider(patterns[cursor]!, provider)) {
			insertAt = cursor;
			break;
		}
	}
	patterns.splice(insertAt + 1, 0, target);
	return patterns;
}

/** Move one model up (-1) or down (+1) within the provider's scope segment. */
export function moveModelInScope(scope: string[] | undefined, args: ToggleArgs, delta: -1 | 1): string[] {
	const { provider, modelId, providerModelIds, otherProviderIds } = args;
	let patterns = materializeScope(scope, provider, providerModelIds, otherProviderIds);
	patterns = expandProviderGlob(patterns, provider, providerModelIds);

	const target = exactEntry(provider, modelId);
	const index = patterns.findIndex((pattern) => splitThinkingSuffix(pattern).base === target);
	if (index < 0) return patterns;

	for (let cursor = index + delta; cursor >= 0 && cursor < patterns.length; cursor += delta) {
		if (!belongsToProvider(patterns[cursor]!, provider)) break;
		const swapped = [...patterns];
		const current = swapped[index]!;
		swapped[index] = swapped[cursor]!;
		swapped[cursor] = current;
		return swapped;
	}
	return patterns;
}

/** Remove every scope pattern that belongs to one provider. */
export function removeProviderFromScope(scope: string[] | undefined, provider: string): string[] | undefined {
	if (!scope || scope.length === 0) return scope;
	const kept = scope.filter((pattern) => !belongsToProvider(pattern, provider));
	return kept.length > 0 ? kept : undefined;
}

/** Position of a model inside the scope list, or undefined when unscoped. */
export function scopePosition(scope: string[] | undefined, provider: string, modelId: string): number | undefined {
	if (!scope || scope.length === 0) return undefined;
	const target = exactEntry(provider, modelId);
	const index = scope.findIndex((pattern) => splitThinkingSuffix(pattern).base === target);
	return index >= 0 ? index : undefined;
}

/**
 * pi merges global and project settings, so a project `.pi/settings.json` that
 * sets `enabledModels` silently overrides what this tool writes to the global file.
 */
export function projectScopeOverride(projectPath: string): { path: string; patterns: string[] } | undefined {
	const read = readJsonFile(projectPath);
	if (!read.data) return undefined;
	const patterns = asStringArray(read.data.enabledModels);
	if (!patterns) return undefined;
	return { path: projectPath, patterns };
}
