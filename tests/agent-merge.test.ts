import assert from "node:assert/strict";
import test from "node:test";
import { createAnchor } from "../src/anchors";
import {
  createConversationReviewFromEdits,
  createInlineChangesFromEdits,
  mergeAgentEdits
} from "../src/agent-merge";
import { revertInlineChanges } from "../src/inline-changes";
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
    createdAt: "2026-08-16T00:00:00.000Z",
    status: "sent",
    followUps: []
  };
}

test("applies the agent edit when the user edited another paragraph", () => {
  const base = "Первый абзац про вывод.\n\nВторой абзац без изменений.";
  const agent = "Первый абзац про быстрый вывод.\n\nВторой абзац без изменений.";
  const current = "Первый абзац про вывод.\n\nВторой абзац, дополненный пользователем.";

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.applied.length, 1);
  assert.equal(merged.skipped.length, 0);
  assert.equal(merged.text, "Первый абзац про быстрый вывод.\n\nВторой абзац, дополненный пользователем.");
  assert.equal(merged.text.slice(merged.applied[0].resultFrom, merged.applied[0].resultTo), merged.applied[0].newText);
});

test("keeps the user text outside the agent edit untouched", () => {
  const base = "Для вывода используется cout.";
  const agent = "Для вывода используется серый cout.";
  const current = "Для вывода на экран используется cout.";

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.text, "Для вывода на экран используется серый cout.");
  assert.equal(merged.applied.length, 1);
  assert.equal(merged.applied[0].newText.includes("серый"), true);
});

test("finds the new position after the user inserted a large block above", () => {
  const base = "Вступление.\n\nАбзац с ошибкой в тексте.";
  const agent = "Вступление.\n\nАбзац с исправлением в тексте.";
  const current = `Вступление.\n\n${"Новый большой фрагмент пользователя. ".repeat(20)}\n\nАбзац с ошибкой в тексте.`;

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.applied.length, 1);
  assert.equal(merged.text.endsWith("Абзац с исправлением в тексте."), true);
  assert.equal(merged.text.includes("Новый большой фрагмент пользователя."), true);
});

test("does not restore a fragment the user deleted", () => {
  const base = "Первый абзац.\n\nАбзац с ошибкой в тексте.\n\nТретий абзац.";
  const agent = "Первый абзац.\n\nАбзац с исправлением в тексте.\n\nТретий абзац.";
  const current = "Первый абзац.\n\nТретий абзац.";

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.applied.length, 0);
  assert.equal(merged.skipped.length, 1);
  assert.equal(merged.skipped[0].outcome, "stale");
  assert.equal(merged.text, current);
  assert.equal(merged.text.includes("исправлением"), false);
});

test("reports a conflict when the user changed the same fragment", () => {
  const base = "Для вывода используется cout.";
  const agent = "Для вывода используется серый cout.";
  const current = "Для вывода используется std::cout.";

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.applied.length, 0);
  assert.equal(merged.skipped[0].outcome, "conflict");
  assert.equal(merged.text, current);
});

test("keeps independent edits that only touch each other across whitespace", () => {
  const base = "Для вывода используется cout.";
  const agent = "Для вывода используется серый cout.";
  const current = "Для вывода используется снова cout.";

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.applied.length, 1);
  assert.equal(merged.text, "Для вывода используется снова серый cout.");
});

test("carries many independent agent edits while the user edits other places", () => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `Абзац ${index} со словом старое и хвостом.`);
  const base = paragraphs.join("\n\n");
  const agent = paragraphs
    .map((text, index) => index % 2 === 0 ? text.replace("старое", "новое") : text)
    .join("\n\n");
  const current = paragraphs
    .map((text, index) => index % 2 === 1 ? `${text} Пользовательская вставка ${index}.` : text)
    .join("\n\n");

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.applied.length, 20);
  assert.equal(merged.skipped.length, 0);
  for (let index = 0; index < 40; index += 1) {
    const expected = index % 2 === 0
      ? `Абзац ${index} со словом новое и хвостом.`
      : `Абзац ${index} со словом старое и хвостом. Пользовательская вставка ${index}.`;
    assert.equal(merged.text.includes(expected), true, `абзац ${index}`);
  }
  for (const edit of merged.applied) {
    assert.equal(merged.text.slice(edit.resultFrom, edit.resultTo), edit.newText);
  }
});

