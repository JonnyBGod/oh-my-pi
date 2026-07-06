/**
 * Mid-session workspace-scope rebuild for the Mnemopi backend.
 *
 * Two layers:
 *  1. Pure derivation — `resolveMnemopiScopedBanks(loadMnemopiConfig(...))`
 *     reflects the workspace directory set (the invariant the rebuild relies on
 *     to decide whether the scope moved).
 *  2. Live rebuild — driving `sessionManager.onWorkspaceDirectoriesChanged`
 *     through the real `mnemopiBackend.start` wiring swaps in a fresh state
 *     whose recall banks match the new set, with no rebuild on a no-op change.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	getMnemopiSessionState,
	loadMnemopi,
	loadMnemopiCore,
	type MnemopiSessionState,
	resolveMnemopiScopedBanks,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

describe("resolveMnemopiScopedBanks reflects the workspace directory set", () => {
	beforeEach(() => resetSettingsForTest());

	it("adds a recall bank per extra root while keeping writes cwd-anchored", () => {
		const settings = Settings.isolated({ "mnemopi.scoping": "per-project", "mnemopi.noEmbeddings": true });
		const cwd = settings.getCwd();
		const extra = path.join(cwd, "..", "some-other-root");

		const single = resolveMnemopiScopedBanks(loadMnemopiConfig(settings, "/tmp/mnemopi-scope-test", [cwd]));
		const multi = resolveMnemopiScopedBanks(loadMnemopiConfig(settings, "/tmp/mnemopi-scope-test", [cwd, extra]));

		expect(multi.retainBank).toBe(single.retainBank);
		expect(multi.recallBanks.length).toBe(single.recallBanks.length + 1);
		expect(multi.recallBanks).toEqual(expect.arrayContaining([...single.recallBanks]));
		// Removing the extra root again collapses back to the single-root scope.
		expect(single.recallBanks.every(bank => multi.recallBanks.includes(bank))).toBe(true);
		expect(multi.recallBanks.some(bank => !single.recallBanks.includes(bank))).toBe(true);
	});
});

describe("mnemopiBackend workspace-scope rebuild", () => {
	let tempDir: TempDir | undefined;
	let state: MnemopiSessionState | undefined;

	function makeSession(settings: Settings, cwd: string, directories: string[]) {
		let dirs = directories;
		const workspaceListeners = new Set<(previous: string[], next: string[]) => void>();
		return {
			sessionId: "mnemopi-ws-session",
			settings,
			modelRegistry: { getApiKeyForProvider: async () => undefined } as never,
			sessionManager: {
				getEntries: () => [],
				getCwd: () => cwd,
				getDirectories: () => dirs,
				onWorkspaceDirectoriesChanged(cb: (previous: string[], next: string[]) => void) {
					workspaceListeners.add(cb);
					return () => workspaceListeners.delete(cb);
				},
			},
			subscribe: () => () => {},
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			emitWorkspaceChange(next: string[]) {
				const previous = dirs;
				dirs = next;
				for (const l of [...workspaceListeners]) l(previous, next);
			},
			workspaceListenerCount: () => workspaceListeners.size,
		};
	}

	async function waitForRebuild(check: () => boolean): Promise<void> {
		for (let i = 0; i < 50; i++) {
			if (check()) return;
			await Bun.sleep(2);
		}
	}

	beforeEach(() => {
		resetSettingsForTest();
		tempDir = TempDir.createSync(`@mnemopi-ws-${Date.now()}-`);
	});

	afterEach(async () => {
		await state?.dispose({ consolidate: false }).catch(() => {});
		state = undefined;
		resetMemoryForTests();
		await Bun.sleep(0);
		await tempDir?.remove().catch(() => {});
		tempDir = undefined;
	});

	function settingsFor(): Settings {
		return Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "per-project",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.autoRecall": false,
			"mnemopi.autoRetain": false,
			"mnemopi.dbPath": tempDir!.join("mnemopi.db"),
		});
	}

	it("swaps in a state whose recall banks reflect an added root", async () => {
		const settings = settingsFor();
		const cwd = tempDir!.join("alpha");
		const beta = tempDir!.join("beta");
		const session = makeSession(settings, cwd, [cwd]);

		await mnemopiBackend.start({
			session: session as never,
			settings,
			modelRegistry: session.modelRegistry,
			agentDir: tempDir!.path(),
			taskDepth: 0,
		});

		const before = getMnemopiSessionState(session as never);
		expect(before?.getScopedRecallTargets().length).toBe(1);

		session.emitWorkspaceChange([cwd, beta]);
		await waitForRebuild(() => getMnemopiSessionState(session as never) !== before);

		const after = getMnemopiSessionState(session as never);
		state = after;
		expect(after).toBeDefined();
		expect(after).not.toBe(before);
		expect(after?.getScopedRecallTargets().length).toBe(2);
		// The fresh state re-subscribed; the disposed one released its listener.
		expect(session.workspaceListenerCount()).toBe(1);
	});

	it("does not rebuild when the scope is unchanged", async () => {
		const settings = settingsFor();
		const cwd = tempDir!.join("alpha");
		const session = makeSession(settings, cwd, [cwd]);

		await mnemopiBackend.start({
			session: session as never,
			settings,
			modelRegistry: session.modelRegistry,
			agentDir: tempDir!.path(),
			taskDepth: 0,
		});
		const before = getMnemopiSessionState(session as never);
		state = before;

		session.emitWorkspaceChange([cwd]);
		await Bun.sleep(20);

		expect(getMnemopiSessionState(session as never)).toBe(before);
	});
});
