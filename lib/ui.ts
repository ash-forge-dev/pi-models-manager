// The interactive screen: a model table over an editable form.
//
// One provider per screen: its models listed above, the highlighted model's
// overridable fields below. Every field write goes straight to models.json (or
// settings.json for the cycle scope), then the registry is refreshed so the table
// immediately shows the effect.
import type { ExtensionUIContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	clearModelOverrides,
	ensureEndpointBlock,
	listEndpoints,
	modelRows,
	providersWithUsableModels,
	setModelOverride,
	type EndpointRow,
	type ModelRow,
} from "./catalog.ts";
import { modelFields, providerFields, type FieldSpec, type FieldWriter } from "./fields.ts";
import { probeChat, probeModels, resolveEndpointAuth } from "./probe.ts";
import {
	isModelInScope,
	moveModelInScope,
	projectScopeOverride,
	readSettings,
	scopePosition,
	toggleModelInScope,
} from "./settings.ts";
import { messageOf, modelsJsonPath, projectSettingsPath, readJsonFile } from "./store.ts";
import { asObject, clip, fit, formatTokens, type JsonObject } from "./util.ts";

/**
 * Column legend, shown on the models screen when nothing else needs the line.
 * `D` is read-only here: the default model belongs to /model, and having two writers
 * for defaultProvider/defaultModel is how the value silently diverges.
 */
const LEGEND = ["● in cycle", "○ out", "* overridden", "R reasoning", "V vision", "A usable", "D default"] as const;

const MAX_ROWS = 8;
const MAX_FIELDS = 9;
const LABEL_WIDTH = 24;

export interface ManagerHost {
	registry: ModelRegistry;
	cwd: string;
	ui: ExtensionUIContext;
	/** Persist a models.json change, then refresh the registry from disk. */
	saveModels(mutate: (models: JsonObject) => void): Promise<void>;
	/** Persist a settings.json change. */
	saveSettings(mutate: (settings: JsonObject) => void): Promise<void>;
	/** Re-run discovery for one provider, returning human-readable problems. */
	refreshEndpoint(providerId: string): Promise<string[]>;
	/** Take ownership of discovery for a provider this tool just created. */
	adoptEndpoint?(providerId: string): Promise<void>;
	/** Delete a provider block (and its scope patterns). */
	removeEndpoint?(providerId: string): Promise<void>;
}

export interface ManagerResult {
	/** True when enabledModels or the default model changed, so pi needs a reload. */
	settingsChanged: boolean;
}

type Pane = "models" | "endpoint" | "diagnostics";
type Focus = "list" | "form";
type DiagnosticKind = "ok" | "bad" | "info" | "warn";

interface Message {
	text: string;
	kind: "info" | "success" | "error";
}

interface Editing {
	field: FieldSpec;
	input: Input;
}

interface Prompt {
	label: string;
	input: Input;
}

export class ModelsManagerComponent implements Component, Focusable {
	focused = true;
	readonly capturesViewportInput = true;

