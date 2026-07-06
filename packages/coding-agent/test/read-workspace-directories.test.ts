import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

function createSession(cwd: string, directories?: string[]): ToolSession {
	const settings = Settings.isolated();
	settings.set("read.summarize.enabled", false);
	return {
		cwd,
		directories,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	} as unknown as ToolSession;
}

describe("read tool workspace-directory fallback", () => {
	let root: string;
	let cwd: string;
	let docsRoot: string;
	let libRoot: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-workspace-"));
		cwd = path.join(root, "cwd");
		docsRoot = path.join(root, "docs-root");
		libRoot = path.join(root, "lib-root");
		await fs.mkdir(path.join(cwd, "notes"), { recursive: true });
		await fs.mkdir(path.join(docsRoot, "notes"), { recursive: true });
		await fs.mkdir(path.join(libRoot, "notes"), { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	it("resolves a relative path through another workspace directory with a notice", async () => {
		await Bun.write(path.join(docsRoot, "notes", "info.md"), "docs info\n");
		const session = createSession(cwd, [cwd, docsRoot]);

		const result = await new ReadTool(session).execute("read-1", { path: "notes/info.md" });
		const output = textOutput(result);

		expect(output).toContain("docs info");
		expect(output).toContain(
			`[Path 'notes/info.md' not found; resolved to '${path.join(docsRoot, "notes", "info.md")}' via workspace directory]`,
		);
	});

	it("prefers the cwd copy without a notice when the path exists under cwd", async () => {
		await Bun.write(path.join(cwd, "notes", "info.md"), "cwd info\n");
		await Bun.write(path.join(docsRoot, "notes", "info.md"), "docs info\n");
		const session = createSession(cwd, [cwd, docsRoot]);

		const output = textOutput(await new ReadTool(session).execute("read-2", { path: "notes/info.md" }));

		expect(output).toContain("cwd info");
		expect(output).not.toContain("via workspace directory");
	});

	it("rejects an ambiguous relative path that exists in multiple workspace directories", async () => {
		await Bun.write(path.join(docsRoot, "notes", "info.md"), "docs info\n");
		await Bun.write(path.join(libRoot, "notes", "info.md"), "lib info\n");
		const session = createSession(cwd, [cwd, docsRoot, libRoot]);

		await expect(new ReadTool(session).execute("read-3", { path: "notes/info.md" })).rejects.toThrow(
			/exists in multiple workspace directories/,
		);
	});

	it("keeps the plain not-found error for single-root sessions", async () => {
		const session = createSession(cwd, [cwd]);

		await expect(new ReadTool(session).execute("read-4", { path: "notes/info.md" })).rejects.toThrow(
			"Path 'notes/info.md' not found",
		);
	});
});

describe("read tool rejects out-of-root `..` escapes (F1)", () => {
	let root: string;
	let cwd: string;
	let otherRoot: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-escape-"));
		// cwd sits deeper than otherRoot so a `..` from otherRoot escapes to a
		// location cwd's own `..` does NOT reach — the only way the cross-root
		// fallback (not the primary cwd resolution) can adopt the out-of-root file.
		cwd = path.join(root, "nested", "cwd");
		otherRoot = path.join(root, "other", "lib");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(otherRoot, "src"), { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	it("does not adopt a candidate that `..`-escapes a workspace root", async () => {
		// Lives OUTSIDE both roots; reachable only by escaping otherRoot via `..`.
		await Bun.write(path.join(root, "other", "secret.txt"), "top secret\n");
		const session = createSession(cwd, [cwd, otherRoot]);

		await expect(new ReadTool(session).execute("read-escape-1", { path: "../secret.txt" })).rejects.toThrow(
			/not found/i,
		);
	});

	it("still resolves a legitimately in-root relative path in an additional root", async () => {
		await Bun.write(path.join(otherRoot, "src", "app.ts"), "export const app = 1;\n");
		const session = createSession(cwd, [cwd, otherRoot]);

		const output = textOutput(await new ReadTool(session).execute("read-escape-2", { path: "src/app.ts" }));
		expect(output).toContain("export const app = 1;");
	});
});
