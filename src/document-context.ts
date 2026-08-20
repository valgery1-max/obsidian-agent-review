/**
 * How much of the document a turn should cover.
 *
 * Codex and Claude read the target file themselves, so Agent Review does not copy the document
 * into the request: an inlined copy costs the same tokens twice and goes stale the moment the user
 * types. What the agent cannot work out on its own is how far to read — a rewrite of one paragraph
 * should not pull in the whole file, and a request about the whole document should not be answered
 * from one section. That is what this module states: the size of the document, its structure, and
 * the reading scope of the task. Reading context and editable scope are separate: the feedback and
 * comment kind define what the agent may change.
 */

export const SMALL_DOCUMENT_LIMIT = 40_000;
export const MAX_DOCUMENT_CONTEXT = 100_000;
export const MAX_OUTLINE_HEADINGS = 200;

export type DocumentSizeClass = "small" | "medium" | "large";
export type AgentTaskKind = "local_transform" | "local_content" | "chat_document";
export type ContextMode = "auto" | "selection" | "section" | "document";

export interface DocumentContextInput {
  text: string;
  kind: AgentTaskKind;
  firstTurn: boolean;
  mode?: ContextMode;
  tokens?: number;
}

const CYRILLIC_FIRST = 0x0400;
const CYRILLIC_LAST = 0x04ff;
const CYRILLIC_CHARS_PER_TOKEN = 2.5;
const LATIN_CHARS_PER_TOKEN = 4;

/**
 * Tokens are counted here, without a model call: Cyrillic runs into more tokens per character than
 * Latin, and the estimate only has to be good enough to place the document in a size class.
 */
export function estimateTokens(text: string): number {
  let cyrillic = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= CYRILLIC_FIRST && code <= CYRILLIC_LAST) cyrillic += 1;
  }
  const other = text.length - cyrillic;
  return Math.ceil(cyrillic / CYRILLIC_CHARS_PER_TOKEN + other / LATIN_CHARS_PER_TOKEN);
}

export function documentSizeClass(tokens: number): DocumentSizeClass {
  if (tokens <= SMALL_DOCUMENT_LIMIT) return "small";
  return tokens <= MAX_DOCUMENT_CONTEXT ? "medium" : "large";
}

/**
 * Markdown headings in document order. Fenced code blocks are skipped so that a shell prompt or a
 * comment never turns into a heading.
 */
export function documentOutline(text: string): string[] {
  const headings: string[] = [];
  let fence = "";
  for (const line of text.split(/\r?\n/u)) {
    const fenceMatch = line.match(/^[\t ]{0,3}(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0].repeat(3);
      if (!fence) fence = marker;
      else if (fence === marker) fence = "";
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^[\t ]{0,3}(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/u);
    if (heading) headings.push(`${heading[1]} ${heading[2]}`);
  }
  return headings;
}

const TRANSFORM_REQUESTS = /сократ|укорот|сожми|сожм[её]|перефразир|переформулир|упрост|короче|понятнее|проще|стил[иья]|канцеляр|грамматик|орфограф|пунктуац|опечатк|формулировк|тавтолог|редактур|отредактир|вычит|rewrite|shorten|simplify|rephrase|reword|proofread|grammar|typos?\b/iu;
const CONTENT_REQUESTS = /добав|допиш|допол|раскр|развер|объясн|поясн|пример|факт|источник|ссылк|проверь|сравн|уточн|аргумент|повтор|выше|ниже|в статье|в тексте|в документе|раздел|глав[аеуы]|term|explain|example|source|fact.?check|verify|expand|elaborate|add\b/iu;

/**
 * A comment is treated as a plain rewrite only when it asks for one and asks for nothing else.
 * Anything that may need to know what the rest of the document already says falls back to the
 * wider context, because that is the answer that cannot go wrong by being too narrow.
 */
export function commentTaskKind(feedback: readonly string[]): AgentTaskKind {
  const requests = feedback.map((text) => text.trim()).filter(Boolean);
  if (requests.length === 0) return "local_content";
  const transforms = requests.every((request) =>
    TRANSFORM_REQUESTS.test(request) && !CONTENT_REQUESTS.test(request));
  return transforms ? "local_transform" : "local_content";
}

function formatTokens(tokens: number): string {
  return String(tokens).replace(/\B(?=(\d{3})+(?!\d))/gu, " ");
}

function outlineSection(text: string): string[] {
  const headings = documentOutline(text);
  if (headings.length === 0) return ["STRUCTURE: the document has no headings."];
  const shown = headings.slice(0, MAX_OUTLINE_HEADINGS);
  return [
    "STRUCTURE:",
    ...shown,
    ...(headings.length > shown.length
      ? [`(${headings.length - shown.length} more headings; read the file for the rest of the structure)`]
      : [])
  ];
}

function readingScope(
  kind: AgentTaskKind,
  size: DocumentSizeClass,
  mode: ContextMode
): string[] {
  if (mode === "selection") {
    return [
      "Edit only the quoted fragment unless the feedback explicitly asks for a wider area.",
      "Read the quoted fragment and any neighboring paragraphs, its section, or the whole document when needed for context; reading context does not expand the edit scope."
    ];
  }
  if (mode === "section") {
    return [
      "Read the section that holds the quoted fragment. Use the structure above for the rest.",
      "This turn has explicit section scope, so edit the section that holds the quoted fragment."
    ];
  }
  if (mode === "document" || kind === "chat_document") {
    if (size === "large") {
      return [
        "The request is about the whole document, and the document is too large to read in one pass.",
        "Work through it section by section using the structure above, and search the file for the places the request is about.",
        "Do not leave part of the document unprocessed without saying so: name the parts you covered."
      ];
    }
    if (size === "medium") {
      return [
        "The request is about the whole document. Read the target file in full when the task needs the whole text.",
        "Otherwise use the structure above to go straight to the sections the request concerns."
      ];
    }
    return ["The request is about the whole document. Read the target file in full before editing it."];
  }
  if (kind === "local_transform") {
    return [
      "This is a local rewrite of the quoted fragment: edit only that fragment unless the feedback explicitly asks for a wider area. Read it together with the two or three paragraphs on each side, or with its whole section when the section is short; reading this context does not expand the edit scope.",
      "Do not read the rest of the document for this task."
    ];
  }
  return [
    "This task adds, checks or develops content at the quoted fragment: edit only that fragment unless the feedback explicitly asks for a wider area. Read the whole section that holds it for context; reading this section does not expand the edit scope.",
    "Use the structure above to see which other sections already cover the subject, so that you do not repeat what the document says elsewhere.",
    size === "small"
      ? "The document is small, so reading it in full is fine when the task needs it."
      : "Do not read the document in full: reach the parts you need through the structure and search."
  ];
}

export function documentContextInstructions(input: DocumentContextInput): string {
  const tokens = input.tokens ?? estimateTokens(input.text);
  const size = documentSizeClass(tokens);
  const mode = input.mode ?? "auto";
  return [
    `DOCUMENT: about ${formatTokens(tokens)} tokens, ${size}.`,
    ...outlineSection(input.text),
    "",
    ...(input.firstTurn ? [] : [
      "CONTINUATION: same task, same target document, same session.",
      "The working copy was prepared or refreshed at the start of this turn, and only your own file operations change it during the turn. Re-read the parts you are about to change before editing them.",
      "Do not start the task over and do not re-read the whole document unless this request needs it."
    ]),
    "READING SCOPE:",
    ...readingScope(input.kind, size, mode)
  ].join("\n");
}
