import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { workspaceRootForPath } from "@oh-my-pi/pi-coding-agent/session/session-workspace";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

let root: string;
let cwd: string;
let docsRoot: string;
let libRoot: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-tools-"));
	cwd = path.join(root, "cwd");
	docsRoot = path.join(root, "docs-root");
	libRoot = path.join(root, "lib-root");
	await fs.mkdir(path.join(cwd, "src"), { recursive: true });
	await fs.mkdir(path.join(docsRoot, "src"), { recursive: true });
	await fs.mkdir(path.join(libRoot, "src"), { recursive: true });
});

afterEach(async () => {
	await removeWithRetries(root);
});

describe("grep multi-root scope", () => {
	it("searches every workspace directory by default and narrows with explicit paths", async () => {
		await Bun.write(path.join(cwd, "src", "a.txt"), "shared-needle in cwd\n");
		await Bun.write(path.join(docsRoot, "src", "b.txt"), "shared-needle in docs\n");
		const session = createTestSession(cwd, { directories: [cwd, docsRoot] });
		const tool = (await createTools(session)).find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const wide = getText(await tool.execute("grep-default", { pattern: "shared-needle" }));
		expect(wide).toContain("a.txt");
		expect(wide).toContain("b.txt");

		const narrowed = getText(await tool.execute("grep-narrowed", { pattern: "shared-needle", path: "src" }));
		expect(narrowed).toContain("a.txt");
		expect(narrowed).not.toContain("b.txt");
	});

	it("prints a per-root breakdown header when matches span multiple roots", async () => {
		await Bun.write(path.join(cwd, "src", "a.txt"), "breakdown-needle cwd\n");
		await Bun.write(path.join(docsRoot, "src", "b.txt"), "breakdown-needle docs\n");
		const session = createTestSession(cwd, { directories: [cwd, docsRoot] });
		const tool = (await createTools(session)).find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const output = getText(await tool.execute("grep-breakdown", { pattern: "breakdown-needle" }));
		expect(output).toContain("Workspace roots:");
		expect(output).toContain("docs-root: 1 file");
	});

	it("fairly allocates the file window across roots so a starved root still shows visible matches", async () => {
		// Root 1 holds more matching files than a single page (DEFAULT_FILE_LIMIT=20)
		// can display; root 2 holds only a couple. A greedy window fills entirely from
		// root 1 (scanned first) and shows root 2 as "0 shown". Fairness must keep
		// root 2's files in the visible output, not just the header.
		await Promise.all(
			Array.from({ length: 25 }, (_, index) =>
				Bun.write(path.join(cwd, "src", `cwd-${String(index).padStart(2, "0")}.txt`), "fair-needle here\n"),
			),
		);
		await Bun.write(path.join(docsRoot, "src", "docs-a.txt"), "fair-needle here\n");
		await Bun.write(path.join(docsRoot, "src", "docs-b.txt"), "fair-needle here\n");
		const session = createTestSession(cwd, { directories: [cwd, docsRoot] });
		const tool = (await createTools(session)).find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const output = getText(await tool.execute("grep-fair", { pattern: "fair-needle" }));
		// Root 2's files appear in the visible listing (not merely counted in the header).
		expect(output).toContain("docs-a.txt");
		expect(output).toContain("docs-b.txt");
		// The header must never report the matched root as starved.
		expect(output).toContain("Workspace roots:");
		expect(output).not.toContain("docs-root: 0 shown");
	});

	it("keeps single-root sessions on the plain workspace-root default", async () => {
		await Bun.write(path.join(cwd, "src", "a.txt"), "single-needle here\n");
		const session = createTestSession(cwd, { directories: [cwd] });
		const tool = (await createTools(session)).find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const result = getText(await tool.execute("grep-single", { pattern: "single-needle" }));
		expect(result).toContain("a.txt");
	});
});

describe("glob multi-root scope", () => {
	it("expands relative globs across workspace directories and honors absolute narrowing", async () => {
		await Bun.write(path.join(cwd, "src", "one.md"), "# one\n");
		await Bun.write(path.join(docsRoot, "src", "two.md"), "# two\n");
		const session = createTestSession(cwd, { directories: [cwd, docsRoot] });
		const tool = (await createTools(session)).find(entry => entry.name === "glob");
		if (!tool) throw new Error("Missing glob tool");

		const wide = getText(await tool.execute("glob-default", { path: "src/**/*.md" }));
		expect(wide).toContain("one.md");
		expect(wide).toContain("two.md");

		const narrowed = getText(await tool.execute("glob-narrowed", { path: `${docsRoot}/src/**/*.md` }));
		expect(narrowed).toContain("two.md");
		expect(narrowed).not.toContain("one.md");
	});
});

