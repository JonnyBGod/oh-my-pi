import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	additionalWorkspaceDirectories,
	normalizeSessionWorkspace,
} from "@oh-my-pi/pi-coding-agent/session/session-workspace";

describe("normalizeSessionWorkspace", () => {
	it("defaults to [cwd] when no directories are supplied", () => {
		const workspace = normalizeSessionWorkspace({ cwd: "/tmp/project" });
		expect(workspace).toEqual({ cwd: path.resolve("/tmp/project"), directories: [path.resolve("/tmp/project")] });
	});

	it("keeps cwd first and preserves the supplied order of additional directories", () => {
		const workspace = normalizeSessionWorkspace({
			cwd: "/tmp/project",
			directories: ["/tmp/docs", "/tmp/lib"],
		});
		expect(workspace.directories).toEqual([
			path.resolve("/tmp/project"),
			path.resolve("/tmp/docs"),
			path.resolve("/tmp/lib"),
		]);
	});

	it("deduplicates repeated directories and re-listed cwd", () => {
		const workspace = normalizeSessionWorkspace({
			cwd: "/tmp/project",
			directories: ["/tmp/project", "/tmp/docs", "/tmp/docs/"],
		});
		expect(workspace.directories).toEqual([path.resolve("/tmp/project"), path.resolve("/tmp/docs")]);
	});

	it("normalizes trailing separators and relative segments", () => {
		const workspace = normalizeSessionWorkspace({
			cwd: "/tmp/project/",
			directories: ["/tmp/docs/../docs/"],
		});
		expect(workspace.cwd).toBe(path.resolve("/tmp/project"));
		expect(workspace.directories).toEqual([path.resolve("/tmp/project"), path.resolve("/tmp/docs")]);
	});

	it("resolves relative additional directories against the normalized cwd", () => {
		const workspace = normalizeSessionWorkspace({
			cwd: "/tmp/project",
			directories: ["../sibling"],
		});
		expect(workspace.directories).toEqual([path.resolve("/tmp/project"), path.resolve("/tmp/sibling")]);
	});

	it("expands a leading tilde against the home directory", () => {
		const workspace = normalizeSessionWorkspace({
			cwd: "/tmp/project",
			directories: ["~/notes"],
		});
		expect(workspace.directories).toEqual([path.resolve("/tmp/project"), path.join(os.homedir(), "notes")]);
	});
});

describe("additionalWorkspaceDirectories", () => {
	it("returns the ordered directories beyond cwd", () => {
		const workspace = normalizeSessionWorkspace({
			cwd: "/tmp/project",
			directories: ["/tmp/docs", "/tmp/lib"],
		});
		expect(additionalWorkspaceDirectories(workspace)).toEqual([path.resolve("/tmp/docs"), path.resolve("/tmp/lib")]);
	});

	it("returns an empty list for a single-root workspace", () => {
		const workspace = normalizeSessionWorkspace({ cwd: "/tmp/project" });
		expect(additionalWorkspaceDirectories(workspace)).toEqual([]);
	});
});
