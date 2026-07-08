/**
 * Contract: the optional `cwd` on the task tool scopes a subagent to one
 * workspace directory.
 *
 * 1. `resolveSubagentCwd(session, requested)` normalizes the request against
 *    `session.cwd`, validates it is WITHIN the session workspace
 *    (`session.directories`), and returns the normalized absolute path — or
 *    throws a clear error for out-of-workspace, non-existent, and non-directory
 *    targets. Symlink equivalence resolves via realpath.
 * 2. The current schema (fields `name`/`agent`/`task`, plus `cwd`) carries a
 *    `cwd` string through to the parsed params.
 * 3. Threading: a provided `cwd` scopes the spawn's run cwd to the validated
 *    dir with an empty `additionalDirectories`; an omitted `cwd` preserves the
 *    parent cwd + inherited roots. `cwd` + `isolated` roots the isolation
 *    context at the scoped dir.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { normalizeWorkspaceDirectory } from "@oh-my-pi/pi-coding-agent/session/session-workspace";
import { resolveSubagentCwd, TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { IsolationContext } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as isolationModule from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { taskItemSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const tempDirs: string[] = [];

async function mkTemp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-cwd-"));
	tempDirs.push(dir);
	return dir;
}

function sessionWith(cwd: string, directories: string[]): ToolSession {
	return { cwd, directories } as unknown as ToolSession;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("resolveSubagentCwd", () => {
	it("returns an added workspace root unchanged", async () => {
		const root = await mkTemp();
		const session = sessionWith(root, [root]);
		expect(resolveSubagentCwd(session, root)).toBe(root);
	});

	it("returns a subdirectory of a root (normalized)", async () => {
		const root = await mkTemp();
		const sub = path.join(root, "pkg", "src");
		await fs.mkdir(sub, { recursive: true });
		const session = sessionWith(root, [root]);
		expect(resolveSubagentCwd(session, sub)).toBe(sub);
	});

	it("resolves a subdirectory of a secondary root", async () => {
		const root = await mkTemp();
		const root2 = await mkTemp();
		const sub = path.join(root2, "service");
		await fs.mkdir(sub);
		const session = sessionWith(root, [root, root2]);
		expect(resolveSubagentCwd(session, sub)).toBe(sub);
	});

	it("throws for an out-of-workspace path, naming the roots", async () => {
		const root = await mkTemp();
		const outside = await mkTemp();
		const session = sessionWith(root, [root]);
		expect(() => resolveSubagentCwd(session, outside)).toThrow(/outside the session workspace/);
		expect(() => resolveSubagentCwd(session, outside)).toThrow(
			new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	});

	it("throws for a non-existent path inside a root", async () => {
		const root = await mkTemp();
		const missing = path.join(root, "does-not-exist");
		const session = sessionWith(root, [root]);
		expect(() => resolveSubagentCwd(session, missing)).toThrow(/is not an existing directory/);
	});

	it("throws for a file (non-directory) inside a root", async () => {
		const root = await mkTemp();
		const file = path.join(root, "file.txt");
		await fs.writeFile(file, "x");
		const session = sessionWith(root, [root]);
		expect(() => resolveSubagentCwd(session, file)).toThrow(/is not a directory/);
	});

	it("accepts a symlink whose realpath resolves inside a root", async () => {
		const root = await mkTemp();
		const target = path.join(root, "pkg");
		await fs.mkdir(target);
		const linkParent = await mkTemp();
		const link = path.join(linkParent, "link-to-pkg");
		await fs.symlink(target, link);
		const session = sessionWith(root, [root]);
		// The link is lexically outside every root; only the realpath fallback
		// containment check lets it through. The returned path is the normalized
		// request (symlink not collapsed).
		expect(resolveSubagentCwd(session, link)).toBe(normalizeWorkspaceDirectory(link, root));
	});
});

describe("task schema cwd plumbing", () => {
	it("carries `cwd` through the single-spawn schema alongside name/agent/task", () => {
		const parsed = taskSchema({ name: "Scoped", agent: "explore", task: "Map it.", cwd: "/work/pkg" });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.name).toBe("Scoped");
			expect(parsed.agent).toBe("explore");
			expect(parsed.task).toBe("Map it.");
			expect(parsed.cwd).toBe("/work/pkg");
		}
	});

	it("carries `cwd` through a batch task item", () => {
		const parsed = taskItemSchema({ name: "A", agent: "task", task: "Do A.", cwd: "/work/svc" });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.cwd).toBe("/work/svc");
		}
	});
});

describe("cwd threading + isolation", () => {
	const taskAgent: AgentDefinition = {
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
	};

	function makeResult(id: string): SingleResult {
		return {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			task: "task prompt",
			assignment: "Do the thing.",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		};
	}

	function createSession(cwd: string, directories: string[], settings: Record<string, unknown>): ToolSession {
		return {
			cwd,
			directories,
			hasUI: false,
			settings: Settings.isolated(settings),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	it("scopes the run cwd to the validated dir with empty additionalDirectories when `cwd` is provided", async () => {
		const root = await mkTemp();
		const sub = path.join(root, "pkg");
		await fs.mkdir(sub);
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const captured: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured.push(options);
			return makeResult(options.id ?? "?");
		});

		const session = createSession(root, [root], { "task.isolation.mode": "none", "task.batch": false });
		const tool = await TaskTool.create(session);
		await tool.execute("tc", { agent: "task", task: "x", cwd: sub });

		expect(captured).toHaveLength(1);
		expect(captured[0].cwd).toBe(sub);
		expect(captured[0].additionalDirectories).toEqual([]);
	});

	it("preserves the parent cwd + inherited roots when `cwd` is omitted", async () => {
		const root = await mkTemp();
		const root2 = await mkTemp();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const captured: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured.push(options);
			return makeResult(options.id ?? "?");
		});

		const session = createSession(root, [root, root2], { "task.isolation.mode": "none", "task.batch": false });
		const tool = await TaskTool.create(session);
		await tool.execute("tc", { agent: "task", task: "x" });

		expect(captured).toHaveLength(1);
		expect(captured[0].cwd).toBe(root);
		expect(captured[0].additionalDirectories).toEqual([root2]);
	});

	it("roots the isolation context at the scoped cwd when `cwd` + `isolated` are set", async () => {
		const root = await mkTemp();
		const sub = path.join(root, "repo");
		await fs.mkdir(sub);
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		let isolationCwd: string | undefined;
		vi.spyOn(isolationModule, "prepareIsolationContext").mockImplementation(async (cwd: string) => {
			isolationCwd = cwd;
			// repoRoot falsy → the post-run merge/patch path is skipped.
			return { repoRoot: "", baseline: {} } as unknown as IsolationContext;
		});
		vi.spyOn(isolationModule, "runIsolatedSubprocess").mockImplementation(async opts =>
			makeResult(opts.agentId ?? "?"),
		);

		const session = createSession(root, [root], { "task.isolation.mode": "auto", "task.batch": false });
		const tool = await TaskTool.create(session);
		await tool.execute("tc", { agent: "task", task: "x", cwd: sub, isolated: true });

		expect(isolationCwd).toBe(sub);
	});
});
