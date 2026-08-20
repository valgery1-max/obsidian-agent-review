import assert from "node:assert/strict";
import test from "node:test";
import {
  commentTaskKind,
  documentContextInstructions,
  documentOutline,
  documentSizeClass,
  estimateTokens,
  MAX_DOCUMENT_CONTEXT,
  SMALL_DOCUMENT_LIMIT
} from "../src/document-context";

const ARTICLE = [
  "# Шаблонные строки в JavaScript",
  "",
  "Вводный абзац статьи.",
  "",
  "## Возможности шаблонных строк",
  "",
  "### Вставка переменных и выражений",
  "",
  "```js",
  "// # это не заголовок, а комментарий в коде",
  "const value = `${a + b}`;",
  "```",
  "",
  "### Экранирование специальных символов",
  "",
  "Текст раздела.",
  "",
  "## Тегированные шаблоны",
  "",
  "Текст раздела."
].join("\n");

test("estimates tokens without a model call and separates the size classes", () => {
  const latin = estimateTokens("a".repeat(400));
  const cyrillic = estimateTokens("а".repeat(400));

  assert.equal(latin, 100);
  assert.equal(cyrillic > latin, true);
  assert.equal(documentSizeClass(SMALL_DOCUMENT_LIMIT), "small");
  assert.equal(documentSizeClass(SMALL_DOCUMENT_LIMIT + 1), "medium");
  assert.equal(documentSizeClass(MAX_DOCUMENT_CONTEXT), "medium");
  assert.equal(documentSizeClass(MAX_DOCUMENT_CONTEXT + 1), "large");
});

test("reads the structure out of the document and ignores headings inside code", () => {
  assert.deepEqual(documentOutline(ARTICLE), [
    "# Шаблонные строки в JavaScript",
    "## Возможности шаблонных строк",
    "### Вставка переменных и выражений",
    "### Экранирование специальных символов",
    "## Тегированные шаблоны"
  ]);
  assert.deepEqual(documentOutline("Просто текст без заголовков."), []);
});

test("treats a comment as a plain rewrite only when it asks for nothing else", () => {
  assert.equal(commentTaskKind(["Сократи."]), "local_transform");
  assert.equal(commentTaskKind(["Улучши стиль и убери канцелярит"]), "local_transform");
  assert.equal(commentTaskKind(["Исправь грамматику"]), "local_transform");

  assert.equal(commentTaskKind(["Добавь пример."]), "local_content");
  assert.equal(commentTaskKind(["Проверь, не повторяется ли это выше"]), "local_content");
  assert.equal(commentTaskKind(["Сократи и добавь пример"]), "local_content");
  assert.equal(commentTaskKind(["Сделай тут нормально"]), "local_content");
  assert.equal(commentTaskKind(["Сократи.", "Раскрой мысль"]), "local_content");
  assert.equal(commentTaskKind([]), "local_content");
});

test("sends a small document in the chat as a whole-document task", () => {
  const instructions = documentContextInstructions({
    text: ARTICLE,
    kind: "chat_document",
    firstTurn: true
  });

  assert.equal(instructions.includes("small"), true);
  assert.equal(instructions.includes("## Тегированные шаблоны"), true);
  assert.equal(/read the target file in full/iu.test(instructions), true);
});

test("keeps a stylistic comment out of the rest of the document", () => {
  const instructions = documentContextInstructions({
    text: ARTICLE,
    kind: "local_transform",
    firstTurn: true
  });

  assert.equal(/two or three paragraphs on each side/iu.test(instructions), true);
  assert.equal(/edit only that fragment unless the feedback explicitly asks for a wider area/iu.test(instructions), true);
  assert.equal(/reading this context does not expand the edit scope/iu.test(instructions), true);
  assert.equal(/do not read the rest of the document/iu.test(instructions), true);
  assert.equal(/read the target file in full/iu.test(instructions), false);
});

test("gives a content comment the section and the structure around it", () => {
  const instructions = documentContextInstructions({
    text: ARTICLE,
    kind: "local_content",
    firstTurn: true
  });

  assert.equal(/read the whole section that holds it/iu.test(instructions), true);
  assert.equal(/edit only that fragment unless the feedback explicitly asks for a wider area/iu.test(instructions), true);
  assert.equal(/reading this section does not expand the edit scope/iu.test(instructions), true);
  assert.equal(/do not repeat what the document says elsewhere/iu.test(instructions), true);
  assert.equal(/reading it in full is fine/iu.test(instructions), true);
});

test("does not offer a full read of a large document to a content comment", () => {
  const instructions = documentContextInstructions({
    text: ARTICLE,
    tokens: 150_000,
    kind: "local_content",
    firstTurn: true
  });

  assert.equal(/do not read the document in full/iu.test(instructions), true);
});

test("splits a large document into sections instead of one request", () => {
  const instructions = documentContextInstructions({
    text: ARTICLE,
    tokens: 150_000,
    kind: "chat_document",
    firstTurn: true
  });

  assert.equal(instructions.includes("large"), true);
  assert.equal(/too large to read in one pass/iu.test(instructions), true);
  assert.equal(/section by section/iu.test(instructions), true);
  assert.equal(/read the target file in full/iu.test(instructions), false);
});

test("continues a thread instead of setting the task up again", () => {
  const instructions = documentContextInstructions({
    text: ARTICLE,
    kind: "chat_document",
    firstTurn: false
  });

  assert.equal(/CONTINUATION: same task, same target document/u.test(instructions), true);
  assert.equal(/working copy was prepared or refreshed at the start of this turn/iu.test(instructions), true);
  assert.doesNotMatch(instructions, /refreshed the working copy with the text the user has now/iu);
  assert.equal(/do not start the task over/iu.test(instructions), true);
});

test("keeps continuation reads inside the agent-owned working copy", () => {
  const instructions = documentContextInstructions({
    text: ARTICLE,
    kind: "chat_document",
    firstTurn: false
  });

  assert.match(instructions, /re-read the parts you are about to change before editing them/iu);
  assert.doesNotMatch(instructions, /user has now/iu);
});

test("never scopes a chat request by a fragment", () => {
  const instructions = documentContextInstructions({
    text: ARTICLE,
    kind: "chat_document",
    firstTurn: true
  });

  assert.equal(/fragment/iu.test(instructions), false);
  assert.equal(/selection/iu.test(instructions), false);
});

test("honours an explicit context mode and keeps the limit in document mode", () => {
  const selection = documentContextInstructions({
    text: ARTICLE,
    kind: "local_content",
    mode: "selection",
    firstTurn: true
  });
  const section = documentContextInstructions({
    text: ARTICLE,
    kind: "local_transform",
    mode: "section",
    firstTurn: true
  });
  const whole = documentContextInstructions({
    text: ARTICLE,
    kind: "local_transform",
    mode: "document",
    firstTurn: true
  });
  const largeWhole = documentContextInstructions({
    text: ARTICLE,
    tokens: 150_000,
    kind: "local_transform",
    mode: "document",
    firstTurn: true
  });

  assert.doesNotMatch(selection, /nothing else/iu);
  assert.match(selection, /any neighboring paragraphs, its section, or the whole document when needed for context/iu);
  assert.equal(/edit only the quoted fragment unless the feedback explicitly asks for a wider area/iu.test(selection), true);
  assert.equal(/read the section that holds the quoted fragment/iu.test(section), true);
  assert.equal(/read the target file in full/iu.test(whole), true);
  assert.equal(/too large to read in one pass/iu.test(largeWhole), true);
});