describe("edit cross-root path resolution", () => {
	async function runEdit(
		session: ToolSession,
		mode: "replace" | "patch",
		params: Record<string, unknown>,
	): Promise<{ isError?: boolean; text: string }> {
		const tool = new EditTool(session, mode);
		const result = await tool.execute(`edit-${crypto.randomUUID()}`, params as never);
		return { isError: result.isError, text: getText(result) };
	}

	it("resolves a relative path missing under cwd through the unique additional root", async () => {
		await Bun.write(path.join(docsRoot, "src", "guide.md"), "guide\n");
		const session = createTestSession(cwd, { directories: [cwd, docsRoot], enableLsp: false });

		const result = await runEdit(session, "replace", {
			path: "src/guide.md",
			old_string: "guide",
			new_string: "guide edited",
		});
		expect(result.isError).toBeUndefined();
		await expect(Bun.file(path.join(docsRoot, "src", "guide.md")).text()).resolves.toBe("guide edited\n");
	});

	it("prefers the cwd copy when both roots contain the relative path", async () => {
		await Bun.write(path.join(cwd, "src", "guide.md"), "cwd guide\n");
		await Bun.write(path.join(docsRoot, "src", "guide.md"), "docs guide\n");
		const session = createTestSession(cwd, { directories: [cwd, docsRoot], enableLsp: false });

		const result = await runEdit(session, "replace", {
			path: "src/guide.md",
			old_string: "guide",
			new_string: "guide edited",
		});
		expect(result.isError).toBeUndefined();
		await expect(Bun.file(path.join(cwd, "src", "guide.md")).text()).resolves.toBe("cwd guide edited\n");
		await expect(Bun.file(path.join(docsRoot, "src", "guide.md")).text()).resolves.toBe("docs guide\n");
	});

	it("rejects a relative path that exists in multiple additional roots", async () => {
		await Bun.write(path.join(docsRoot, "src", "guide.md"), "docs guide\n");
		await Bun.write(path.join(libRoot, "src", "guide.md"), "lib guide\n");
		const session = createTestSession(cwd, { directories: [cwd, docsRoot, libRoot], enableLsp: false });

		const result = await runEdit(session, "replace", {
			path: "src/guide.md",
			old_string: "guide",
			new_string: "guide edited",
		});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("File not found: src/guide.md");
	});

	it("keeps create cwd-anchored even when an additional root has the same relative path", async () => {
		await Bun.write(path.join(docsRoot, "src", "guide.md"), "docs guide\n");
		const session = createTestSession(cwd, { directories: [cwd, docsRoot], enableLsp: false });

		const result = await runEdit(session, "patch", {
			path: "src/guide.md",
			edits: [{ op: "create", diff: "created\n" }],
		});
		expect(result.isError).toBeUndefined();
		await expect(Bun.file(path.join(cwd, "src", "guide.md")).text()).resolves.toBe("created\n");
		await expect(Bun.file(path.join(docsRoot, "src", "guide.md")).text()).resolves.toBe("docs guide\n");
	});

	it("does not adopt a `..`-escaping candidate that resolves outside every root (F1)", async () => {
		// otherRoot is deeper than cwd so its `..` escapes to root/other, a spot
		// cwd's own `..` (→ root/escape.ts) never reaches — the only route by
		// which the cross-root fallback could pick up the out-of-root file.
		const otherRoot = path.join(root, "other", "lib");
		await fs.mkdir(otherRoot, { recursive: true });
		await Bun.write(path.join(root, "other", "escape.ts"), "escaped\n");
		const session = createTestSession(cwd, { directories: [cwd, otherRoot], enableLsp: false });

		const result = await runEdit(session, "replace", {
			path: "../escape.ts",
			old_string: "escaped",
			new_string: "replaced",
		});
		// Stays cwd-anchored (a miss); never rebinds onto the out-of-root file.
		expect(result.isError).toBe(true);
		await expect(Bun.file(path.join(root, "other", "escape.ts")).text()).resolves.toBe("escaped\n");
	});
});

