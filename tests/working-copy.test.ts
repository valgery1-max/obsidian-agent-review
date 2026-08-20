import assert from "node:assert/strict";
import test from "node:test";
import {
  agentTurnInstructions,
  targetDocumentInstructions,
  vaultFilePath,
  workingCopyLocation
} from "../src/working-copy";

test("builds an agent path with the separator of the platform", () => {
  const mac = vaultFilePath("/test-home/Documents/Мои статьи", "Заметки/Без названия 3.md", "darwin");
  const windows = vaultFilePath("C:\\Vault", "Заметки/Без названия 3.md", "win32");

  assert.equal(mac, "/test-home/Documents/Мои статьи/Заметки/Без названия 3.md");
  assert.equal(mac.includes("\\"), false);
  assert.equal(windows, "C:\\Vault\\Заметки\\Без названия 3.md");
});

test("survives a trailing separator and an empty segment in a vault path", () => {
  assert.equal(vaultFilePath("/test-home/Vault/", "Заметка.md", "darwin"), "/test-home/Vault/Заметка.md");
  assert.equal(vaultFilePath("/test-home/Vault", "/Заметка.md", "darwin"), "/test-home/Vault/Заметка.md");
});

const PLUGIN_DIRECTORY = ".obsidian/plugins/codex-review";

test("keeps the working copy outside the vault notes and under the document name", () => {
  const location = workingCopyLocation(PLUGIN_DIRECTORY, "Заметки/Черновик.md");

  assert.equal(location.path.startsWith(`${PLUGIN_DIRECTORY}/worktree/`), true);
  assert.equal(location.path.endsWith("/Черновик.md"), true);
  assert.equal(location.directory, location.path.slice(0, location.path.lastIndexOf("/")));
});

test("gives the same document the same working copy on every turn", () => {
  const first = workingCopyLocation(PLUGIN_DIRECTORY, "Заметки/Черновик.md");
  const second = workingCopyLocation(PLUGIN_DIRECTORY, "Заметки/Черновик.md");

  assert.deepEqual(first, second);
});

test("separates documents that share a file name", () => {
  const first = workingCopyLocation(PLUGIN_DIRECTORY, "Раздел А/Заметка.md");
  const second = workingCopyLocation(PLUGIN_DIRECTORY, "Раздел Б/Заметка.md");

  assert.notEqual(first.path, second.path);
  assert.equal(first.path.endsWith("/Заметка.md"), true);
  assert.equal(second.path.endsWith("/Заметка.md"), true);
});

test("tolerates a trailing separator in the plugin directory", () => {
  const location = workingCopyLocation(`${PLUGIN_DIRECTORY}/`, "Заметка.md");

  assert.equal(location.path.includes("//"), false);
});

// The case this guards: a vault of 468 notes, "Без названия 3.md" open, and a chat message that
// names no file — "Сделай нормальное оформление этой статье". The agent used to search the vault
// and rewrite whichever note looked closest.
const OPEN_NOTE = "Без названия 3.md";
const WORKING_COPY = "C:\\vault\\.obsidian\\plugins\\codex-review\\worktree\\a1\\Без названия 3.md";

test("names the working copy of the open note as the target of the turn", () => {
  const instructions = targetDocumentInstructions(OPEN_NOTE, WORKING_COPY);

  assert.equal(instructions.startsWith(`TARGET DOCUMENT: ${WORKING_COPY}`), true);
  assert.equal(instructions.includes(OPEN_NOTE), true);
});

test("forbids picking the document by searching for it or by the wording of the request", () => {
  const instructions = targetDocumentInstructions(OPEN_NOTE, WORKING_COPY);

  assert.equal(/never search for the document/iu.test(instructions), true);
  assert.equal(/never infer it from the wording of the request/iu.test(instructions), true);
  assert.equal(/never treat another file as the object of the task/iu.test(instructions), true);
  assert.equal(instructions.includes('"This article"'), true);
});

test("leaves edit scope to turn-specific instructions", () => {
  const instructions = targetDocumentInstructions(OPEN_NOTE, WORKING_COPY);

  assert.doesNotMatch(instructions, /quotes no fragment applies to the target document as a whole/iu);
  assert.equal(/target document/iu.test(instructions), true);
});

test("keeps the original document out of the agent's reach", () => {
  const instructions = targetDocumentInstructions(OPEN_NOTE, WORKING_COPY);

  assert.equal(/do not read or write the original document outside this working copy/iu.test(instructions), true);
});

test("keeps the working copy agent-owned for the turn and defines sequential patch recovery", () => {
  const instructions = targetDocumentInstructions(OPEN_NOTE, WORKING_COPY);

  assert.match(instructions, /prepared (?:or refreshed )?once at the start of this turn/iu);
  assert.match(instructions, /during the turn.*only your own file operations change it/isu);
  assert.match(instructions, /user may keep editing the original document separately/iu);
  assert.match(instructions, /merges those edits with your working copy after the turn/iu);
  assert.match(instructions, /after each successful write.*every earlier read as stale/isu);
  assert.match(instructions, /before every subsequent patch.*re-read the current target lines/isu);
  assert.match(instructions, /patch.*context mismatch.*quietly re-read the current target lines.*retry/isu);
  assert.match(instructions, /without telling the user.*user or Agent Review changed the file/isu);
});

test("opens every turn with the target document, whatever else the turn carries", () => {
  const chatTurn = agentTurnInstructions(OPEN_NOTE, WORKING_COPY, "Пиши в авторском стиле.");
  const reviewTurn = agentTurnInstructions(OPEN_NOTE, WORKING_COPY, "review protocol", "Пиши в авторском стиле.");
  const bareTurn = agentTurnInstructions(OPEN_NOTE, WORKING_COPY, "", undefined);

  for (const turn of [chatTurn, reviewTurn, bareTurn]) {
    assert.equal(turn.startsWith(`TARGET DOCUMENT: ${WORKING_COPY}`), true);
  }
  assert.equal(chatTurn.includes("Пиши в авторском стиле."), true);
  assert.equal(reviewTurn.includes("review protocol"), true);
  assert.equal(bareTurn, targetDocumentInstructions(OPEN_NOTE, WORKING_COPY));
});
