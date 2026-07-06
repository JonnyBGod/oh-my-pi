import * as path from "node:path";
import { getRemoteDir } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../sdk";
import { workspaceRootForPath } from "../session/session-workspace";
import { findUniqueWorkspaceSuffix } from "./path-utils";
import { ToolError } from "./tool-errors";

// Remote mount path prefix (sshfs mounts) - skip fuzzy matching to avoid hangs
const REMOTE_MOUNT_PREFIX = getRemoteDir() + path.sep;
export function isRemoteMountPath(absolutePath: string): boolean {
	return absolutePath.startsWith(REMOTE_MOUNT_PREFIX);
}
export function isNotFoundError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: string }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}
/** Per-execute memo of suffix-glob lookups; `null` records a confirmed miss. */
export type SuffixMatchCache = Map<string, { absolutePath: string; displayPath: string } | null>;
/**
 * Memoized {@link findUniqueWorkspaceSuffix} for a single read call. A missing
 * path with archive/sqlite extensions probes the workspace once per stage
 * (archive candidates, sqlite candidates, plain path) — each glob carries a
 * 5s timeout, so repeated lookups of the same string stack into a long
 * stall before erroring. The cache collapses repeats within one execute().
 */
export async function findSuffixMatchCached(
	session: ToolSession,
	cache: SuffixMatchCache,
	rawPath: string,
	signal?: AbortSignal,
): Promise<{ absolutePath: string; displayPath: string } | null> {
	const hit = cache.get(rawPath);
	if (hit !== undefined) return hit;
	const result = await findUniqueWorkspaceSuffix(rawPath, session.cwd, signal);
	cache.set(rawPath, result);
	return result;
}

/**
 * Resolve a relative path that missed under cwd against the session's other
 * workspace directories. Exactly one existing match resolves; multiple matches
 * throw so the caller can't silently read (or later edit) the wrong root.
 */
export async function resolveInWorkspaceDirectories(
	session: ToolSession,
	relativePath: string,
	triedAbsolutePath: string,
): Promise<{ absolutePath: string; size: number; isDirectory: boolean } | null> {
	if (path.isAbsolute(relativePath) || relativePath.startsWith("~")) return null;
	const directories = session.directories ?? [];
	if (directories.length < 2) return null;

	const matches: Array<{ absolutePath: string; size: number; isDirectory: boolean }> = [];
	for (const directory of directories) {
		const candidate = path.resolve(directory, relativePath);
		if (candidate === triedAbsolutePath) continue;
		// Defense in depth: a `..`-escaping relativePath can resolve OUTSIDE every
		// declared root (e.g. roots [/repo, /ws/libs] + `../secret.txt` → /ws/secret.txt).
		// Only adopt a candidate still contained within some declared root.
		if (workspaceRootForPath(candidate, directories, "") === "") continue;
		try {
			const stat = await Bun.file(candidate).stat();
			matches.push({ absolutePath: candidate, size: stat.size, isDirectory: stat.isDirectory() });
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
		}
	}
	if (matches.length > 1) {
		throw new ToolError(
			`Path '${relativePath}' exists in multiple workspace directories: ${matches
				.map(match => match.absolutePath)
				.join(", ")}. Use an absolute path.`,
		);
	}
	return matches[0] ?? null;
}