test("keeps the edit on the anchored copy when the document repeats a fragment", () => {
  const repeated = "Повторяющийся фрагмент текста.";
  const base = `Раздел А.\n\n${repeated}\n\nРаздел Б.\n\n${repeated}\n\nРаздел В.`;
  const agent = base.replace(
    `Раздел Б.\n\n${repeated}`,
    "Раздел Б.\n\nПовторяющийся уточнённый фрагмент текста."
  );
  const current = `Раздел А.\n\n${repeated}\n\nРаздел Б, дополненный пользователем.\n\n${repeated}\n\nРаздел В.`;

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.applied.length, 1);
  assert.equal(
    merged.text,
    `Раздел А.\n\n${repeated}\n\nРаздел Б, дополненный пользователем.\n\nПовторяющийся уточнённый фрагмент текста.\n\nРаздел В.`
  );
});

test("does not guess between identical fragments when the anchored copy is gone", () => {
  const repeated = "Повторяющийся фрагмент текста, встречающийся дважды.";
  const base = `Раздел.\n\n${repeated}\n\nРаздел.\n\n${repeated}\n\nКонец.`;
  const agent = `Раздел.\n\n${repeated}\n\nРаздел.\n\nПовторяющийся уточнённый фрагмент текста, встречающийся дважды.\n\nКонец.`;
  const current = `Раздел.\n\n${repeated}\n\nКонец.`;

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.applied.length, 0);
  assert.equal(merged.text, current);
  assert.equal(merged.text.includes("уточнённый"), false);
});

test("relocates an edit when the user moved the fragment", () => {
  const paragraph = "Абзац с ошибкой в тексте, который нужно поправить.";
  const base = `Вступление.\n\n${paragraph}\n\nЗаключение.`;
  const agent = base.replace("ошибкой", "неточностью");
  const current = `Вступление.\n\nЗаключение.\n\n${paragraph}`;

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.applied.length, 1);
  assert.equal(
    merged.text,
    "Вступление.\n\nЗаключение.\n\nАбзац с неточностью в тексте, который нужно поправить."
  );
});

test("does not move an edit onto a coincidental match elsewhere", () => {
  const base = "Раздел про вывод.\n\nЗдесь используется cout в примере.\n\nРаздел про ввод.";
  const agent = "Раздел про вывод.\n\nЗдесь используется std::cout в примере.\n\nРаздел про ввод.";
  const current = "Раздел про вывод.\n\nРаздел про ввод, где тоже встречается cout.";

  const merged = mergeAgentEdits(base, agent, current);

  assert.equal(merged.applied.length, 0);
  assert.equal(merged.text, current);
});

test("builds inline changes anchored in the merged document", () => {
  const base = "Начало. Старый фрагмент. Конец.";
  const agent = "Начало. Новый ясный фрагмент. Конец.";
  const current = "Вступление пользователя.\n\nНачало. Старый фрагмент. Конец.";
  const comment = selectionComment(base, "Старый фрагмент");

  const merged = mergeAgentEdits(base, agent, current);
  let index = 0;
  const changes = createInlineChangesFromEdits(
    "note.md",
    "turn-1",
    base,
    merged.text,
    merged.applied,
    [comment],
    () => `change-${++index}`,
    "2026-08-16T01:00:00.000Z"
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].commentId, "comment-1");
  assert.equal(merged.text.slice(changes[0].fromOffset, changes[0].toOffset), changes[0].newText);
  assert.equal(changes[0].anchor.quote, changes[0].newText);
});

