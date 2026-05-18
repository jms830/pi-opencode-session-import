#!/usr/bin/env bun
/**
 * One-shot bulk importer. Uses Bun's native SQLite (fast) and the core's
 * canonical-UUID + lineage logic. Idempotent across runs:
 *   - canonical-UUID files in the target dir are skipped by filename match
 *   - legacy imports (random UUID + opencode-import marker) are scanned and
 *     skipped via their embedded source session id
 *
 * Usage:
 *   bun scripts/bulk-sync-all.ts                  # main sessions only, both runtimes
 *   bun scripts/bulk-sync-all.ts --dry-run        # plan only
 *   bun scripts/bulk-sync-all.ts --include-delegated  # also import @agent subagent sessions
 *   bun scripts/bulk-sync-all.ts --runtimes pi    # only Pi
 *   bun scripts/bulk-sync-all.ts --runtimes omp   # only OMP
 *   bun scripts/bulk-sync-all.ts --db PATH        # alternate OpenCode DB
 *   bun scripts/bulk-sync-all.ts --limit N        # cap at N sessions
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager as OmpSessionManager } from "@oh-my-pi/pi-coding-agent";
import {
	buildSessionFileContent,
	canonicalIdFor,
	convertOpenCodeSession,
	findSessionFileByCanonicalId,
	resolveDefaultDbPath,
	type ConvertedImport,
	type LoadedOpenCodeSession,
	type OpenCodeMessageRow,
	type OpenCodePartRow,
	type OpenCodeSessionRow,
} from "../src/core.ts";

type Runtime = "pi" | "omp";

interface Args {
	db: string;
	dryRun: boolean;
	runtimes: Runtime[];
	limit: number;
	maxToolChars: number;
	includeDelegated: boolean;
}

function parseArgs(): Args {
	const argv = process.argv.slice(2);
	let db = resolveDefaultDbPath();
	let dryRun = false;
	let limit = 5000;
	let maxToolChars = 4000;
	let includeDelegated = false;
	let runtimes: Runtime[] = ["pi", "omp"];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--db") db = argv[++i];
		else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--limit") limit = Math.max(1, Math.min(20000, Math.trunc(Number(argv[++i]))));
		else if (arg === "--max-tool-chars") maxToolChars = Math.max(0, Math.trunc(Number(argv[++i])));
		else if (arg === "--include-delegated") includeDelegated = true;
		else if (arg === "--runtimes") {
			runtimes = argv[++i].split(",").map((s) => s.trim()).filter((s): s is Runtime => s === "pi" || s === "omp");
			if (runtimes.length === 0) throw new Error("--runtimes must include 'pi' and/or 'omp'");
		}
	}
	return { db, dryRun, runtimes, limit, maxToolChars, includeDelegated };
}

function sessionsRoot(runtime: Runtime, cwd: string): string {
	return runtime === "pi" ? PiSessionManager.create(cwd).getSessionDir() : OmpSessionManager.getDefaultSessionDir(cwd);
}

function sessionsTreeRoot(runtime: Runtime): string {
	const home = process.env.HOME ?? "/root";
	return runtime === "pi" ? `${home}/.pi/agent/sessions` : `${home}/.omp/agent/sessions`;
}

function scanImportedOpenCodeIds(runtime: Runtime): Set<string> {
	const root = sessionsTreeRoot(runtime);
	const ids = new Set<string>();
	if (!existsSync(root)) return ids;
	for (const cwdDir of readdirSync(root, { withFileTypes: true })) {
		if (!cwdDir.isDirectory()) continue;
		const dir = join(root, cwdDir.name);
		let entries: string[] = [];
		try { entries = readdirSync(dir); } catch { continue; }
		for (const file of entries) {
			if (!file.endsWith(".jsonl")) continue;
			const id = extractOpenCodeIdFromFile(join(dir, file));
			if (id) ids.add(id);
		}
	}
	return ids;
}

function extractOpenCodeIdFromFile(filePath: string): string | undefined {
	let text: string;
	try { text = readFileSync(filePath, "utf8"); } catch { return undefined; }
	const lines = text.split("\n", 120);
	for (const line of lines) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; customType?: string; content?: unknown; details?: { lineageRuntime?: string; lineageId?: unknown } };
			if (entry?.type !== "custom_message" || entry.customType !== "opencode-import") continue;
			if (entry.details?.lineageRuntime === "opencode" && typeof entry.details.lineageId === "string") {
				return entry.details.lineageId;
			}
			if (typeof entry.content === "string") {
				const match = entry.content.match(/OpenCode session\s+(ses_[A-Za-z0-9]+)/);
				if (match) return match[1];
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

interface FastSession {
	id: string;
	directory: string;
	title: string;
	time_updated: number;
}

function loadSessionsFast(db: Database, limit: number, includeDelegated: boolean): FastSession[] {
	const predicates = ["time_archived IS NULL"];
	if (!includeDelegated) predicates.push("parent_id IS NULL");
	return db.query(`
		SELECT id, directory, title, time_updated
		FROM session
		WHERE ${predicates.join(" AND ")}
		ORDER BY time_updated DESC, id DESC
		LIMIT ?
	`).all(limit) as FastSession[];
}

function loadOpenCodeSessionFast(db: Database, sessionId: string): LoadedOpenCodeSession {
	const session = db.query(`SELECT id, project_id, parent_id, directory, title, version, time_created, time_updated, agent, model FROM session WHERE id = ? LIMIT 1`).get(sessionId) as OpenCodeSessionRow | undefined;
	if (!session) throw new Error(`OpenCode session not found: ${sessionId}`);
	const messages = db.query(`SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC`).all(sessionId) as OpenCodeMessageRow[];
	const parts = db.query(`
		SELECT id, message_id, session_id, time_created, time_updated,
		       CASE
		         WHEN json_valid(data) AND json_extract(data, '$.type') = 'file'
		              AND coalesce(json_extract(data, '$.mime'), '') <> 'text/plain'
		           THEN json_remove(data, '$.url')
		         WHEN json_valid(data) AND json_extract(data, '$.type') = 'tool'
		              AND json_type(data, '$.state.output') = 'text'
		           THEN json_set(data, '$.state.output', substr(json_extract(data, '$.state.output'), 1, 100000))
		         ELSE data
		       END AS data
		FROM part
		WHERE session_id = ?
		ORDER BY message_id ASC, time_created ASC, id ASC
	`).all(sessionId) as OpenCodePartRow[];
	const partsByMessage = new Map<string, OpenCodePartRow[]>();
	for (const part of parts) {
		const arr = partsByMessage.get(part.message_id);
		if (arr) arr.push(part);
		else partsByMessage.set(part.message_id, [part]);
	}
	return { session, messages, partsByMessage };
}

function summary(stats: { imported: number; skippedExisting: number; skippedCanonical: number; errored: number }): string {
	return `imported=${stats.imported} skippedExisting=${stats.skippedExisting} skippedCanonical=${stats.skippedCanonical} errored=${stats.errored}`;
}

async function main(): Promise<void> {
	const args = parseArgs();
	console.log(`OpenCode DB: ${args.db}`);
	console.log(`Runtimes:    ${args.runtimes.join(", ")}`);
	console.log(`Dry run:     ${args.dryRun}\n`);

	const db = new Database(args.db, { readonly: true });
	const sessions = loadSessionsFast(db, args.limit, args.includeDelegated);
	console.log(`Discovered ${sessions.length} active OpenCode sessions${args.includeDelegated ? "" : " (main only — pass --include-delegated to include subagents)"}`);

	const preScan: Record<Runtime, Set<string>> = { pi: new Set(), omp: new Set() };
	for (const runtime of args.runtimes) {
		process.stdout.write(`Pre-scanning ${runtime} sessions tree... `);
		preScan[runtime] = scanImportedOpenCodeIds(runtime);
		console.log(`${preScan[runtime].size} OpenCode ids already present`);
	}
	console.log("");

	const stats: Record<Runtime, { imported: number; skippedExisting: number; skippedCanonical: number; errored: number }> = {
		pi: { imported: 0, skippedExisting: 0, skippedCanonical: 0, errored: 0 },
		omp: { imported: 0, skippedExisting: 0, skippedCanonical: 0, errored: 0 },
	};
	const errors: { id: string; runtime: Runtime; message: string }[] = [];

	const progressEvery = Math.max(1, Math.floor(sessions.length / 80));
	const startedAt = Date.now();
	const sessionsDirCache = new Map<string, string>();
	const cacheKey = (runtime: Runtime, cwd: string): string => `${runtime}::${cwd}`;
	function resolveDir(runtime: Runtime, cwd: string): string {
		const key = cacheKey(runtime, cwd);
		const existing = sessionsDirCache.get(key);
		if (existing) return existing;
		const dir = sessionsRoot(runtime, cwd);
		sessionsDirCache.set(key, dir);
		return dir;
	}

	for (let i = 0; i < sessions.length; i += 1) {
		const session = sessions[i];
		const canonical = canonicalIdFor("opencode", session.id);

		const work: Runtime[] = [];
		for (const runtime of args.runtimes) {
			if (preScan[runtime].has(session.id)) {
				stats[runtime].skippedExisting += 1;
				continue;
			}
			const dir = resolveDir(runtime, session.directory);
			if (findSessionFileByCanonicalId(dir, canonical)) {
				stats[runtime].skippedCanonical += 1;
				continue;
			}
			work.push(runtime);
		}

		if (work.length === 0) {
			if ((i + 1) % progressEvery === 0) reportProgress(i + 1, sessions.length, startedAt, stats);
			continue;
		}

		if (args.dryRun) {
			for (const runtime of work) stats[runtime].imported += 1;
			if ((i + 1) % progressEvery === 0) reportProgress(i + 1, sessions.length, startedAt, stats);
			continue;
		}

		let loaded: LoadedOpenCodeSession;
		try {
			loaded = loadOpenCodeSessionFast(db, session.id);
		} catch (e) {
			for (const runtime of work) {
				stats[runtime].errored += 1;
				errors.push({ id: session.id, runtime, message: e instanceof Error ? e.message : String(e) });
			}
			continue;
		}
		let converted: ConvertedImport;
		try {
			converted = convertOpenCodeSession(loaded, { maxToolChars: args.maxToolChars });
		} catch (e) {
			for (const runtime of work) {
				stats[runtime].errored += 1;
				errors.push({ id: session.id, runtime, message: e instanceof Error ? e.message : String(e) });
			}
			continue;
		}
		for (const runtime of work) {
			try {
				const dir = resolveDir(runtime, session.directory);
				const { content, fileName } = buildSessionFileContent(converted, { runtime, cwd: session.directory, timestamp: new Date(session.time_updated) });
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, fileName), content);
				preScan[runtime].add(session.id);
				stats[runtime].imported += 1;
			} catch (e) {
				stats[runtime].errored += 1;
				errors.push({ id: session.id, runtime, message: e instanceof Error ? e.message : String(e) });
			}
		}

		if ((i + 1) % progressEvery === 0) reportProgress(i + 1, sessions.length, startedAt, stats);
	}

	reportProgress(sessions.length, sessions.length, startedAt, stats);

	console.log("");
	for (const runtime of args.runtimes) console.log(`${runtime}: ${summary(stats[runtime])}`);

	if (errors.length > 0) {
		console.log(`\n${errors.length} error(s); first 10:`);
		for (const e of errors.slice(0, 10)) console.log(`  [${e.runtime}] ${e.id}: ${e.message}`);
	}
	db.close();
}

function reportProgress(done: number, total: number, startedAt: number, stats: Record<Runtime, { imported: number; skippedExisting: number; skippedCanonical: number; errored: number }>): void {
	const elapsed = (Date.now() - startedAt) / 1000;
	const rate = done > 0 ? done / elapsed : 0;
	const eta = rate > 0 ? (total - done) / rate : 0;
	const tot = (runtime: Runtime) => stats[runtime].imported + stats[runtime].skippedExisting + stats[runtime].skippedCanonical + stats[runtime].errored;
	process.stdout.write(`\r${done}/${total} (${(100 * done / total).toFixed(1)}%)  elapsed=${elapsed.toFixed(1)}s  eta=${eta.toFixed(1)}s  pi=${tot("pi")}  omp=${tot("omp")}    `);
	if (done === total) process.stdout.write("\n");
}

await main();
