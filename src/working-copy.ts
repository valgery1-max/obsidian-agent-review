import { posix, win32 } from "node:path";

export interface WorkingCopyLocation {
  directory: string;
  path: string;
}

const WORKING_COPY_DIRECTORY = "worktree";

/**
 * Vault paths are separated by "/" on every platform — that is the form the vault adapter uses.
 * A path handed to an agent is a real filesystem path and needs the separator of this platform.
 */
export function vaultFilePath(
  vaultPath: string,
  relativePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const api = platform === "win32" ? win32 : posix;
  return api.join(vaultPath, ...relativePath.split("/").filter(Boolean));
}

function pathKey(filePath: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < filePath.length; index += 1) {
    hash ^= filePath.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function safeFileName(filePath: string): string {
  const name = filePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
  const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, "-").replace(/^[.\s]+/u, "").trim();
  return safe || "document.md";
}

export function workingCopyLocation(pluginDirectory: string, filePath: string): WorkingCopyLocation {
  const base = pluginDirectory.replace(/[\\/]+$/u, "");
  const directory = `${base}/${WORKING_COPY_DIRECTORY}/${pathKey(filePath)}`;
  return { directory, path: `${directory}/${safeFileName(filePath)}` };
}

/**
 * Names the document of the turn. Without it the agent has nothing but the wording of the request
 * to go by and starts searching the vault for a file that matches, which is how a request about
 * "this article" ends up rewriting somebody else's note.
 */
export function targetDocumentInstructions(
  documentPath: string,
  workingCopyAbsolutePath: string
): string {
  return [
    `TARGET DOCUMENT: ${workingCopyAbsolutePath}`,
    `That file is the object of this task. It is the working copy of the document the user has open in Agent Review (${documentPath}) and it holds the current text of that document. Read it before doing anything else.`,
    'Never search for the document, never infer it from the wording of the request, and never treat another file as the object of the task. "This article", "the text", "here" and a request that names no file at all all mean the target document.',
    "This working copy is prepared or refreshed once at the start of this turn. During the turn, it belongs to you and only your own file operations change it. The user may keep editing the original document separately; Agent Review merges those edits with your working copy after the turn.",
    "After each successful write, treat every earlier read as stale. Before every subsequent patch, re-read the current target lines from this working copy.",
    "When a patch has a context mismatch, quietly re-read the current target lines from this working copy and retry the focused edit against them. Continue without telling the user that the user or Agent Review changed the file; conflicts with the original document are handled by the post-turn merge.",
    "Do not read or write the original document outside this working copy. Change only what the request asks for and leave the rest of the file untouched."
  ].join("\n");
}

/**
 * Hidden context of a turn. The target document comes first: whatever else a turn carries, the
 * agent must never be left to work out which file the request is about.
 */
export function agentTurnInstructions(
  documentPath: string,
  workingCopyAbsolutePath: string,
  ...sections: Array<string | undefined>
): string {
  return [
    targetDocumentInstructions(documentPath, workingCopyAbsolutePath),
    ...sections
  ].filter((section) => section?.trim()).join("\n\n");
}
