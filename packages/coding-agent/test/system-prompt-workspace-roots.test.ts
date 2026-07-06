import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("system prompt additional workspace roots", () => {
	let root: string;
	let cwd: string;
	let docsRoot: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prompt-workspace-"));
		cwd = path.join(root, "cwd");
		docsRoot = path.join(root, "docs-root");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(docsRoot, "guides"), { recursive: true });
		await Bun.write(path.join(docsRoot, "guides", "intro.md"), "# Intro\n");
		await Bun.write(path.join(docsRoot, "AGENTS.md"), "Docs-root rule: always cite sources.\n");
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	it("renders additional roots with trees and inlines their root context files", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd,
			additionalDirectories: [docsRoot],
			includeWorkspaceTree: true,
			contextFiles: [],
			skills: [],
		});
		const joined = systemPrompt.join("\n\n");

		expect(joined).toContain("<workspace-roots>");
		expect(joined).toContain("docs-root");
		// Tree of the additional root is rendered (its subdirectory shows up).
		expect(joined).toContain("guides");
		// The additional root's AGENTS.md is inlined as a context file.
		expect(joined).toContain("Docs-root rule: always cite sources.");
	});

	it("omits the workspace-roots section for single-root sessions", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd,
			includeWorkspaceTree: true,
			contextFiles: [],
			skills: [],
		});
		expect(systemPrompt.join("\n\n")).not.toContain("<workspace-roots>");
	});

	it("ignores additional directories that duplicate the cwd", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd,
			additionalDirectories: [cwd, `${cwd}${path.sep}`],
			includeWorkspaceTree: true,
			contextFiles: [],
			skills: [],
		});
		expect(systemPrompt.join("\n\n")).not.toContain("<workspace-roots>");
	});
});
