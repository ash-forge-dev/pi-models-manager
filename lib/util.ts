// Small, dependency-free helpers: JSON object plumbing, glob matching, and
// width-aware text layout for the TUI.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce to a plain object, so callers can read fields without null checks. */
export function asObject(value: unknown): JsonObject {
	return isObject(value) ? value : {};
}

export function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string");
}

/** JSON clone. Keeps undefined as undefined so "absent" stays absent. */
export function cloneJson<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

export function getPath(target: JsonObject, path: readonly string[]): unknown {
	let current: unknown = target;
	for (const key of path) {
		if (!isObject(current)) return undefined;
		current = current[key];
	}
	return current;
}

/** Set a nested value, creating intermediate objects. */
export function setPath(target: JsonObject, path: readonly string[], value: unknown): void {
	if (path.length === 0) return;
	let current: JsonObject = target;
	for (const key of path.slice(0, -1)) {
		const next = current[key];
		if (!isObject(next)) {
			const created: JsonObject = {};
			current[key] = created;
			current = created;
			continue;
		}
		current = next;
	}
	current[path[path.length - 1]!] = value;
}

/**
 * Delete a nested value and prune containers that became empty, so resetting the
 * last override removes its model/provider entry instead of leaving `{}` behind.
 */
export function deletePath(target: JsonObject, path: readonly string[]): void {
	if (path.length === 0) return;
	// chain[i] is the object at path[0..i); chain[0] is the target itself.
	const chain: JsonObject[] = [target];
	let current: JsonObject = target;
	for (const key of path.slice(0, -1)) {
		const next = current[key];
		if (!isObject(next)) return;
		chain.push(next);
		current = next;
	}
	const last = path[path.length - 1]!;
	if (!(last in current)) return;
	delete current[last];
	for (let index = chain.length - 1; index > 0; index--) {
		if (Object.keys(chain[index]!).length > 0) return;
		delete chain[index - 1]![path[index - 1]!];
	}
}

/**
 * Compile a minimatch-style glob into a RegExp. `*` and `?` stop at `/` (as in
 * minimatch without matchBase), `**` crosses segments, and `[...]` is a class.
 */
export function globToRegExp(glob: string): RegExp {
	let out = "^";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index]!;
		if (char === "*") {
			if (glob[index + 1] === "*") {
				out += ".*";
				index++;
			} else {
				out += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			out += "[^/]";
			continue;
		}
		if (char === "[") {
			const end = glob.indexOf("]", index + 1);
			if (end === -1) {
				out += "\\[";
				continue;
			}
			let body = glob.slice(index + 1, end);
			if (body.startsWith("!")) body = `^${body.slice(1)}`;
			out += `[${body}]`;
			index = end;
			continue;
		}
		out += char.replace(/[.+^${}()|\\\]]/g, "\\$&");
	}
	return new RegExp(`${out}$`, "i");
}

/** 1048576 -> "1.0M", 262144 -> "262k", 32768 -> "33k". */
export function formatTokens(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(Math.round(value));
}

export function formatCost(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "-";
	if (value === 0) return "0";
	return value < 1 ? String(Number(value.toFixed(4))) : String(Number(value.toFixed(2)));
}

/** Truncate to a visible width, optionally padding with spaces to fill it. */
export function fit(text: string, width: number, align: "left" | "right" = "left"): string {
	const width_ = Math.max(0, width);
	const clipped = truncateToWidth(text, width_);
	const gap = width_ - visibleWidth(clipped);
	if (gap <= 0) return clipped;
	return align === "right" ? " ".repeat(gap) + clipped : clipped + " ".repeat(gap);
}

export function clip(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width));
}

/** A horizontal rule whose embedded title stays visible at any width. */
export function rule(title: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(title) >= width) return clip(title, width);
	return title + "─".repeat(width - visibleWidth(title));
}

/** Human display for an arbitrary config value. */
export function describeValue(value: unknown): string {
	if (value === undefined) return "inherit";
	if (value === null) return "unsupported";
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return value === "" ? '""' : value;
	if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map((entry) => String(entry)).join(",");
	if (isObject(value)) {
		const compact = JSON.stringify(value);
		return compact.length > 60 ? `${compact.slice(0, 57)}...` : compact;
	}
	return String(value);
}

/** Stable key for a provider/model pair. */
export function modelKey(provider: string, id: string): string {
	return `${provider}\u0000${id}`;
}
