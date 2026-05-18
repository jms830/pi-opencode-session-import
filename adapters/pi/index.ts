import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import {
	CUSTOM_MESSAGE_TYPE,
	DEFAULT_LIMIT,
	DEFAULT_MAX_TOOL_CHARS,
	assertDbUnchanged,
	buildSessionFileContent,
	canonicalIdFor,
	convertOpenCodeSession,
	findSessionFileByCanonicalId,
	formatImportStatus,
	formatSessionList,
	getDbMtimeMs,
	getImportedSession,
	loadImportRegistry,
	loadOpenCodeSession,
	listOpenCodeSessions,
	planBulkImport,
	recordImportedSession,
	resolveDefaultDbPath,
	saveImportRegistry,
	skippedSummary,
	type ConvertedImport,
	type OpenCodeSessionRow,
} from "../../src/core";

export * from "../../src/core";

type CommandContext = Parameters<ExtensionAPI["registerCommand"]>[1] extends { handler: (args: string, ctx: infer C) => Promise<void> } ? C : never;

interface ParsedArgs {
	dbPath: string;
	registryPath: string;
	limit: number;
	maxToolChars: number;
	search: string | undefined;
	cwd: string | undefined;
	since: number | undefined;
	updatedSince: number | undefined;
	dryRun: boolean;
	force: boolean;
	includeDelegated: boolean;
	selectorOrSessionId: string | undefined;
}

const RUNTIME = "pi";
const HOME = homedir();
const REGISTRY_PATH = `${HOME}/.pi/agent/opencode-import-registry.json`;

function parseArgs(args: string): ParsedArgs {
	const tokens = splitArgs(args);
	let dbPath = resolveDefaultDbPath();
	let registryPath = REGISTRY_PATH;
	let limit = DEFAULT_LIMIT;
	let maxToolChars = DEFAULT_MAX_TOOL_CHARS;
	let cwd: string | undefined;
	let since: number | undefined;
	let updatedSince: number | undefined;
	let dryRun = false;
	let force = false;
	let includeDelegated = false;
	const positional: string[] = [];

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--db") dbPath = expandHome(tokens[++i] ?? dbPath);
		else if (token === "--registry") registryPath = expandHome(tokens[++i] ?? registryPath);
		else if (token === "--limit") limit = clampLimit(Number(tokens[++i]));
		else if (token === "--max-tool-chars") maxToolChars = Math.max(0, Math.trunc(Number(tokens[++i] ?? DEFAULT_MAX_TOOL_CHARS)));
		else if (token === "--cwd") cwd = tokens[++i];
		else if (token === "--since") since = parseTime(tokens[++i]);
		else if (token === "--updated-since") updatedSince = parseTime(tokens[++i]);
		else if (token === "--dry-run") dryRun = true;
		else if (token === "--force") force = true;
		else if (token === "--include-delegated") includeDelegated = true;
		else positional.push(token);
	}

	return { dbPath, registryPath, limit, maxToolChars, search: undefined, cwd, since, updatedSince, dryRun, force, includeDelegated, selectorOrSessionId: positional.join(" ").trim() || undefined };
}

async function importOne(ctx: CommandContext, parsed: ParsedArgs, sessionId: string): Promise<{ imported: boolean; session?: OpenCodeSessionRow; message?: string }> {
	const registry = loadImportRegistry(parsed.registryPath);
	const canonicalId = canonicalIdFor("opencode", sessionId);
	const beforeMtime = getDbMtimeMs(parsed.dbPath);
	const loaded = loadOpenCodeSession(parsed.dbPath, sessionId);
	const targetCwd = loaded.session.directory;
	const sessionDir = PiSessionManager.create(targetCwd).getSessionDir();
	const existingFile = findSessionFileByCanonicalId(sessionDir, canonicalId);
	if (existingFile && !parsed.force) {
		return { imported: false, session: loaded.session, message: `Already imported ${sessionId} as ${existingFile}` };
	}

	const converted = convertOpenCodeSession(loaded, { maxToolChars: parsed.maxToolChars });
	const { content, fileName } = buildSessionFileContent(converted, {
		runtime: "pi",
		cwd: targetCwd,
		parentSession: ctx.sessionManager.getSessionFile(),
		timestamp: new Date(loaded.session.time_updated),
	});
	mkdirSync(sessionDir, { recursive: true });
	const filePath = join(sessionDir, fileName);
	writeFileSync(filePath, content);
	assertDbUnchanged(parsed.dbPath, beforeMtime);

	const result = await ctx.switchSession(filePath, {
		withSession: async (replacementCtx) => {
			replacementCtx.ui.setEditorText("");
		},
	});
	if (result.cancelled) return { imported: false, session: loaded.session, message: "Switch session cancelled" };

	recordImportedSession(registry, {
		sourceSession: loaded.session,
		converted,
		runtime: RUNTIME,
		targetSessionFile: filePath,
		sourceDbPath: parsed.dbPath,
	});
	saveImportRegistry(parsed.registryPath, registry);
	return { imported: true, session: loaded.session, message: `Imported ${sessionId} (canonical ${canonicalId.slice(0, 8)}): ${converted.messages.length} messages, ${skippedSummary(converted)}` };
}

async function importAll(ctx: CommandContext, parsed: ParsedArgs): Promise<void> {
	const registry = loadImportRegistry(parsed.registryPath);
	const plan = planBulkImport(parsed.dbPath, registry, { ...parsed, mainOnly: !parsed.includeDelegated }, RUNTIME);
	if (parsed.dryRun) {
		ctx.ui.notify(`Dry run: ${plan.toImport.length} to import, ${plan.skippedAlreadyImported.length} already in registry\n${formatSessionList(plan.toImport, registry, RUNTIME)}`, "info");
		return;
	}
	if (plan.toImport.length === 0) {
		ctx.ui.notify(`No sessions to import. ${plan.skippedAlreadyImported.length} already imported.`, "info");
		return;
	}
	const messages: string[] = [];
	for (const session of plan.toImport) {
		const result = await importOne(ctx, parsed, session.id);
		if (result.message) messages.push(result.message);
	}
	ctx.ui.notify(`OpenCode bulk import complete\n${messages.join("\n")}`, "info");
}

