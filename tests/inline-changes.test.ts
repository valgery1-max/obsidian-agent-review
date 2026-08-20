import assert from "node:assert/strict";
import test from "node:test";
import { createAnchor } from "../src/anchors";
import {
  createInlineChanges,
  firstOldParagraphForComment,
  groupInlineChangesByParagraph,
  locateInlineChange,
  refreshInlineChangeLocations,
  revertInlineChanges
} from "../src/inline-changes";
import type { ReviewComment } from "../src/types";

function selectionComment(text: string, quote: string, id = "comment-1"): ReviewComment {
  const from = text.indexOf(quote);
  return {
    id,
    filePath: "note.md",
    kind: "selection",
    quote,
    anchor: createAnchor(text, from, from + quote.length),
    fromOffset: from,
    toOffset: from + quote.length,
    feedback: "Переписать",
    createdAt: "2026-08-10T00:00:00.000Z",
    status: "addressed",
    followUps: []
  };
}

function changesFor(beforeText: string, afterText: string, comment: ReviewComment) {
  let index = 0;
  return createInlineChanges(
    "note.md",
    "turn-1",
    beforeText,
    afterText,
    [comment],
    () => `change-${++index}`,
    "2026-08-10T01:00:00.000Z"
  );
}

test("creates an inline before/after fragment for the related selection", () => {
  const before = "Начало. Старый фрагмент. Конец.";
  const after = "Начало. Новый ясный фрагмент. Конец.";
  const changes = changesFor(before, after, selectionComment(before, "Старый фрагмент"));

  assert.equal(changes.length, 1);
  assert.equal(changes[0].commentId, "comment-1");
  assert.equal(changes[0].oldText.trim(), "Старый");
  assert.equal(changes[0].newText.trim(), "Новый ясный");
  assert.equal(after.slice(changes[0].fromOffset, changes[0].toOffset), changes[0].newText);
});

test("groups granular changes into complete Markdown paragraphs for display", () => {
  const before = "Первый абзац со старым словом и прежним окончанием.\n\nВторой абзац без изменений.";
  const after = "Первый абзац с новым словом и другим окончанием.\n\nВторой абзац без изменений.";
  const changes = changesFor(before, after, selectionComment(before, "старым словом"));
  const paragraphs = groupInlineChangesByParagraph(after, changes);

  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].oldText, "Первый абзац со старым словом и прежним окончанием.");
  assert.equal(paragraphs[0].newText, "Первый абзац с новым словом и другим окончанием.");
  assert.deepEqual(paragraphs[0].commentIds, ["comment-1"]);
  assert.equal(paragraphs[0].from, 0);
  assert.equal(paragraphs[0].to, after.indexOf("\n\n"));
});

test("keeps paragraph display separate while precise changes remain reversible", () => {
  const before = "Абзац со старым словом и прежним окончанием.";
  const after = "Абзац с новым словом и другим окончанием.";
  const changes = changesFor(before, after, selectionComment(before, "старым словом"));
  const [paragraph] = groupInlineChangesByParagraph(after, changes);

  assert.equal(paragraph.oldText, before);
  assert.equal(revertInlineChanges(after, changes).text, before);
});

test("finds the first old paragraph that belongs to a comment", () => {
  const before = "Первый старый абзац.\n\nСредний абзац без изменений.\n\nПоследний старый абзац.";
  const after = "Первый новый абзац.\n\nСредний абзац без изменений.\n\nПоследний новый абзац.";
  const changes = changesFor(before, after, selectionComment(before, "Первый старый абзац"));
  const paragraph = firstOldParagraphForComment(after, changes, "comment-1");

  assert.ok(paragraph);
  assert.equal(paragraph.from, 0);
  assert.equal(paragraph.oldText, "Первый старый абзац.");
});

test("keeps edits separated only by an empty line in one fragment", () => {
  const before = "Первый старый абзац.\n\nВторой старый абзац.";
  const after = "Первый новый абзац.\n\nВторой новый абзац.";
  const changes = changesFor(before, after, selectionComment(before, "Первый старый абзац"));

  assert.equal(changes.length, 1);
  assert.equal(changes[0].oldText.includes("\n\n"), true);
  assert.equal(before.includes(changes[0].oldText), true);
  assert.equal(revertInlineChanges(after, changes).text, before);
});

test("splits edits when two empty lines separate them", () => {
  const before = "Первый старый абзац.\n\n\nВторой старый абзац.";
  const after = "Первый новый абзац.\n\n\nВторой новый абзац.";
  const changes = changesFor(before, after, selectionComment(before, "Первый старый абзац"));

  assert.equal(changes.length, 2);
});

test("splits edits separated by text that stayed unedited", () => {
  const before = "Первый старый абзац.\n\nСредний абзац без изменений.\n\nПоследний старый абзац.";
  const after = "Первый новый абзац.\n\nСредний абзац без изменений.\n\nПоследний новый абзац.";
  const changes = changesFor(before, after, selectionComment(before, "Первый старый абзац"));

  assert.equal(changes.length, 2);
});

test("assigns a whole-document edit to the document comment", () => {
  const before = "Первый абзац.\n\nВторой абзац.";
  const after = "Новый первый абзац.\n\nВторой абзац.";
  const comment: ReviewComment = {
    ...selectionComment(before, "Второй абзац"),
    id: "document-comment",
    kind: "document",
    quote: "",
    anchor: { prefix: "", quote: "", suffix: "" },
    fromOffset: 0,
    toOffset: 0
  };
  const changes = changesFor(before, after, comment);

  assert.ok(changes.length > 0);
  assert.ok(changes.every((change) => change.commentId === "document-comment"));
});

test("uses the related comment when a migrated anchor already points to the rewritten text", () => {
  const before = "Старая редакция текста.";
  const after = "Новая редакция текста.";
  const alreadyRelocated = selectionComment(after, "Новая редакция");
  const changes = changesFor(before, after, alreadyRelocated);

  assert.ok(changes.length > 0);
  assert.ok(changes.every((change) => change.commentId === alreadyRelocated.id));
});

test("locates a pending change after unrelated text is inserted before it", () => {
  const before = "До старый текст после";
  const after = "До новый текст после";
  const [change] = changesFor(before, after, selectionComment(before, "старый текст"));
  const current = "Вступление. " + after;
  const location = locateInlineChange(current, change);

  assert.ok(location);
  assert.equal(current.slice(location.from, location.to), change.newText);
});

test("reverts replacement, insertion and deletion fragments", () => {
  const cases = [
    ["До старый текст после", "До новый текст после", "старый текст"],
    ["До текста", "До важного текста", "текста"],
    ["До лишний текст после", "До после", "лишний текст"]
  ] as const;

  for (const [before, after, quote] of cases) {
    const changes = changesFor(before, after, selectionComment(before, quote));
    const result = revertInlineChanges(after, changes);
    assert.equal(result.text, before);
    assert.equal(result.unresolvedIds.length, 0);
    assert.equal(result.revertedIds.length, changes.length);
  }
});

test("refreshes a change anchor after an earlier edit is reverted", () => {
  const before = "Префикс. Старый текст. Конец.";
  const after = "Префикс. Новый текст. Конец.";
  const [change] = changesFor(before, after, selectionComment(before, "Старый текст"));
  const shifted = "Большой " + after;
  const [refreshed] = refreshInlineChangeLocations(shifted, [change]);

  assert.equal(shifted.slice(refreshed.fromOffset, refreshed.toOffset), refreshed.newText);
  assert.equal(refreshed.anchor.prefix.endsWith("Префикс. "), true);
});
