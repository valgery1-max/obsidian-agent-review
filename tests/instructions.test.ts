import assert from "node:assert/strict";
import test from "node:test";
import {
  ancestorFolderPaths,
  applicableInstructionEntries,
  EMPTY_INSTRUCTION_SETTINGS,
  formatDocumentInstructions,
  normalizeInstructionSettings,
  reusableFileInstructionPaths,
  saveInstructionEntry
} from "../src/instructions";

test("normalizes stored instructions and removes empty entries", () => {
  const settings = normalizeInstructionSettings({
    vault: { text: "  Общие правила  ", sourcePaths: ["policy.md", "policy.md"] },
    folders: { drafts: { text: "", sourcePaths: [] } },
    files: { "drafts/note.md": { text: "Правила заметки", sourcePaths: [] } }
  });

  assert.equal(settings.vault?.text, "Общие правила");
  assert.deepEqual(settings.vault?.sourcePaths, ["policy.md"]);
  assert.deepEqual(settings.folders, {});
  assert.equal(settings.files["drafts/note.md"].text, "Правила заметки");
});

test("orders applicable instructions from the vault to the document", () => {
  const settings = structuredClone(EMPTY_INSTRUCTION_SETTINGS);
  saveInstructionEntry(settings, "vault", "articles/guides/note.md", { text: "Общие", sourcePaths: [] }, "1");
  saveInstructionEntry(settings, "folder", "articles/other.md", { text: "Статьи", sourcePaths: [] }, "2");
  saveInstructionEntry(settings, "folder", "articles/guides/note.md", { text: "Гайды", sourcePaths: [] }, "3");
  saveInstructionEntry(settings, "file", "articles/guides/note.md", { text: "Документ", sourcePaths: [] }, "4");

  assert.deepEqual(ancestorFolderPaths("articles/guides/note.md"), ["articles", "articles/guides"]);
  assert.deepEqual(
    applicableInstructionEntries(settings, "articles/guides/note.md").map((item) => item.entry.text),
    ["Общие", "Статьи", "Гайды", "Документ"]
  );
});

test("removes a saved scope when its text and files are cleared", () => {
  const settings = structuredClone(EMPTY_INSTRUCTION_SETTINGS);
  saveInstructionEntry(settings, "file", "note.md", { text: "Правило", sourcePaths: [] });
  saveInstructionEntry(settings, "file", "note.md", { text: "", sourcePaths: [] });
  assert.equal(settings.files["note.md"], undefined);
});

test("lists reusable instructions from other documents", () => {
  const settings = structuredClone(EMPTY_INSTRUCTION_SETTINGS);
  saveInstructionEntry(settings, "file", "articles/current.md", { text: "Текущая", sourcePaths: [] });
  saveInstructionEntry(settings, "file", "articles/zeta.md", { text: "Зета", sourcePaths: [] });
  saveInstructionEntry(settings, "file", "articles/alpha.md", { text: "Альфа", sourcePaths: [] });

  assert.deepEqual(
    reusableFileInstructionPaths(settings, "articles/current.md"),
    ["articles/alpha.md", "articles/zeta.md"]
  );
});

test("formats hidden document instructions with attached Markdown content", () => {
  const text = formatDocumentInstructions([{
    scope: "folder",
    key: "articles",
    label: "Папка: articles",
    entry: { text: "Пишите кратко", sourcePaths: ["Редполитика.md"], updatedAt: "1" },
    sources: [{ path: "Редполитика.md", content: "# Редполитика\n\nПравило." }]
  }]);

  assert.match(text, /Apply them silently/);
  assert.match(text, /Пишите кратко/);
  assert.match(text, /Instruction file: Редполитика\.md/);
  assert.match(text, /# Редполитика/);
});

test("formats local and connected instruction sources", () => {
  const text = formatDocumentInstructions([{
    scope: "vault",
    key: "",
    label: "Вся библиотека",
    entry: { text: "", sourcePaths: [], updatedAt: "1" },
    sources: [
      { path: "C:\\Policies\\editorial.docx" },
      { path: "https://docs.google.com/document/d/example", kind: "google-drive" },
      { path: "https://www.notion.so/example", kind: "notion" }
    ]
  }]);

  assert.match(text, /Instruction file: C:\\Policies\\editorial\.docx/);
  assert.match(text, /Google Drive instruction/);
  assert.match(text, /available Google Drive integration/);
  assert.match(text, /Notion instruction/);
  assert.match(text, /available Notion integration/);
});
