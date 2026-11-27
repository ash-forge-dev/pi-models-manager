// Reading and writing pi's JSON config files without losing data.
//
// Writes are: read the file -> mutate the parsed object -> write a temp file ->
// rename over the original. That keeps unknown keys, key order, and file
// permissions intact, and never truncates a file that failed to parse.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type JsonObject, isObject } from "./util.ts";

export function agentDir(): string {
	return getAgentDir();
}

export function modelsJsonPath(): string {
	return join(agentDir(), "models.json");
}

export function settingsJsonPath(): string {
	return join(agentDir(), "settings.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

export interface ReadJsonResult {
	/** Parsed object, or undefined when the file is missing or unparsable. */
	data: JsonObject | undefined;
	/** Raw text, when the file exists. */
	text?: string;
	exists: boolean;
	/** Parse/read failure, ready to show to a user. */
	error?: string;
}

export function readJsonFile(path: string): ReadJsonResult {
	if (!existsSync(path)) return { data: undefined, exists: false };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { data: undefined, exists: true, error: `cannot read ${path}: ${messageOf(error)}` };
	}
	if (text.trim() === "") return { data: {}, text, exists: true };
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isObject(parsed)) {
			return { data: undefined, text, exists: true, error: `${basename(path)} is not a JSON object` };
		}
		return { data: parsed, text, exists: true };
	} catch (error) {
		return { data: undefined, text, exists: true, error: `${basename(path)}: ${messageOf(error)}` };
	}
}

/**
 * Read-modify-write one JSON file. The mutator receives the parsed object and
 * edits it in place. Throws when the file exists but cannot be parsed, because
 * overwriting a broken file would destroy whatever the user hand-wrote.
 */
export function updateJsonFile(path: string, mutate: (data: JsonObject) => void): void {
	const current = readJsonFile(path);
	if (current.exists && current.error) {
		throw new Error(`${current.error} — fix or move the file first; refusing to overwrite it.`);
	}
	const data = current.data ?? {};
	mutate(data);
	const text = `${JSON.stringify(data, null, 2)}\n`;
	// No-op edits (reset to the inherited value, re-selecting the same scope) must
	// not rewrite the file.
	if (current.text === text) return;
	writeTextAtomic(path, text);
}

function writeTextAtomic(path: string, text: string): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	let mode = 0o600;
	if (existsSync(path)) {
		try {
			mode = statSync(path).mode & 0o777;
		} catch {
			// keep the default
		}
	}
	const temp = join(directory, `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
	writeFileSync(temp, text, { encoding: "utf8", mode });
	try {
		chmodSync(temp, mode);
	} catch {
		// best effort
	}
	renameSync(temp, path);
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
