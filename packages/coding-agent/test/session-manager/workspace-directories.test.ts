import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(e): e is SessionHeader => typeof e === "object" && e !== null && "type" in e && (e as any).type === "session",
	) as SessionHeader | undefined;
}

describe("SessionManager workspace directories", () => {
	let testAgentDir: string;
	let cwdA: string;
	let cwdB: string;
	let docs: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-workspace-test-"));
		setAgentDir(testAgentDir);
		cwdA = path.join(testAgentDir, "cwd-a");
		cwdB = path.join(testAgentDir, "cwd-b");
		docs = path.join(testAgentDir, "docs");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		fs.mkdirSync(docs, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("persists additional directories in the header and restores them on open", async () => {
		const session = SessionManager.create(cwdA, undefined, undefined, { additionalDirectories: [docs] });
		await session.ensureOnDisk();
		const file = session.getSessionFile()!;
		await session.close();

		const entries = await loadEntriesFromFile(file);
		expect(getHeader(entries)?.additionalDirectories).toEqual([docs]);

		const reopened = await SessionManager.open(file);
		expect(reopened.getCwd()).toBe(path.resolve(cwdA));
		expect(reopened.getDirectories()).toEqual([path.resolve(cwdA), docs]);
		await reopened.close();
	});

	it("treats legacy headers without additionalDirectories as single-root", async () => {
		const file = SessionManager.createEmptySessionFile(cwdA);
		const entries = await loadEntriesFromFile(file);
		expect(getHeader(entries)?.additionalDirectories).toBeUndefined();

		const reopened = await SessionManager.open(file);
		expect(reopened.getDirectories()).toEqual([path.resolve(cwdA)]);
		expect(reopened.getWorkspace()).toEqual({
			cwd: path.resolve(cwdA),
			directories: [path.resolve(cwdA)],
		});
		await reopened.close();
	});

	it("keeps cwd out of the additional list and normalizes entries", () => {
		const session = SessionManager.create(cwdA);
		session.setAdditionalDirectories([cwdA, `${docs}${path.sep}`]);
		expect(session.getDirectories()).toEqual([path.resolve(cwdA), docs]);
	});

	it("fork carries the workspace into the new session header", async () => {
		const session = SessionManager.create(cwdA);
		session.setAdditionalDirectories([docs]);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const forked = await session.fork();
		expect(forked).toBeDefined();
		expect(session.getDirectories()).toEqual([path.resolve(cwdA), docs]);

		const entries = await loadEntriesFromFile(forked!.newSessionFile);
		expect(getHeader(entries)?.additionalDirectories).toEqual([docs]);
	});

	it("moveTo drops the new cwd from the additional directories", async () => {
		const session = SessionManager.create(cwdA);
		session.setAdditionalDirectories([cwdB, docs]);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(session.getDirectories()).toEqual([path.resolve(cwdB), docs]);

		const entries = await loadEntriesFromFile(session.getSessionFile()!);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(header?.additionalDirectories).toEqual([docs]);
	});

	it("surfaces additional directories through session listing", async () => {
		const session = SessionManager.create(cwdA, undefined, undefined, { additionalDirectories: [docs] });
		await session.ensureOnDisk();
		await session.close();

		const sessions = await SessionManager.list(cwdA);
		const listed = sessions.find(entry => entry.id === session.getSessionId());
		expect(listed?.additionalDirectories).toEqual([docs]);
	});

	it("fires the workspace-change signal with previous and next when a root is added", () => {
		const session = SessionManager.create(cwdA);
		const calls: Array<{ previous: string[]; next: string[] }> = [];
		session.onWorkspaceDirectoriesChanged((previous, next) => calls.push({ previous, next }));

		session.setAdditionalDirectories([docs]);

		expect(calls).toHaveLength(1);
		expect(calls[0].previous).toEqual([path.resolve(cwdA)]);
		expect(calls[0].next).toEqual([path.resolve(cwdA), docs]);
	});

	it("fires with the removed root recoverable from (previous - next) on removal", () => {
		const session = SessionManager.create(cwdA);
		session.setAdditionalDirectories([cwdB, docs]);
		const calls: Array<{ previous: string[]; next: string[] }> = [];
		session.onWorkspaceDirectoriesChanged((previous, next) => calls.push({ previous, next }));

		session.setAdditionalDirectories([docs]);

		expect(calls).toHaveLength(1);
		const retained = new Set(calls[0].next);
		const removed = calls[0].previous.filter(dir => !retained.has(dir));
		expect(removed).toEqual([path.resolve(cwdB)]);
	});

	it("does not fire when the directory set is unchanged (idempotent adopt)", () => {
		const session = SessionManager.create(cwdA);
		session.setAdditionalDirectories([docs]);
		let fired = 0;
		session.onWorkspaceDirectoriesChanged(() => fired++);

		// Same set, different array identity + order — must be treated as no-op.
		session.setAdditionalDirectories([docs]);
		session.setAdditionalDirectories([`${docs}${path.sep}`]);

		expect(fired).toBe(0);
	});

	it("stops delivering after unsubscribe", () => {
		const session = SessionManager.create(cwdA);
		let fired = 0;
		const unsubscribe = session.onWorkspaceDirectoriesChanged(() => fired++);

		session.setAdditionalDirectories([docs]);
		expect(fired).toBe(1);

		unsubscribe();
		session.setAdditionalDirectories([docs, cwdB]);
		expect(fired).toBe(1);
	});

	it("loads a session whose additional directory is missing without blocking", async () => {
		const ghost = path.join(testAgentDir, "ghost");
		fs.mkdirSync(ghost, { recursive: true });
		const session = SessionManager.create(cwdA);
		session.setAdditionalDirectories([ghost]);
		await session.ensureOnDisk();
		const file = session.getSessionFile()!;
		await session.close();
		await fsp.rm(ghost, { recursive: true, force: true });

		const reopened = await SessionManager.open(file);
		expect(reopened.getCwd()).toBe(path.resolve(cwdA));
		expect(reopened.getDirectories()).toEqual([path.resolve(cwdA), ghost]);
		await reopened.close();
	});
});