async function selectAndImport(ctx: CommandContext, parsed: ParsedArgs, search?: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/opencode-import without an exact ses_ id requires interactive mode", "error");
		return;
	}
	const registry = loadImportRegistry(parsed.registryPath);
	const sessions = listOpenCodeSessions(parsed.dbPath, { search, cwd: parsed.cwd, since: parsed.since, updatedSince: parsed.updatedSince, limit: parsed.limit, mainOnly: !parsed.includeDelegated });
	if (sessions.length === 0) {
		ctx.ui.notify(search ? `No OpenCode sessions matched: ${search}` : "No OpenCode sessions found", "warning");
		return;
	}
	const choices = sessions.map((session) => formatChoice(session, registry));
	const selected = await ctx.ui.select("Import OpenCode session", choices);
	if (!selected) {
		ctx.ui.notify("OpenCode import cancelled", "info");
		return;
	}
	const session = sessions[choices.indexOf(selected)];
	if (!session) {
		ctx.ui.notify("Selected OpenCode session could not be resolved", "error");
		return;
	}
	const result = await importOne(ctx, parsed, session.id);
	ctx.ui.notify(result.message ?? "OpenCode import finished", result.imported ? "info" : "warning");
}

function handleList(ctx: CommandContext, parsed: ParsedArgs, search?: string): void {
	const registry = loadImportRegistry(parsed.registryPath);
	const sessions = listOpenCodeSessions(parsed.dbPath, { search, cwd: parsed.cwd, since: parsed.since, updatedSince: parsed.updatedSince, limit: parsed.limit, mainOnly: !parsed.includeDelegated });
	ctx.ui.notify(formatSessionList(sessions, registry, RUNTIME), "info");
}

function handleStatus(ctx: CommandContext, parsed: ParsedArgs): void {
	const registry = loadImportRegistry(parsed.registryPath);
	ctx.ui.notify(formatImportStatus(planBulkImport(parsed.dbPath, registry, { ...parsed, mainOnly: !parsed.includeDelegated }, RUNTIME), registry, RUNTIME), "info");
}

async function handleOpen(ctx: CommandContext, parsed: ParsedArgs, sessionId: string | undefined): Promise<void> {
	if (!sessionId) {
		ctx.ui.notify("Usage: /opencode-import open <ses_id>", "error");
		return;
	}
	const entry = getImportedSession(loadImportRegistry(parsed.registryPath), RUNTIME, sessionId);
	if (!entry) {
		ctx.ui.notify(`No imported Pi session for ${sessionId}`, "warning");
		return;
	}
	const result = await ctx.switchSession(entry.targetSessionFile, {
		withSession: async (replacementCtx) => replacementCtx.ui.notify(`Opened imported OpenCode session ${sessionId}`, "info"),
	});
	if (result.cancelled) ctx.ui.notify("Switch session cancelled", "info");
}

export default function opencodeImportExtension(pi: ExtensionAPI): void {
	pi.registerCommand("opencode-import", {
		description: "Import OpenCode sessions into native Pi sessions",
		getArgumentCompletions: () => [
			{ value: "list ", label: "list" },
			{ value: "status", label: "status" },
			{ value: "all --dry-run", label: "all --dry-run" },
			{ value: "all", label: "all" },
			{ value: "open ", label: "open <ses_id>" },
			{ value: "--db ", label: "--db <path>" },
			{ value: "--cwd ", label: "--cwd <path>" },
			{ value: "--updated-since ", label: "--updated-since <iso|ms>" },
			{ value: "--max-tool-chars ", label: "--max-tool-chars <n>" },
			{ value: "--include-delegated", label: "--include-delegated (subagent sessions)" },
		],
		handler: async (args, ctx) => {
			try {
				const parsed = parseArgs(args);
				const selector = parsed.selectorOrSessionId;
				const [command, ...rest] = selector ? splitArgs(selector) : [];
				const restText = rest.join(" ").trim() || undefined;
				if (command === "list") return handleList(ctx, parsed, restText);
				if (command === "status") return handleStatus(ctx, parsed);
				if (command === "all") return await importAll(ctx, { ...parsed, search: restText });
				if (command === "open") return await handleOpen(ctx, parsed, rest[0]);
				if (selector?.startsWith("ses_")) {
					const result = await importOne(ctx, parsed, selector);
					ctx.ui.notify(result.message ?? "OpenCode import finished", result.imported ? "info" : "warning");
					return;
				}
				await selectAndImport(ctx, parsed, selector);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

function formatChoice(session: OpenCodeSessionRow, registry: ReturnType<typeof loadImportRegistry>): string {
	const imported = getImportedSession(registry, RUNTIME, session.id) ? "imported" : "pending";
	return `${session.title || "Untitled"}  ·  ${imported}  ·  ${new Date(session.time_updated).toISOString().slice(0, 16)}  ·  ${session.directory}  ·  ${session.id}`;
}

function splitArgs(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < args.length; i += 1) {
		const char = args[i];
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

function expandHome(path: string): string {
	return path === "~" ? HOME : path.startsWith("~/") ? `${HOME}${path.slice(1)}` : path;
}

function clampLimit(limit: number): number {
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(200, Math.trunc(limit)));
}

function parseTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid timestamp: ${value}`);
	return parsed;
}
