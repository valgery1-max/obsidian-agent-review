import { diffWordsWithSpace } from "diff";
import { createAnchor, locateComment } from "./anchors";
import type { ReviewComment, ReviewInlineChange, TextAnchor } from "./types";

export interface ChangeHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

interface LocatedComment {
  comment: ReviewComment;
  from: number;
  to: number;
}

export interface RevertInlineChangesResult {
  text: string;
  revertedIds: string[];
  unresolvedIds: string[];
}

export interface InlineChangeParagraph {
  id: string;
  changeIds: string[];
  commentIds: string[];
  oldText: string;
  newText: string;
  from: number;
  to: number;
}

export interface ConversationInlineReview {
  comments: ReviewComment[];
  changes: ReviewInlineChange[];
}

export function commonSuffixLength(left: string, right: string): number {
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

export function commonPrefixLength(left: string, right: string): number {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) {
    count += 1;
  }
  return count;
}

export function collectChangeHunks(beforeText: string, afterText: string, mergeNearby = true): ChangeHunk[] {
  const hunks: ChangeHunk[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  let current: ChangeHunk | null = null;

  const finishCurrent = () => {
    if (!current) return;
    hunks.push(current);
    current = null;
  };

  for (const change of diffWordsWithSpace(beforeText, afterText)) {
    const length = change.value.length;
    if (!change.added && !change.removed) {
      finishCurrent();
      oldOffset += length;
      newOffset += length;
      continue;
    }

    if (!current) {
      current = { oldStart: oldOffset, oldEnd: oldOffset, newStart: newOffset, newEnd: newOffset };
    }
    if (change.removed) oldOffset += length;
    if (change.added) newOffset += length;
    current.oldEnd = oldOffset;
    current.newEnd = newOffset;
  }
  finishCurrent();
  return mergeNearby ? mergeNearbyHunks(hunks, beforeText, afterText) : hunks;
}

const EMPTY_LINE = /\r?\n[\t ]*\r?\n/u;
const MAX_BRIDGE_LENGTH = 24;

/**
 * Text left untouched between two edits keeps them apart. One empty line is the exception: it is a
 * paragraph break rather than untouched text, so it does not count towards the distance and edits
 * on both sides of it stay in one fragment. Two empty lines and more separate again.
 */
function separatesHunks(bridge: string): boolean {
  const lines = bridge.split(/\r?\n/u);
  const emptyLines = lines.slice(1, -1).filter((line) => !line.trim()).length;
  if (emptyLines > 1) return true;
  const untouched = emptyLines === 1 ? bridge.replace(EMPTY_LINE, "") : bridge;
  return untouched.length > MAX_BRIDGE_LENGTH;
}

function mergeNearbyHunks(hunks: ChangeHunk[], beforeText: string, afterText: string): ChangeHunk[] {
  const merged: ChangeHunk[] = [];
  for (const hunk of hunks) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...hunk });
      continue;
    }
    const oldBridge = beforeText.slice(previous.oldEnd, hunk.oldStart);
    const newBridge = afterText.slice(previous.newEnd, hunk.newStart);
    if (!separatesHunks(oldBridge) && !separatesHunks(newBridge)) {
      previous.oldEnd = hunk.oldEnd;
      previous.newEnd = hunk.newEnd;
    } else {
      merged.push({ ...hunk });
    }
  }
  return merged;
}

function distanceToHunk(hunk: ChangeHunk, location: LocatedComment): number {
  if (hunk.oldStart === hunk.oldEnd) {
    if (hunk.oldStart >= location.from && hunk.oldStart <= location.to) return 0;
    return hunk.oldStart < location.from
      ? location.from - hunk.oldStart
      : hunk.oldStart - location.to;
  }
  if (hunk.oldStart < location.to && hunk.oldEnd > location.from) return 0;
  return hunk.oldEnd <= location.from
    ? location.from - hunk.oldEnd
    : hunk.oldStart - location.to;
}

function ownerForHunk(
  hunk: ChangeHunk,
  selectionComments: LocatedComment[],
  documentComments: ReviewComment[],
  fallbackComments: ReviewComment[]
): ReviewComment | undefined {
  const ranked = selectionComments
    .map((item) => ({ item, distance: distanceToHunk(hunk, item) }))
    .sort((left, right) => left.distance - right.distance || left.item.from - right.item.from);
  if (ranked[0]?.distance === 0) return ranked[0].item.comment;
  if (documentComments.length > 0) return documentComments[0];
  return ranked[0]?.item.comment ?? fallbackComments[0];
}