test("reverts an accepted agent edit without dropping later user text", () => {
  const base = "Для вывода используется cout.";
  const agent = "Для вывода используется серый cout.";
  const merged = mergeAgentEdits(base, agent, base);
  let index = 0;
  const changes = createInlineChangesFromEdits(
    "note.md",
    "turn-1",
    base,
    merged.text,
    merged.applied,
    [selectionComment(base, "cout")],
    () => `change-${++index}`
  );

  const laterText = `${merged.text}\n\nАбзац, дописанный пользователем после принятия.`;
  const reverted = revertInlineChanges(laterText, changes);

  assert.equal(reverted.revertedIds.length, 1);
  assert.equal(
    reverted.text,
    "Для вывода используется cout.\n\nАбзац, дописанный пользователем после принятия."
  );
});

test("groups conversation changes into cards anchored in the merged document", () => {
  const base = "Первый абзац про вывод.\n\nВторой абзац.";
  const agent = "Первый абзац про быстрый вывод.\n\nВторой абзац.";
  const current = "Заголовок пользователя.\n\nПервый абзац про вывод.\n\nВторой абзац.";

  const merged = mergeAgentEdits(base, agent, current);
  let index = 0;
  const review = createConversationReviewFromEdits(
    "note.md",
    "turn-1",
    merged.text,
    merged.applied,
    "Ускорь формулировку",
    "Готово",
    () => `id-${++index}`,
    "2026-08-16T01:00:00.000Z"
  );

  assert.equal(review.comments.length, 1);
  assert.equal(review.changes.length, 1);
  assert.equal(review.comments[0].quote, "Первый абзац про быстрый вывод.");
  assert.equal(
    merged.text.slice(review.changes[0].fromOffset, review.changes[0].toOffset),
    review.changes[0].newText
  );
});

test("creates a separate chat card for each changed paragraph", () => {
  const base = "Первый старый абзац.\n\nСредний абзац без изменений.\n\nПоследний старый абзац.";
  const agent = "Первый новый абзац.\n\nСредний абзац без изменений.\n\nПоследний новый абзац.";

  const merged = mergeAgentEdits(base, agent, base);
  let index = 0;
  const review = createConversationReviewFromEdits(
    "note.md",
    "turn-chat",
    merged.text,
    merged.applied,
    "Обнови первый и последний абзацы",
    "Готово",
    () => `generated-${++index}`,
    "2026-08-16T00:00:00.000Z"
  );

  assert.equal(review.comments.length, 2);
  assert.equal(review.changes.length, 2);
  assert.deepEqual(
    review.changes.map((change) => change.commentId),
    review.comments.map((comment) => comment.id)
  );
  assert.equal(review.comments.every((comment) => comment.status === "addressed"), true);
  assert.equal(
    review.comments.every((comment) => comment.feedback === "Обнови первый и последний абзацы"),
    true
  );
});

test("keeps paragraphs separated only by an empty line in one chat card", () => {
  const base = "Первый старый абзац.\n\nВторой старый абзац.";
  const agent = "Первый новый абзац.\n\nВторой новый абзац.";

  const merged = mergeAgentEdits(base, agent, base);
  let index = 0;
  const review = createConversationReviewFromEdits(
    "note.md",
    "turn-chat",
    merged.text,
    merged.applied,
    "Обнови оба абзаца",
    "Готово",
    () => `generated-${++index}`
  );

  assert.equal(review.comments.length, 1);
  assert.equal(review.comments[0].quote, agent);
});

test("keeps changes of one paragraph in a single chat card", () => {
  const base = "Первое старое слово и второе старое слово.";
  const agent = "Первое новое слово и второе новое слово.";

  const merged = mergeAgentEdits(base, agent, base);
  let index = 0;
  const review = createConversationReviewFromEdits(
    "note.md",
    "turn-chat",
    merged.text,
    merged.applied,
    "Обнови формулировки",
    "Готово",
    () => `generated-${++index}`
  );

  assert.equal(review.comments.length, 1);
  assert.equal(review.changes.every((change) => change.commentId === review.comments[0].id), true);
  assert.equal(review.comments[0].quote, agent);
});

test("returns the document untouched when the agent changed nothing", () => {
  const base = "Текст без изменений.";
  const current = "Текст без изменений, но с правкой пользователя.";

  const merged = mergeAgentEdits(base, base, current);

  assert.equal(merged.text, current);
  assert.equal(merged.edits.length, 0);
});
