// Reading and writing pi's JSON config files without losing data.
//
// Writes are: read current file -> mutate parsed object -> back up -> write a
// temp file -> rename over the original. That keeps unknown keys, key order, and
// file permissions intact, and never truncates a file that failed to parse.
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type JsonObject, isObject } from "./util.ts";

/** Newest backups kept per file. */
const MAX_BACKUPS = 20;

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

export interface WriteOptions {
	/** Copy the previous contents to `<file>.bak-<timestamp>` first. Default true. */
	backup?: boolean;
}

/**
 * Read-modify-write one JSON file. The mutator receives the parsed object and
 * edits it in place. Throws when the file exists but cannot be parsed, because
 * overwriting a broken file would destroy whatever the user hand-wrote.
 */
export function updateJsonFile(path: string, mutate: (data: JsonObject) => void, options: WriteOptions = {}): void {
	const current = readJsonFile(path);
	if (current.exists && current.error) {
		throw new Error(`${current.error} — fix or move the file first; refusing to overwrite it.`);
	}
	const data = current.data ?? {};
	mutate(data);
	const text = `${JSON.stringify(data, null, 2)}\n`;
	// No-op edits (reset to the inherited value, re-selecting the same default)
	// must not spray backups into the agent directory.
	if (current.text === text) return;
	if (options.backup !== false && current.text !== undefined) backupFile(path);
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

/** Copy a config file to `<file>.bak-YYYYMMDD-HHmmss`, pruning old backups. */
export function backupFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const target = `${path}.bak-${timestamp()}`;
	try {
		copyFileSync(path, target);
	} catch {
		return undefined;
	}
	pruneBackups(path);
	return target;
}

export function listBackups(path: string): string[] {
	const directory = dirname(path);
	const prefix = `${basename(path)}.bak-`;
	try {
		return readdirSync(directory)
			.filter((name) => name.startsWith(prefix))
			.sort()
			.map((name) => join(directory, name));
	} catch {
		return [];
	}
}

function pruneBackups(path: string): void {
	const backups = listBackups(path);
	for (const stale of backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))) {
		try {
			unlinkSync(stale);
		} catch {
			// best effort
		}
	}
}

function timestamp(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