	private pane: Pane = "models";
	private returnPane: Pane = "models";
	private focus: Focus = "list";
	private modelsJson: JsonObject = {};
	private modelsError: string | undefined;
	private settingsError: string | undefined;
	private endpoints: EndpointRow[] = [];
	private endpointIndex = 0;
	private pendingEndpointId: string | undefined;
	private rows: ModelRow[] = [];
	private rowIndex = 0;
	private fields: FieldSpec[] = [];
	private fieldIndex = 0;
	private scope: string[] | undefined;
	private defaultProvider: string | undefined;
	private defaultModel: string | undefined;
	private projectScope: { path: string; patterns: string[] } | undefined;
	private editing: Editing | undefined;
	private prompt: Prompt | undefined;
	private filterInput: Input | undefined;
	private filter: string | undefined;
	private pendingDelete: string | undefined;
	private message: Message | undefined;
	private diagnostics: Array<{ kind: DiagnosticKind; text: string }> = [];
	private diagnosticsOffset = 0;
	private busy = false;
	private settingsChanged = false;
	private queue: Promise<void> = Promise.resolve();
	private cache: { width: number; lines: string[] } | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (result: ManagerResult) => void,
		private readonly host: ManagerHost,
	) {}

	// -------------------------------------------------------------------- state

	async load(): Promise<void> {
		const read = readJsonFile(modelsJsonPath());
		this.modelsJson = asObject(read.data);
		this.modelsError = read.error;
		const settings = readSettings();
		this.settingsError = settings.error;
		this.scope = settings.enabledModels;
		this.defaultProvider = settings.defaultProvider;
		this.defaultModel = settings.defaultModel;
		this.projectScope = projectScopeOverride(projectSettingsPath(this.host.cwd));
		this.endpoints = listEndpoints(this.host.registry, this.modelsJson);
		if (this.pendingEndpointId) {
			const index = this.endpoints.findIndex((endpoint) => endpoint.id === this.pendingEndpointId);
			if (index >= 0) this.endpointIndex = index;
			this.pendingEndpointId = undefined;
		}
		if (this.endpointIndex >= this.endpoints.length) this.endpointIndex = Math.max(0, this.endpoints.length - 1);
		this.rebuildRows();
		this.rebuildFields();
	}

	private currentEndpoint(): EndpointRow | undefined {
		return this.endpoints[this.endpointIndex];
	}

	private currentRow(): ModelRow | undefined {
		return this.rows[this.rowIndex];
	}

	private rebuildRows(): void {
		const endpoint = this.currentEndpoint();
		const rows = endpoint ? modelRows(this.host.registry, this.modelsJson, endpoint.id) : [];
		const needle = this.filter?.toLowerCase();
		const filtered = needle ? rows.filter((row) => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle)) : rows;
		const position = (row: ModelRow) => scopePosition(this.scope, row.provider, row.id);
		filtered.sort((left, right) => {
			// Discovered models first, then stale override-only rows.
			if (left.inRegistry !== right.inRegistry) return left.inRegistry ? -1 : 1;
			const leftPos = position(left);
			const rightPos = position(right);
			if (leftPos !== undefined || rightPos !== undefined) {
				if (leftPos === undefined) return 1;
				if (rightPos === undefined) return -1;
				if (leftPos !== rightPos) return leftPos - rightPos;
			}
			if (left.available !== right.available) return left.available ? -1 : 1;
			return left.id.localeCompare(right.id);
		});
		this.rows = filtered;
		if (this.rowIndex >= filtered.length) this.rowIndex = Math.max(0, filtered.length - 1);
	}

	private rebuildFields(): void {
		const endpoint = this.currentEndpoint();
		if (this.pane === "endpoint") {
			this.fields = endpoint
				? providerFields({
						providerId: endpoint.id,
						modelsJson: this.modelsJson,
						write: this.writer(),
						modelIds: modelRows(this.host.registry, this.modelsJson, endpoint.id)
							.filter((row) => row.inRegistry)
							.map((row) => row.id),
					})
				: [];
		} else {
			const row = this.currentRow();
			this.fields =
				row && endpoint
					? modelFields({ providerId: endpoint.id, row, modelsJson: this.modelsJson, write: this.writer() })
					: [];
		}
		if (this.fieldIndex >= this.fields.length) this.fieldIndex = Math.max(0, this.fields.length - 1);
	}

	private writer(): FieldWriter {
		return {
			models: (mutate) => this.host.saveModels(mutate),
			allModels: async (providerId, key, value) => {
				const ids = modelRows(this.host.registry, this.modelsJson, providerId)
					.filter((row) => row.inRegistry)
					.map((row) => row.id);
				if (ids.length === 0) throw new Error("no discovered models to apply this to");
				await this.host.saveModels((models) => {
					for (const id of ids) setModelOverride(models, providerId, id, [key], value);
				});
			},
		};
	}

	/** Model ids of the current provider that the scope could actually use. */
	private scopeArgs() {
		const endpoint = this.currentEndpoint();
		const row = this.currentRow();
		if (!endpoint || !row) return undefined;
		return {
			row,
			endpoint,
			args: {
				provider: endpoint.id,
				modelId: row.id,
				providerModelIds: modelRows(this.host.registry, this.modelsJson, endpoint.id)
					.filter((entry) => entry.inRegistry && entry.available)
					.map((entry) => entry.id),
				otherProviderIds: providersWithUsableModels(this.host.registry, endpoint.id),
			},
		};
	}

	// ---------------------------------------------------------------- mutations

	private enqueue(task: () => Promise<void>, success?: string): void {
		this.queue = this.queue
			.then(async () => {
				try {
					this.busy = true;
					this.invalidate();
					await task();
					await this.load();
					if (success) this.message = { text: success, kind: "success" };
				} catch (error) {
					this.message = { text: messageOf(error), kind: "error" };
				} finally {
					this.busy = false;
					this.invalidate();
				}
			})
			.catch(() => undefined);
	}

	private toggleScope(): void {
		const context = this.scopeArgs();
		if (!context) return;
		if (!context.row.available) {
			this.message = { text: "not usable (no credentials) — scope can only list usable models", kind: "error" };
			this.invalidate();
			return;
		}
		const wasInScope = isModelInScope(this.scope, context.row.provider, context.row.id);
		const next = toggleModelInScope(this.scope, context.args);
		this.settingsChanged = true;
		this.enqueue(
			() => this.host.saveSettings((settings) => setEnabledModels(settings, next)),
			wasInScope ? "removed from cycle scope" : "added to cycle scope",
		);
	}

	private reorderScope(delta: -1 | 1): void {
		const context = this.scopeArgs();
		if (!context) return;
		const next = moveModelInScope(this.scope, context.args, delta);
		this.settingsChanged = true;
		this.enqueue(() => this.host.saveSettings((settings) => setEnabledModels(settings, next)), "cycle order updated");
	}

	private resetOverrides(): void {
		const row = this.currentRow();
		const endpoint = this.currentEndpoint();
		if (!row || !endpoint) return;
		if (row.overriddenKeys.length === 0) {
			this.message = { text: "no overrides to reset", kind: "info" };
			this.invalidate();
			return;
		}
		this.enqueue(
			() => this.host.saveModels((models) => clearModelOverrides(models, endpoint.id, row.id)),
			`cleared ${row.overriddenKeys.length} override(s)`,
		);
	}

	private refreshEndpoint(): void {
		const endpoint = this.currentEndpoint();
		if (!endpoint) return;
		this.enqueue(async () => {
			const problems = await this.host.refreshEndpoint(endpoint.id);
			this.message =
				problems.length > 0
					? { text: `refresh problems: ${problems.join("; ")}`, kind: "error" }
					: { text: `re-discovered ${endpoint.id}`, kind: "success" };
		});
	}

	private beginEdit(field: FieldSpec): void {
		if (!field.apply) return;
		const input = new Input({ placeholder: field.display });
		if (field.editStyle !== "blank") input.setValue(field.raw);
		input.focused = true;
		input.onEscape = () => {
			this.editing = undefined;
			this.invalidate();
		};
		input.onSubmit = (value: string) => {
			this.editing = undefined;
			// A blank "blank"-style submit means "leave it alone", not "clear it".
			if (field.editStyle === "blank" && value.trim() === "") {
				this.invalidate();
				return;
			}
			this.enqueue(async () => {
				await field.apply?.(value);
			}, "saved");
		};
		this.editing = { field, input };
		this.invalidate();
	}

	private clearField(): void {
		const field = this.fields[this.fieldIndex];
		if (!field) return;
		if (!field.isSet) {
			this.message = { text: `${field.label} is not overridden`, kind: "info" };
			this.invalidate();
			return;
		}
		this.enqueue(async () => {
			if (field.clear) await field.clear();
			else await field.apply?.(undefined);
		}, `${field.label} → inherited`);
	}

	private stepField(delta: 1 | -1): void {
		const field = this.fields[this.fieldIndex];
		if (!field?.step) return;
		this.enqueue(async () => {
			await field.step?.(delta);
		});
	}

	private addEndpoint(): void {
		this.startPrompt("new provider id", "", (rawId) => {
			const id = rawId.trim();
			if (!id) {
				this.message = { text: "provider id is required", kind: "error" };
				this.invalidate();
				return;
			}
			if (this.endpoints.some((endpoint) => endpoint.id === id)) {
				this.message = { text: `provider ${id} already exists`, kind: "error" };
				this.invalidate();
				return;
			}
			this.startPrompt("baseUrl", "http://localhost:8000/v1", (rawUrl) => {
				const baseUrl = rawUrl.trim() || "http://localhost:8000/v1";
				this.pendingEndpointId = id;
				this.enqueue(async () => {
					await this.host.saveModels((models) => {
						ensureEndpointBlock(models, id, baseUrl, "openai-completions");
					});
					// Start discovering it right away, so the table fills up without a restart.
					await this.host.adoptEndpoint?.(id);
				}, `created ${id} — press r to re-discover`);
				// Land in the endpoint form so the connection settings are right there.
				this.pane = "endpoint";
				this.focus = "form";
				this.fieldIndex = 0;
			});
		});
	}

	private startPrompt(label: string, initial: string, onValue: (value: string) => void): void {
		const input = new Input({ placeholder: label });
		input.setValue(initial);
		input.focused = true;
		input.onSubmit = (value: string) => {
			this.prompt = undefined;
			onValue(value);
			this.invalidate();
		};
		input.onEscape = () => {
			this.prompt = undefined;
			this.invalidate();
		};
		this.prompt = { label, input };
		this.invalidate();
	}

	// -------------------------------------------------------------- diagnostics

	private async buildDiagnostics(): Promise<void> {
		const items: Array<{ kind: DiagnosticKind; text: string }> = [];
		const add = (kind: DiagnosticKind, text: string) => items.push({ kind, text });
		const flush = () => {
			this.diagnostics = [...items];
			this.invalidate();
		};

		add(this.modelsError ? "bad" : "ok", this.modelsError ? `models.json: ${this.modelsError}` : "models.json parses");
		add(this.settingsError ? "bad" : "ok", this.settingsError ? `settings.json: ${this.settingsError}` : "settings.json parses");
		if (this.projectScope) add("warn", `${this.projectScope.path} sets enabledModels and overrides the global scope`);
		const registryError = this.host.registry.getError();
		if (registryError) add("bad", `registry: ${registryError}`);

		const endpoint = this.currentEndpoint();
		if (!endpoint) {
			add("bad", "no custom endpoint in models.json — press n to create one");
			flush();
			return;
		}

		add("info", `${endpoint.id} · ${endpoint.baseUrl ?? "(no baseUrl)"} · api ${endpoint.api ?? "(unset)"}`);
		add(
			endpoint.authConfigured ? "ok" : "bad",
			endpoint.authConfigured
				? `credentials: ${endpoint.authSource ?? "configured"}`
				: "no credentials (apiKey in models.json, /login, or the provider's env var)",
		);
		add(endpoint.models > 0 ? "ok" : "warn", `${endpoint.models} model(s) in registry, ${endpoint.available} usable`);
		add("info", this.scope && this.scope.length > 0 ? `cycle scope: ${this.scope.length} pattern(s)` : "cycle scope: all usable models (enabledModels unset)");

		const row = this.currentRow();
		if (row) {
			const reason = this.explainRow(row);
			if (reason) add("warn", `${row.id}: ${reason}`);
			else add("ok", `${row.id}: usable and in scope`);
		}
		flush();

		// Network checks are slow, so they land in a second pass.
		const auth = await resolveEndpointAuth(this.host.registry, endpoint.id);
		if (auth.error) add("bad", `auth resolution: ${auth.error}`);
		const models = await probeModels(auth.baseUrl ?? endpoint.baseUrl, auth);
		add(models.ok ? "ok" : "bad", `GET ${models.url} → ${models.ok ? `${models.detail} in ${models.ms}ms` : models.error}`);
		if (row) {
			if (models.ok && models.ids) {
				const listed = models.ids.includes(row.id);
				add(listed ? "ok" : "warn", listed ? `endpoint lists ${row.id}` : `endpoint does not list ${row.id}`);
			}
			const chat = await probeChat(auth.baseUrl ?? endpoint.baseUrl, auth, row.id, { api: endpoint.api });
			add(chat.ok ? "ok" : "bad", `chat probe → ${chat.ok ? `${chat.detail} in ${chat.ms}ms` : chat.error}`);
		}
		flush();
	}

	private explainRow(row: ModelRow): string | undefined {
		if (!row.inRegistry) return "not returned by the provider; only a saved override remains";
		if (!row.available) {
			return this.currentEndpoint()?.authConfigured
				? "provider does not report credentials for this model"
				: "provider has no credentials";
		}
		if (!isModelInScope(this.scope, row.provider, row.id)) return "outside enabledModels scope (affects cycling and startup only)";
		return undefined;
	}

	// ------------------------------------------------------------------ render

	invalidate(): void {
		this.cache = undefined;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const usable = Math.max(24, width);
		if (this.cache && this.cache.width === usable) return this.cache.lines;
		this.syncFocus();
		const lines = [this.renderHeader(usable), this.rule(usable)];
		if (this.pane === "models") this.renderModelsPane(lines, usable);
		else if (this.pane === "endpoint") this.renderEndpointPane(lines, usable);
		else this.renderDiagnosticsPane(lines, usable);
		lines.push(this.rule(usable));
		lines.push(...this.renderFooter(usable));
		const padded = lines.map((line) => truncateToWidth(line, usable, "", true));
		this.cache = { width: usable, lines: padded };
		return padded;
	}

	/** The embedded inputs must know whether the screen currently owns the keyboard. */
	private syncFocus(): void {
		if (this.editing) this.editing.input.focused = this.focused;
		if (this.prompt) this.prompt.input.focused = this.focused;
		if (this.filterInput) this.filterInput.focused = this.focused;
	}

	private rule(width: number): string {
		return this.theme.fg("border", "─".repeat(width));
	}

	/**
	 * Render a key/legend line: joined with " · " and wrapped up to two lines, so a
	 * narrow terminal never silently loses "q close" or "n new".
	 */
	private hint(parts: readonly string[], width: number, maxLines = 2): string[] {
		// Wrap by fragment, never mid-phrase: a legend that reads "… V vision · A" /
		// "usable · D default" is worse than dropping the tail of the list.
		const budget = Math.max(8, width - 2);
		const lines: string[] = [];
		let current = "";
		for (const part of parts) {
			const candidate = current === "" ? part : `${current} · ${part}`;
			if (visibleWidth(candidate) <= budget) {
				current = candidate;
				continue;
			}
			if (current !== "") lines.push(current);
			current = part;
		}
		if (current !== "") lines.push(current);
		if (lines.length > maxLines) {
			const kept = lines.slice(0, maxLines);
			kept[maxLines - 1] = clip(`${kept[maxLines - 1]}…`, budget);
			return kept.map((line) => `  ${line}`);
		}
		return lines.map((line) => clip(`  ${line}`, width));
	}

	/** Wrap a long line (parse errors, probe failures) instead of cutting it off. */
	private wrap(text: string, width: number, maxLines: number): string[] {
		const lines = wrapTextWithAnsi(text, Math.max(8, width));
		if (lines.length <= maxLines) return lines;
		return [...lines.slice(0, maxLines - 1), clip(`${lines[maxLines - 1] ?? ""}…`, width)];
	}

	private renderHeader(width: number): string {
		const endpoint = this.currentEndpoint();
		const title = this.pane === "models" ? "Models" : this.pane === "endpoint" ? "Endpoint" : "Checks";
		const left =
			` ${this.theme.fg("accent", this.theme.bold(title))}` + (endpoint ? this.theme.fg("muted", ` · ${endpoint.id}`) : "");
		const parts: string[] = [];
		if (this.endpoints.length > 1) parts.push(`endpoint ${this.endpointIndex + 1}/${this.endpoints.length}`);
		if (this.pane === "models") {
			if (this.rows.length > 0) {
				const inScope = this.rows.filter((row) => isModelInScope(this.scope, row.provider, row.id)).length;
				parts.push(`${inScope}/${this.rows.length} models in cycle`);
			}
			if (this.filter) parts.push(`filter "${this.filter}"`);
		}
		if (endpoint && this.pane !== "diagnostics") parts.push(endpoint.authConfigured ? "auth ok" : "no auth");
		const right = parts.length > 0 ? this.theme.fg("dim", `${parts.join(" · ")} `) : "";
		return this.twoColumn(left, right, width);
	}

	private twoColumn(left: string, right: string, width: number): string {
		const gap = width - visibleWidth(left) - visibleWidth(right);
		if (gap < 1) return clip(`${left} ${right}`, width);
		return `${left}${" ".repeat(gap)}${right}`;
	}

	/** Row layout: 6 columns of markers + id + ctx + out + 4 flag cells. */
	private idWidth(width: number): number {
		return Math.max(12, width - 25);
	}

	private renderModelsPane(lines: string[], width: number): void {
		if (this.modelsError) {
			for (const line of this.wrap(`  ${this.modelsError}`, width, 2)) lines.push(this.theme.fg("error", line));
		}
		const idWidth = this.idWidth(width);
		lines.push(this.theme.fg("dim", `  ${fit("model", idWidth)} ${fit("ctx", 6, "right")} ${fit("out", 6, "right")} RVAD`));

		if (this.rows.length === 0) {
			const empty =
				this.endpoints.length === 0
					? "no endpoints yet — press n to add yours (id + baseUrl)"
					: "no models here — r re-discovers, e edits the endpoint, v diagnoses";
			lines.push(this.theme.fg("dim", clip(`  ${empty}`, width)));
		} else {
			const start = windowStart(this.rowIndex, this.rows.length, MAX_ROWS);
			for (let index = start; index < Math.min(this.rows.length, start + MAX_ROWS); index++) {
				lines.push(this.renderModelRow(this.rows[index]!, index, width));
			}
			if (this.rows.length > MAX_ROWS) lines.push(this.theme.fg("dim", `  … row ${this.rowIndex + 1} of ${this.rows.length}`));
		}

		lines.push(this.rule(width));
		const row = this.currentRow();
		if (!row) {
			lines.push(this.theme.fg("dim", "  select a model to edit its overrides"));
			return;
		}
		const overrides = row.overriddenKeys.length > 0 ? row.overriddenKeys.join(", ") : "none";
		lines.push(this.twoColumn(` ${this.theme.fg("accent", row.id)}`, this.theme.fg("dim", `overrides: ${overrides} `), width));
		const details = [
			`name ${row.name !== row.id ? row.name : "(same as id)"}`,
			`api ${row.api}`,
			row.inRegistry ? undefined : "stale",
			row.available ? undefined : "unusable",
		].filter(Boolean);
		lines.push(this.theme.fg("dim", clip(`  ${details.join(" · ")}`, width)));
		this.renderFields(lines, width);
	}

	private renderEndpointPane(lines: string[], width: number): void {
		const endpoint = this.currentEndpoint();
		if (!endpoint) {
			lines.push(this.theme.fg("dim", "  no custom endpoint in models.json — press n on the models screen to create one"));
			return;
		}
		const status = [
			endpoint.id,
			`${endpoint.models} model(s) discovered`,
			endpoint.registered ? "extension-registered" : "in models.json",
			endpoint.inModelsJson ? undefined : "no models.json block yet",
		].filter(Boolean);
		lines.push(this.theme.fg("dim", clip(`  ${status.join(" · ")}`, width)));
		lines.push(this.rule(width));
		this.renderFields(lines, width);
	}

	private renderFields(lines: string[], width: number): void {
		if (this.fields.length === 0) {
			lines.push(this.theme.fg("dim", "  no editable fields"));
			return;
		}
		const start = windowStart(this.fieldIndex, this.fields.length, MAX_FIELDS);
		for (let index = start; index < Math.min(this.fields.length, start + MAX_FIELDS); index++) {
			lines.push(this.renderField(this.fields[index]!, index, width));
		}
		if (this.fields.length > MAX_FIELDS) lines.push(this.theme.fg("dim", `  … field ${this.fieldIndex + 1} of ${this.fields.length}`));
	}

	private renderModelRow(row: ModelRow, index: number, width: number): string {
		const selected = index === this.rowIndex;
		const inScope = isModelInScope(this.scope, row.provider, row.id);
		const isDefault = this.defaultProvider === row.provider && this.defaultModel === row.id;
		const cursor = selected ? this.theme.fg("accent", "▸ ") : "  ";
		const toggle = inScope ? this.theme.fg("success", "● ") : this.theme.fg("dim", "○ ");
		const marker = row.overriddenKeys.length > 0 ? this.theme.fg("warning", "* ") : "  ";
		const flags =
			(row.reasoning ? this.theme.fg("accent", "R") : this.theme.fg("dim", "·")) +
			(row.input.includes("image") ? this.theme.fg("accent", "V") : this.theme.fg("dim", "·")) +
			(row.available ? this.theme.fg("success", "A") : this.theme.fg("dim", "·")) +
			(isDefault ? this.theme.fg("accent", "D") : this.theme.fg("dim", "·"));
		const idWidth = this.idWidth(width);
		const id = clip(row.id, idWidth);
		const idText = selected ? this.theme.fg("accent", id) : row.available ? id : this.theme.fg("dim", id);
		const padding = " ".repeat(Math.max(0, idWidth - visibleWidth(id)));
		return (
			`${cursor}${toggle}${marker}${idText}${padding}` +
			` ${fit(formatTokens(row.contextWindow), 6, "right")}` +
			` ${fit(formatTokens(row.maxTokens), 6, "right")} ${flags}`
		);
	}

	private renderField(field: FieldSpec, index: number, width: number): string {
		const selected = this.focus === "form" && index === this.fieldIndex;
		const cursor = selected ? this.theme.fg("accent", "▸ ") : "  ";
		const label = fit(field.label, LABEL_WIDTH);
		const labelText = this.theme.fg(selected ? "accent" : "muted", label);
		const marker = field.isSet ? this.theme.fg("warning", " *") : "  ";
		const valueWidth = Math.max(8, width - 2 - LABEL_WIDTH - 3);
		if (this.editing && this.editing.field === field) {
			const rendered = this.editing.input.render(valueWidth)[0] ?? "";
			return `${cursor}${labelText} ${rendered}`;
		}
		const value = fit(field.display, valueWidth);
		const valueText = field.isSet ? this.theme.fg("text", value) : this.theme.fg("dim", value);
		return `${cursor}${labelText} ${valueText}${marker}`;
	}

	private renderDiagnosticsPane(lines: string[], width: number): void {
		if (this.diagnostics.length === 0) {
			lines.push(this.theme.fg("dim", "  running checks…"));
			return;
		}
		const height = MAX_ROWS + MAX_FIELDS;
		const start = windowStart(this.diagnosticsOffset, this.diagnostics.length, height);
		for (let index = start; index < Math.min(this.diagnostics.length, start + height); index++) {
			const entry = this.diagnostics[index]!;
			const icon =
				entry.kind === "ok"
					? this.theme.fg("success", "✓")
					: entry.kind === "bad"
						? this.theme.fg("error", "✗")
						: entry.kind === "warn"
							? this.theme.fg("warning", "!")
							: this.theme.fg("dim", "·");
			const text = entry.kind === "info" ? this.theme.fg("muted", entry.text) : entry.text;
			lines.push(clip(` ${icon} ${text}`, width));
		}
	}

	private renderFooter(width: number): string[] {
		const lines: string[] = [];
		if (this.prompt) {
			const rendered = this.prompt.input.render(Math.max(8, width - this.prompt.label.length - 4))[0] ?? "";
			lines.push(`  ${this.theme.fg("accent", this.prompt.label)} ${rendered}`);
			lines.push(this.theme.fg("dim", "  enter confirm · esc cancel"));
			return lines;
		}
		if (this.editing) {
			lines.push(this.theme.fg("dim", "  enter save · esc cancel · empty value removes the override"));
			return lines;
		}
		if (this.filterInput) {
			const rendered = this.filterInput.render(Math.max(8, width - 10))[0] ?? "";
			lines.push(`  filter ${rendered}`);
			lines.push(this.theme.fg("dim", "  enter apply · esc clear"));
			return lines;
		}
		if (this.pane === "diagnostics") {
			for (const line of this.hint(["↑↓ scroll", "r rerun", "esc back", "q close"], width)) {
				lines.push(this.theme.fg("dim", line));
			}
			if (this.message) lines.push(...this.colorMessage(this.message, width));
			return lines;
		}
		if (this.pane === "endpoint") {
			for (const line of this.hint(
				["↑↓ field", "enter edit", "space/←→ cycle", "x reset", "D delete", "v checks", "esc back", "q close"],
				width,
			)) {
				lines.push(this.theme.fg("dim", line));
			}
			if (this.pendingDelete) {
				lines.push(...this.wrap(`  press D again to delete ${this.pendingDelete} (any other key cancels)`, width, 2).map((line) => this.theme.fg("warning", line)));
			} else if (this.message) {
				lines.push(...this.colorMessage(this.message, width));
			} else {
				lines.push(this.theme.fg("dim", `  ${this.busy ? "working…" : "changes save as you go"}`));
			}
			return lines;
		}

		for (const line of this.hint(
			["↑↓ move", "tab/enter edit", "space cycle", "[ ] endpoint", "n new", "e endpoint", "v checks", "r discover", "x reset", "q close"],
			width,
		)) {
			lines.push(this.theme.fg("dim", line));
		}
		const hint = this.focus === "form" ? this.fields[this.fieldIndex]?.hint : undefined;
		if (this.message) lines.push(...this.colorMessage(this.message, width));
		else if (hint) lines.push(...this.wrap(`  ${hint}`, width, 2).map((line) => this.theme.fg("dim", line)));
		else if (this.busy) lines.push(this.theme.fg("dim", "  working…"));
		else lines.push(...this.hint(LEGEND, width).map((line) => this.theme.fg("dim", line)));
		return lines;
	}

	private colorMessage(message: Message, width: number): string[] {
		const color = message.kind === "error" ? "error" : message.kind === "success" ? "success" : "muted";
		return this.wrap(`  ${message.text}`, width, 2).map((line) => this.theme.fg(color, line));
	}

	// ------------------------------------------------------------------- input

	handleInput(data: string): void {
		if (this.prompt) {
			this.prompt.input.handleInput(data);
			this.invalidate();
			return;
		}
		if (this.editing) {
			this.editing.input.handleInput(data);
			this.invalidate();
			return;
		}
		if (this.filterInput) {
			this.filterInput.handleInput(data);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.done({ settingsChanged: this.settingsChanged });
			return;
		}
		if (this.pane === "diagnostics") {
			this.handleDiagnosticsInput(data);
			return;
		}
		if (this.pane === "endpoint") {
			this.handleFormInput(data);
			return;
		}
		this.handleModelsInput(data);
	}

	private handleModelsInput(data: string): void {
		if (matchesKey(data, "q")) {
			this.done({ settingsChanged: this.settingsChanged });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.focus === "form") {
				this.focus = "list";
				this.invalidate();
				return;
			}
			this.done({ settingsChanged: this.settingsChanged });
			return;
		}
		if (matchesKey(data, Key.tab)) {
			if (this.fields.length > 0) this.focus = this.focus === "list" ? "form" : "list";
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.up)) return this.move(-1);
		if (matchesKey(data, Key.down)) return this.move(1);
		if (matchesKey(data, Key.pageUp)) return this.move(-MAX_ROWS);
		if (matchesKey(data, Key.pageDown)) return this.move(MAX_ROWS);
		if (matchesKey(data, Key.shift("up"))) return this.reorderScope(-1);
		if (matchesKey(data, Key.shift("down"))) return this.reorderScope(1);
		if (matchesKey(data, Key.leftbracket)) return this.switchEndpoint(-1);
		if (matchesKey(data, Key.rightbracket)) return this.switchEndpoint(1);
		if (matchesKey(data, Key.slash)) return this.startFilter();
		if (matchesKey(data, "r")) return this.refreshEndpoint();
		if (matchesKey(data, "n")) return this.addEndpoint();
		if (matchesKey(data, "e")) {
			this.pane = "endpoint";
			this.focus = "form";
			this.fieldIndex = 0;
			this.rebuildFields();
			this.invalidate();
			return;
		}
		if (matchesKey(data, "v")) return this.openDiagnostics();
		if (matchesKey(data, "x")) {
			if (this.focus === "form") this.clearField();
			else this.resetOverrides();
			return;
		}
		if (matchesKey(data, Key.space)) {
			if (this.focus === "form") this.stepField(1);
			else this.toggleScope();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.focus === "list") {
				if (this.fields.length > 0) this.focus = "form";
				this.invalidate();
				return;
			}
			this.activateField();
			return;
		}
		if (matchesKey(data, Key.right)) {
			if (this.focus === "form") this.stepField(1);
			return;
		}
		if (matchesKey(data, Key.left)) {
			if (this.focus === "form") this.stepField(-1);
		}
	}

	private handleFormInput(data: string): void {
		if (matchesKey(data, "q")) {
			this.done({ settingsChanged: this.settingsChanged });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.pane = "models";
			this.focus = "list";
			this.rebuildFields();
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.fieldIndex = Math.max(0, this.fieldIndex - 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.fieldIndex = Math.min(Math.max(0, this.fields.length - 1), this.fieldIndex + 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.fieldIndex = Math.max(0, this.fieldIndex - MAX_FIELDS);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.fieldIndex = Math.min(Math.max(0, this.fields.length - 1), this.fieldIndex + MAX_FIELDS);
			this.invalidate();
			return;
		}
		if (this.pendingDelete) {
			const confirmed = matchesKey(data, Key.shift("d")) || data === "D";
			const target = this.pendingDelete;
			this.pendingDelete = undefined;
			if (!confirmed) {
				this.message = { text: "delete cancelled", kind: "info" };
				this.invalidate();
				return;
			}
			if (target) {
				// Its scope patterns go with it, so the session scope needs a reload.
				this.settingsChanged = true;
				this.enqueue(async () => {
					await this.host.removeEndpoint?.(target);
					this.endpointIndex = 0;
					this.rowIndex = 0;
					this.fieldIndex = 0;
					this.pane = "models";
					this.focus = "list";
				}, `deleted ${target}`);
			}
			return;
		}
		if (matchesKey(data, Key.shift("d")) || data === "D") {
			const endpoint = this.currentEndpoint();
			if (!endpoint) return;
			if (!endpoint.inModelsJson) {
				this.message = { text: `${endpoint.id} is not in models.json, so there is nothing to delete`, kind: "error" };
				this.invalidate();
				return;
			}
			this.pendingDelete = endpoint.id;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "x")) return this.clearField();
		if (matchesKey(data, "r")) return this.refreshEndpoint();
		if (matchesKey(data, "v")) return this.openDiagnostics();
		if (matchesKey(data, Key.space) || matchesKey(data, Key.right)) return this.stepField(1);
		if (matchesKey(data, Key.left)) return this.stepField(-1);
		if (matchesKey(data, Key.enter)) this.activateField();
	}

	private handleDiagnosticsInput(data: string): void {
		if (matchesKey(data, "q")) {
			this.done({ settingsChanged: this.settingsChanged });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.pane = this.returnPane;
			this.focus = this.returnPane === "endpoint" ? "form" : "list";
			this.rebuildFields();
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.diagnosticsOffset = Math.max(0, this.diagnosticsOffset - 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.diagnosticsOffset = Math.min(Math.max(0, this.diagnostics.length - 1), this.diagnosticsOffset + 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "r")) {
			this.diagnostics = [];
			this.invalidate();
			void this.buildDiagnostics();
		}
	}

	private activateField(): void {
		const field = this.fields[this.fieldIndex];
		if (!field) return;
		if (field.apply) this.beginEdit(field);
		else this.stepField(1);
	}

	private openDiagnostics(): void {
		if (this.pane !== "diagnostics") this.returnPane = this.pane;
		this.pane = "diagnostics";
		this.diagnostics = [];
		this.diagnosticsOffset = 0;
		this.invalidate();
		void this.buildDiagnostics();
	}

	private move(delta: number): void {
		if (this.focus === "form") {
			const next = this.fieldIndex + delta;
			if (next < 0 || next >= this.fields.length) this.focus = "list";
			else this.fieldIndex = next;
			this.invalidate();
			return;
		}
		if (this.rows.length === 0) return;
		this.rowIndex = Math.min(this.rows.length - 1, Math.max(0, this.rowIndex + delta));
		this.fieldIndex = 0;
		this.rebuildFields();
		this.invalidate();
	}

	private switchEndpoint(delta: number): void {
		if (this.endpoints.length < 2) return;
		this.endpointIndex = (this.endpointIndex + delta + this.endpoints.length) % this.endpoints.length;
		this.rowIndex = 0;
		this.fieldIndex = 0;
		this.rebuildRows();
		this.rebuildFields();
		this.invalidate();
	}

	private startFilter(): void {
		const input = new Input({ placeholder: "filter model id" });
		input.setValue(this.filter ?? "");
		input.focused = true;
		input.onSubmit = (value: string) => {
			this.filterInput = undefined;
			this.filter = value.trim() === "" ? undefined : value.trim();
			this.rowIndex = 0;
			this.rebuildRows();
			this.rebuildFields();
			this.invalidate();
		};
		input.onEscape = () => {
			this.filterInput = undefined;
			this.filter = undefined;
			this.rowIndex = 0;
			this.rebuildRows();
			this.rebuildFields();
			this.invalidate();
		};
		this.filterInput = input;
		this.invalidate();
	}
}

function windowStart(index: number, length: number, visible: number): number {
	if (length <= visible) return 0;
	const centered = index - Math.floor(visible / 2);
	return Math.max(0, Math.min(centered, length - visible));
}

/** Write the scope into a settings.json draft (shared by the scope actions). */
function setEnabledModels(settings: JsonObject, patterns: string[]): void {
	const cleaned = patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
	if (cleaned.length === 0) delete settings.enabledModels;
	else settings.enabledModels = cleaned;
}