export function commentOwnerResolver(
  beforeText: string,
  comments: ReviewComment[]
): (from: number, to: number) => ReviewComment | undefined {
  const selectionComments = comments.flatMap((comment): LocatedComment[] => {
    if (comment.kind !== "selection") return [];
    const location = locateComment(beforeText, comment);
    return location ? [{ comment, ...location }] : [];
  });
  const documentComments = comments.filter((comment) => comment.kind === "document");
  return (from, to) => ownerForHunk(
    { oldStart: from, oldEnd: to, newStart: from, newEnd: to },
    selectionComments,
    documentComments,
    comments
  );
}

export function createInlineChanges(
  filePath: string,
  turnId: string,
  beforeText: string,
  afterText: string,
  comments: ReviewComment[],
  idFactory: () => string,
  createdAt = new Date().toISOString()
): ReviewInlineChange[] {
  if (beforeText === afterText || comments.length === 0) return [];

  const resolveOwner = commentOwnerResolver(beforeText, comments);

  return collectChangeHunks(beforeText, afterText).flatMap((hunk): ReviewInlineChange[] => {
    const owner = resolveOwner(hunk.oldStart, hunk.oldEnd);
    if (!owner) return [];
    return [{
      id: idFactory(),
      filePath,
      commentId: owner.id,
      turnId,
      oldText: beforeText.slice(hunk.oldStart, hunk.oldEnd),
      newText: afterText.slice(hunk.newStart, hunk.newEnd),
      anchor: createAnchor(afterText, hunk.newStart, hunk.newEnd),
      fromOffset: hunk.newStart,
      toOffset: hunk.newEnd,
      createdAt
    }];
  });
}


function locatePoint(text: string, change: ReviewInlineChange): { from: number; to: number } {
  const fallback = Math.max(0, Math.min(change.fromOffset, text.length));
  const candidates = new Set<number>([fallback]);
  const prefixNeedle = change.anchor.prefix.slice(-24);
  const suffixNeedle = change.anchor.suffix.slice(0, 24);

  if (prefixNeedle) {
    let index = text.indexOf(prefixNeedle);
    while (index >= 0) {
      candidates.add(index + prefixNeedle.length);
      index = text.indexOf(prefixNeedle, index + 1);
    }
  }
  if (suffixNeedle) {
    let index = text.indexOf(suffixNeedle);
    while (index >= 0) {
      candidates.add(index);
      index = text.indexOf(suffixNeedle, index + 1);
    }
  }

  let best = fallback;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const prefix = text.slice(Math.max(0, candidate - change.anchor.prefix.length), candidate);
    const suffix = text.slice(candidate, candidate + change.anchor.suffix.length);
    const score = commonSuffixLength(prefix, change.anchor.prefix) * 3
      + commonPrefixLength(suffix, change.anchor.suffix) * 3
      - Math.abs(candidate - fallback) / 100;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return { from: best, to: best };
}

export function locateInlineChange(text: string, change: ReviewInlineChange): { from: number; to: number } | null {
  if (!change.newText) return locatePoint(text, change);
  if (text.slice(change.fromOffset, change.toOffset) === change.newText) {
    return { from: change.fromOffset, to: change.toOffset };
  }

  const candidates: number[] = [];
  let index = text.indexOf(change.newText);
  while (index >= 0) {
    candidates.push(index);
    index = text.indexOf(change.newText, index + Math.max(1, change.newText.length));
  }
  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const prefix = text.slice(Math.max(0, candidate - change.anchor.prefix.length), candidate);
    const suffix = text.slice(
      candidate + change.newText.length,
      candidate + change.newText.length + change.anchor.suffix.length
    );
    const score = commonSuffixLength(prefix, change.anchor.prefix) * 3
      + commonPrefixLength(suffix, change.anchor.suffix) * 3
      - Math.abs(candidate - change.fromOffset) / 100;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return { from: best, to: best + change.newText.length };
}

export function paragraphBounds(text: string, from: number, to: number): { from: number; to: number } {
  const safeFrom = Math.max(0, Math.min(from, text.length));
  const safeTo = Math.max(safeFrom, Math.min(to, text.length));
  const before = text.slice(0, safeFrom);
  const separator = /\n[\t ]*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(before)) !== null) {
    start = match.index + match[0].length;
  }

  const after = text.slice(safeTo);
  const nextSeparator = /\n[\t ]*\n/.exec(after);
  const end = nextSeparator ? safeTo + nextSeparator.index : text.length;
  return { from: start, to: end };
}

