import assert from "node:assert/strict";
import test from "node:test";
import {
  fileAgentString,
  fileTaskSelection,
  createNewTaskSelection,
  hasExplicitTaskSelection,
  normalizeFileAgentStrings,
  normalizeFileTaskSelections,
  rememberFileAgentString,
  rememberFileTaskSelection,
  sameTaskDirectory,
  taskWorkingDirectory
} from "../src/task-selection";

test("requires an explicit task choice before sending", () => {
  assert.equal(hasExplicitTaskSelection(undefined), false);
  assert.equal(hasExplicitTaskSelection({ threadId: "", threadLabel: "" }), false);
  assert.equal(hasExplicitTaskSelection({ threadId: "thread-1", threadLabel: "Статья" }), true);
});

test("remembers an explicit request to create a new task", () => {
  const target = createNewTaskSelection("Заметка");

  assert.deepEqual(target, {
    threadId: "",
    threadLabel: "Новая задача: Заметка",
    createNew: true,
    provider: "codex"
  });
  assert.equal(hasExplicitTaskSelection(target), true);
});

test("recognizes the same task directory with Windows separators and casing", () => {
  assert.equal(sameTaskDirectory("C:\\Vault\\Notes\\", "c:/vault/notes"), true);
  assert.equal(sameTaskDirectory("C:\\Vault\\Notes", "C:\\Other"), false);
});

test("keeps an external Claude task in its original working directory", () => {
  const target = {
    threadId: "thread-1",
    threadLabel: "Research",
    provider: "claude" as const,
    cwd: "C:\\Research"
  };

  assert.equal(taskWorkingDirectory(target, "C:\\Vault", "claude"), "C:\\Research");
  assert.equal(taskWorkingDirectory(target, "C:\\Vault", "codex"), "C:\\Vault");
  assert.equal(taskWorkingDirectory(undefined, "C:\\Vault", "claude"), "C:\\Vault");
});

test("remembers a separate task for each agent in the same file", () => {
  const selections = {};
  rememberFileTaskSelection(selections, "article.md", "codex", {
    threadId: "codex-thread",
    threadLabel: "Codex article"
  });
  rememberFileTaskSelection(selections, "article.md", "claude", {
    threadId: "claude-thread",
    threadLabel: "Claude article",
    cwd: "C:\\Claude"
  });

  assert.equal(fileTaskSelection(selections, "article.md", "codex")?.threadId, "codex-thread");
  assert.equal(fileTaskSelection(selections, "article.md", "claude")?.threadId, "claude-thread");
  assert.equal(fileTaskSelection(selections, "article.md", "claude")?.provider, "claude");
});

test("migrates one legacy file task to its original agent", () => {
  const selections = normalizeFileTaskSelections({
    "article.md": {
      threadId: "claude-thread",
      threadLabel: "Research",
      provider: "claude",
      cwd: "C:\\Research"
    }
  });

  assert.equal(fileTaskSelection(selections, "article.md", "codex"), undefined);
  assert.equal(fileTaskSelection(selections, "article.md", "claude")?.threadId, "claude-thread");
});

test("remembers model and goal separately for each agent", () => {
  const models = normalizeFileAgentStrings({ "article.md": "sonnet" }, { "article.md": "claude" });
  assert.equal(fileAgentString(models, "article.md", "claude"), "sonnet");
  rememberFileAgentString(models, "article.md", "codex", "gpt-5.6");

  assert.equal(fileAgentString(models, "article.md", "claude"), "sonnet");
  assert.equal(fileAgentString(models, "article.md", "codex"), "gpt-5.6");
});
