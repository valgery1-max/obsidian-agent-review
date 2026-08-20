import type { ReviewDocumentVersion, ReviewVersionSource } from "./types";
import { diffLines } from "diff";
import { createInlineChanges, groupInlineChangesByParagraph } from "./inline-changes";

export interface ReviewVersionChange {
  before: string;
  after: string;
}

export type ReviewVersionContentPart =
  | { kind: "content"; text: string }
  | { kind: "change"; before: string; after: string };

const VERSION_SOURCES = new Set<ReviewVersionSource>([
  "before_codex",
  "codex",
  "accepted",
  "before_cancel",
  "cancelled",
  "before_restore",
  "restored"
]);

export function createDocumentVersion(
  filePath: string,
  text: string,
  source: ReviewVersionSource,
  idFactory: () => string,
  createdAt = new Date().toISOString(),
  options: { originId?: string; restoredFromVersionId?: string } = {}
): ReviewDocumentVersion {
  return {
    id: idFactory(),
    filePath,
    createdAt,
    text,
    source,
    originId: options.originId,
    restoredFromVersionId: options.restoredFromVersionId
  };
}

export function appendDocumentVersion(
  versions: ReviewDocumentVersion[],
  version: ReviewDocumentVersion
): ReviewDocumentVersion[] {
  if (version.originId && versions.some((item) => item.originId === version.originId)) return versions;
  const latest = versionsForFile(versions, version.filePath)[0];
  if (latest?.text === version.text) return versions;
  return [...versions, version];
}

export function versionsForFile(
  versions: ReviewDocumentVersion[],
  filePath: string | undefined
): ReviewDocumentVersion[] {
  if (!filePath) return [];
  return versions
    .filter((version) => version.filePath === filePath)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

export function originalVersionId(
  versions: ReviewDocumentVersion[],
  filePath: string | undefined
): string | undefined {
  return versionsForFile(versions, filePath).at(-1)?.id;
}

export function changesBetweenVersions(before: string, after: string): ReviewVersionChange[] {
  const changes: ReviewVersionChange[] = [];
  let current: ReviewVersionChange | null = null;
  const flush = () => {
    if (!current) return;
    changes.push({
      before: current.before.replace(/^(?:\r?\n)+/, "").trimEnd(),
      after: current.after.replace(/^(?:\r?\n)+/, "").trimEnd()
    });
    current = null;
  };

  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) {
      flush();
      continue;
    }
    current ??= { before: "", after: "" };
    if (part.removed) current.before += part.value;
    if (part.added) current.after += part.value;
  }
  flush();
  return changes;
}

export function contextualVersionParts(before: string, after: string): ReviewVersionContentPart[] {
  if (before === after) return [{ kind: "content", text: after }];
  let sequence = 0;
  const changes = createInlineChanges(
    "version.md",
    "version-diff",
    before,
    after,
    [{
      id: "version-diff",
      filePath: "version.md",
      kind: "document",
      quote: "",
      anchor: { prefix: "", quote: "", suffix: "" },
      fromOffset: 0,
      toOffset: 0,
      feedback: "",
      createdAt: "",
      status: "addressed",
      followUps: []
    }],
    () => `version-change-${++sequence}`
  );
  const paragraphs = groupInlineChangesByParagraph(after, changes);
  if (paragraphs.length === 0) return [{ kind: "content", text: after }];

  const parts: ReviewVersionContentPart[] = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.from > cursor) {
      parts.push({ kind: "content", text: after.slice(cursor, paragraph.from) });
    }
    parts.push({ kind: "change", before: paragraph.oldText, after: paragraph.newText });
    cursor = paragraph.to;
  }
  if (cursor < after.length) parts.push({ kind: "content", text: after.slice(cursor) });
  return parts;
}

export function normalizeDocumentVersion(value: any): ReviewDocumentVersion | null {
  if (
    typeof value?.id !== "string" ||
    typeof value?.filePath !== "string" ||
    typeof value?.createdAt !== "string" ||
    typeof value?.text !== "string" ||
    !VERSION_SOURCES.has(value?.source)
  ) {
    return null;
  }
  return {
    id: value.id,
    filePath: value.filePath,
    createdAt: value.createdAt,
    text: value.text,
    source: value.source,
    originId: typeof value.originId === "string" ? value.originId : undefined,
    restoredFromVersionId: typeof value.restoredFromVersionId === "string"
      ? value.restoredFromVersionId
      : undefined
  };
}