export function groupInlineChangesByParagraph(
  text: string,
  changes: ReviewInlineChange[]
): InlineChangeParagraph[] {
  const located = changes.flatMap((change) => {
    const location = locateInlineChange(text, change);
    if (!location) return [];
    return [{ change, location, paragraph: paragraphBounds(text, location.from, location.to) }];
  }).sort((left, right) =>
    left.paragraph.from - right.paragraph.from
    || left.paragraph.to - right.paragraph.to
    || left.location.from - right.location.from
  );

  const grouped: Array<{
    from: number;
    to: number;
    items: typeof located;
  }> = [];
  for (const item of located) {
    const previous = grouped.at(-1);
    const overlaps = previous
      && item.paragraph.from <= previous.to
      && item.paragraph.to >= previous.from;
    if (previous && overlaps) {
      previous.from = Math.min(previous.from, item.paragraph.from);
      previous.to = Math.max(previous.to, item.paragraph.to);
      previous.items.push(item);
    } else {
      grouped.push({ from: item.paragraph.from, to: item.paragraph.to, items: [item] });
    }
  }

  return grouped.map((group) => {
    const ordered = [...group.items].sort((left, right) =>
      right.location.from - left.location.from || right.location.to - left.location.to
    );
    let oldText = text.slice(group.from, group.to);
    for (const item of ordered) {
      const relativeFrom = item.location.from - group.from;
      const relativeTo = item.location.to - group.from;
      oldText = oldText.slice(0, relativeFrom) + item.change.oldText + oldText.slice(relativeTo);
    }
    const changeIds = group.items.map((item) => item.change.id).sort();
    const commentIds = [...new Set(group.items.map((item) => item.change.commentId))];
    return {
      id: changeIds.join(":"),
      changeIds,
      commentIds,
      oldText,
      newText: text.slice(group.from, group.to),
      from: group.from,
      to: group.to
    };
  });
}

export function firstOldParagraphForComment(
  text: string,
  changes: ReviewInlineChange[],
  commentId: string
): InlineChangeParagraph | undefined {
  return groupInlineChangesByParagraph(
    text,
    changes.filter((change) => change.commentId === commentId)
  ).find((paragraph) => paragraph.oldText.length > 0);
}

export function refreshInlineChangeLocations(
  text: string,
  changes: ReviewInlineChange[]
): ReviewInlineChange[] {
  return changes.map((change) => {
    const location = locateInlineChange(text, change);
    if (!location) return change;
    return {
      ...change,
      fromOffset: location.from,
      toOffset: location.to,
      anchor: createAnchor(text, location.from, location.to)
    };
  });
}

export function revertInlineChanges(
  text: string,
  changes: ReviewInlineChange[]
): RevertInlineChangesResult {
  const located = changes.map((change) => ({ change, location: locateInlineChange(text, change) }));
  const unresolvedIds = located.filter((item) => item.location === null).map((item) => item.change.id);
  const resolvable = located
    .filter((item): item is { change: ReviewInlineChange; location: { from: number; to: number } } => item.location !== null)
    .sort((left, right) => right.location.from - left.location.from || right.location.to - left.location.to);

  let restored = text;
  const revertedIds: string[] = [];
  let lastFrom = Number.POSITIVE_INFINITY;
  for (const item of resolvable) {
    if (item.location.to > lastFrom) {
      unresolvedIds.push(item.change.id);
      continue;
    }
    restored = restored.slice(0, item.location.from) + item.change.oldText + restored.slice(item.location.to);
    revertedIds.push(item.change.id);
    lastFrom = item.location.from;
  }

  return { text: restored, revertedIds, unresolvedIds };
}

export function normalizeInlineChange(value: any): ReviewInlineChange | null {
  if (
    typeof value?.id !== "string" ||
    typeof value?.filePath !== "string" ||
    typeof value?.commentId !== "string" ||
    typeof value?.oldText !== "string" ||
    typeof value?.newText !== "string"
  ) {
    return null;
  }
  const anchor: TextAnchor = value.anchor && typeof value.anchor === "object"
    ? {
        prefix: typeof value.anchor.prefix === "string" ? value.anchor.prefix : "",
        quote: typeof value.anchor.quote === "string" ? value.anchor.quote : value.newText,
        suffix: typeof value.anchor.suffix === "string" ? value.anchor.suffix : ""
      }
    : { prefix: "", quote: value.newText, suffix: "" };
  return {
    id: value.id,
    filePath: value.filePath,
    commentId: value.commentId,
    turnId: typeof value.turnId === "string" ? value.turnId : "",
    oldText: value.oldText,
    newText: value.newText,
    anchor,
    fromOffset: typeof value.fromOffset === "number" ? value.fromOffset : 0,
    toOffset: typeof value.toOffset === "number" ? value.toOffset : value.newText.length,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString()
  };
}
