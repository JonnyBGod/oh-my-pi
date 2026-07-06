import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("createAgentSession workspace.additionalDirectories setting", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	async function buildSession(settingsOverrides: Record<string, unknown>, cliDirectories?: string[]) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-workspace-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "cwd");
		const docsRoot = path.join(tempDir, "docs-root");
		const cliRoot = path.join(tempDir, "cli-root");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(docsRoot, { recursive: true });
		fs.mkdirSync(cliRoot, { recursive: true });

		const sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		const { session } = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			additionalDirectories: cliDirectories?.map(name => path.join(tempDir, name)),
			settings: Settings.isolated({
				"async.enabled": false,
				...settingsOverrides,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
		});
		return { session, sessionManager, cwd, docsRoot, cliRoot };
	}

	it("adds settings-configured workspace directories at session creation", async () => {
		const { session, sessionManager, cwd, docsRoot } = await buildSession({
			"workspace.additionalDirectories": ["../docs-root"],
		});
		try {
			expect(sessionManager.getDirectories()).toEqual([path.resolve(cwd), docsRoot]);
		} finally {
			await session.dispose();
		}
	});

	it("merges settings directories with explicit additionalDirectories, dedup included", async () => {
		const { session, sessionManager, cwd, docsRoot, cliRoot } = await buildSession(
			{ "workspace.additionalDirectories": ["../docs-root", "../cli-root"] },
			["cli-root"],
		);
		try {
			expect(sessionManager.getDirectories()).toEqual([path.resolve(cwd), docsRoot, cliRoot]);
		} finally {
			await session.dispose();
		}
	});

	it("leaves the workspace single-root when the setting is empty", async () => {
		const { session, sessionManager, cwd } = await buildSession({});
		try {
			expect(sessionManager.getDirectories()).toEqual([path.resolve(cwd)]);
		} finally {
			await session.dispose();
		}
	});
});
