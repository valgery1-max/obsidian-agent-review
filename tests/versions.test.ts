import assert from "node:assert/strict";
import test from "node:test";
import {
  appendDocumentVersion,
  changesBetweenVersions,
  contextualVersionParts,
  createDocumentVersion,
  normalizeDocumentVersion,
  originalVersionId,
  versionsForFile
} from "../src/versions";
import type { ReviewDocumentVersion, ReviewVersionSource } from "../src/types";

let sequence = 0;

function version(
  text: string,
  source: ReviewVersionSource,
  createdAt: string,
  options: { filePath?: string; originId?: string; restoredFromVersionId?: string } = {}
): ReviewDocumentVersion {
  return createDocumentVersion(
    options.filePath ?? "note.md",
    text,
    source,
    () => `version-${++sequence}`,
    createdAt,
    options
  );
}

test("lists versions of the current file from newest to oldest", () => {
  const versions = [
    version("Старая", "before_codex", "2026-08-10T10:00:00.000Z"),
    version("Другая заметка", "codex", "2026-08-10T12:00:00.000Z", { filePath: "other.md" }),
    version("Новая", "codex", "2026-08-10T11:00:00.000Z")
  ];

  assert.deepEqual(versionsForFile(versions, "note.md").map((item) => item.text), ["Новая", "Старая"]);
  assert.equal(originalVersionId(versions, "note.md"), versions[0].id);
});

test("does not duplicate a migrated activity snapshot", () => {
  const first = version("Текст", "codex", "2026-08-10T10:00:00.000Z", { originId: "turn-1:after" });
  const duplicate = version("Текст ещё раз", "codex", "2026-08-10T10:01:00.000Z", { originId: "turn-1:after" });
  const versions = appendDocumentVersion(appendDocumentVersion([], first), duplicate);

  assert.equal(versions.length, 1);
  assert.equal(versions[0].text, "Текст");
});

test("keeps a manual edit made before accepting a Codex change", () => {
  const codex = version("Текст Codex", "codex", "2026-08-10T10:00:00.000Z");
  const manuallyEdited = version(
    "Текст Codex с ручной правкой пользователя",
    "accepted",
    "2026-08-10T10:05:00.000Z"
  );
  const versions = appendDocumentVersion(appendDocumentVersion([], codex), manuallyEdited);

  assert.equal(versionsForFile(versions, "note.md")[0].text, manuallyEdited.text);
  assert.equal(versionsForFile(versions, "note.md")[0].source, "accepted");
});

test("saves the current text before adding a restored version", () => {
  const old = version("Первая версия", "codex", "2026-08-10T09:00:00.000Z");
  const current = version("Текущая ручная редакция", "before_restore", "2026-08-10T10:00:00.000Z");
  const restored = version("Первая версия", "restored", "2026-08-10T10:00:00.001Z", {
    restoredFromVersionId: old.id
  });
  const versions = [old, current, restored].reduce(appendDocumentVersion, [] as ReviewDocumentVersion[]);

  assert.deepEqual(versionsForFile(versions, "note.md").slice(0, 2).map((item) => item.source), [
    "restored",
    "before_restore"
  ]);
  assert.equal(versionsForFile(versions, "note.md")[0].restoredFromVersionId, old.id);
});

test("normalizes a stored version and rejects malformed data", () => {
  const stored = version("Текст", "accepted", "2026-08-10T10:00:00.000Z");
  assert.deepEqual(normalizeDocumentVersion(stored), stored);
  assert.equal(normalizeDocumentVersion({ ...stored, source: "unknown" }), null);
  assert.equal(normalizeDocumentVersion({ ...stored, text: 42 }), null);
});

test("groups the changes of one version into before and after fragments", () => {
  const changes = changesBetweenVersions(
    "Первый абзац.\n\nСтарый второй абзац.\n\nПоследний абзац.\n",
    "Первый абзац.\n\nНовый второй абзац.\n\nПоследний абзац.\n\nДобавленный абзац.\n"
  );

  assert.deepEqual(changes, [
    { before: "Старый второй абзац.", after: "Новый второй абзац." },
    { before: "", after: "Добавленный абзац." }
  ]);
});

test("keeps changed paragraphs at their actual position in complete version content", () => {
  const before = "# Заголовок\n\nПервый абзац.\n\nСтарый абзац.\n\nПоследний абзац.\n";
  const after = "# Заголовок\n\nПервый абзац.\n\nНовый абзац.\n\nПоследний абзац.\n";
  const parts = contextualVersionParts(before, after);

  assert.deepEqual(parts, [
    { kind: "content", text: "# Заголовок\n\nПервый абзац.\n\n" },
    { kind: "change", before: "Старый абзац.", after: "Новый абзац." },
    { kind: "content", text: "\n\nПоследний абзац.\n" }
  ]);
  assert.equal(parts.map((part) => part.kind === "content" ? part.text : part.after).join(""), after);
  assert.equal(parts.map((part) => part.kind === "content" ? part.text : part.before).join(""), before);
});

test("keeps inserted and deleted paragraphs in complete version context", () => {
  const cases = [
    [
      "Первый абзац.\n\nПоследний абзац.",
      "Первый абзац.\n\nДобавленный абзац.\n\nПоследний абзац."
    ],
    [
      "Первый абзац.\n\nУдаляемый абзац.\n\nПоследний абзац.",
      "Первый абзац.\n\nПоследний абзац."
    ]
  ] as const;

  for (const [before, after] of cases) {
    const parts = contextualVersionParts(before, after);
    assert.equal(parts.map((part) => part.kind === "content" ? part.text : part.after).join(""), after);
    assert.equal(parts.map((part) => part.kind === "content" ? part.text : part.before).join(""), before);
    assert.ok(parts.some((part) => part.kind === "change"));
  }
});