describe("workspaceRootForPath", () => {
	it("picks the containing directory with longest-prefix precedence and falls back to cwd", () => {
		const nested = path.join(docsRoot, "nested");
		expect(workspaceRootForPath(path.join(docsRoot, "src", "a.ts"), [cwd, docsRoot], cwd)).toBe(docsRoot);
		expect(workspaceRootForPath(path.join(nested, "b.ts"), [docsRoot, nested], cwd)).toBe(nested);
		expect(workspaceRootForPath("/somewhere/else/c.ts", [cwd, docsRoot], cwd)).toBe(cwd);
		expect(workspaceRootForPath(docsRoot, [cwd, docsRoot], cwd)).toBe(docsRoot);
	});
});

describe("/add-dir, /remove-dir, /dirs commands", () => {
	function makeRuntime(sessionManager: SessionManager, outputs: string[]): SlashCommandRuntime {
		return {
			session: {
				isStreaming: false,
				refreshBaseSystemPrompt: async () => {},
			},
			sessionManager,
			settings: Settings.isolated(),
			cwd: sessionManager.getCwd(),
			output: async (text: string) => {
				outputs.push(text);
			},
			refreshCommands: async () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;
	}

	it("adds, lists, and removes workspace directories with header persistence", async () => {
		const sessionManager = SessionManager.inMemory(cwd);
		const outputs: string[] = [];
		const runtime = makeRuntime(sessionManager, outputs);

		const addDir = lookupBuiltinSlashCommand("add-dir");
		const removeDir = lookupBuiltinSlashCommand("remove-dir");
		const dirs = lookupBuiltinSlashCommand("dirs");
		if (!addDir?.handle || !removeDir?.handle || !dirs?.handle) throw new Error("workspace commands missing");

		await addDir.handle({ name: "add-dir", args: docsRoot, text: `/add-dir ${docsRoot}` }, runtime);
		expect(sessionManager.getDirectories()).toEqual([path.resolve(cwd), docsRoot]);
		expect(outputs.at(-1)).toContain(`Added ${docsRoot}`);

		// The change is persisted as a model-visible history marker so stale
		// conversation turns can't outweigh the rebuilt system prompt.
		const notices = sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "workspace-changed");
		expect(notices).toHaveLength(1);
		const noticeContent = (notices[0] as { content: string }).content;
		expect(noticeContent).toContain(`added ${docsRoot}`);
		expect(noticeContent).toContain("supersedes any workspace state mentioned earlier");

		await dirs.handle({ name: "dirs", args: "", text: "/dirs" }, runtime);
		expect(outputs.at(-1)).toContain(docsRoot);
		expect(outputs.at(-1)).toContain("(working directory)");

		await removeDir.handle({ name: "remove-dir", args: docsRoot, text: `/remove-dir ${docsRoot}` }, runtime);
		expect(sessionManager.getDirectories()).toEqual([path.resolve(cwd)]);
		expect(outputs.at(-1)).toContain(`Removed ${docsRoot}`);
		const removeNotices = sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === "workspace-changed");
		expect(removeNotices).toHaveLength(2);
		expect((removeNotices[1] as { content: string }).content).toContain(`removed ${docsRoot}`);
	});

	it("rejects a missing directory and removing the working directory", async () => {
		const sessionManager = SessionManager.inMemory(cwd);
		const outputs: string[] = [];
		const runtime = makeRuntime(sessionManager, outputs);

		const addDir = lookupBuiltinSlashCommand("add-dir");
		const removeDir = lookupBuiltinSlashCommand("remove-dir");
		if (!addDir?.handle || !removeDir?.handle) throw new Error("workspace commands missing");

		await addDir.handle({ name: "add-dir", args: path.join(root, "ghost"), text: "/add-dir ghost" }, runtime);
		expect(outputs.at(-1)).toContain("Directory does not exist");
		expect(sessionManager.getDirectories()).toEqual([path.resolve(cwd)]);

		await removeDir.handle({ name: "remove-dir", args: cwd, text: `/remove-dir ${cwd}` }, runtime);
		expect(outputs.at(-1)).toContain("Cannot remove the working directory");
	});
});
