import { diffChars } from "diff";
import { createAnchor, mapOffset } from "./anchors";
import type { CharacterChanges } from "./anchors";
import {
  collectChangeHunks,
  commentOwnerResolver,
  commonPrefixLength,
  commonSuffixLength,
  paragraphBounds
} from "./inline-changes";
import type { ConversationInlineReview } from "./inline-changes";
import type { ReviewComment, ReviewInlineChange, TextAnchor } from "./types";

/**
 * The agent edits a working copy of the document while the user keeps editing the document
 * itself. `mergeAgentEdits` compares the snapshot handed to the agent with the working copy it
 * returned, and transfers every single edit to the current document, skipping the ones the user
 * has changed or removed in the meantime.
 */

const MIN_CONTEXT_MATCH = 8;
const MIN_UNIQUE_MARGIN = 8;
const MIN_MOVED_FRAGMENT = 24;

export type AgentEditOutcome = "applied" | "conflict" | "stale";

export interface AgentEdit {
  oldText: string;
  newText: string;
  baseFrom: number;
  baseTo: number;
  anchor: TextAnchor;
  outcome: AgentEditOutcome;
  from: number;
  to: number;
  resultFrom: number;
  resultTo: number;
}

export interface AppliedAgentEdit extends AgentEdit {
  outcome: "applied";
}

export interface DocumentChange {
  from: number;
  to: number;
  insert: string;
}

export interface AgentMergeResult {
  text: string;
  edits: AgentEdit[];
  applied: AppliedAgentEdit[];
  skipped: AgentEdit[];
  changes: DocumentChange[];
}

interface UserEdit {
  from: number;
  to: number;
  insert: string;
}

type FragmentSearch =
  | { kind: "found"; from: number; to: number }
  | { kind: "ambiguous" }
  | { kind: "missing" };

function userEditRanges(changes: CharacterChanges): UserEdit[] {
  const edits: UserEdit[] = [];
  let offset = 0;
  for (const change of changes) {
    const length = change.value.length;
    if (change.added) {
      edits.push({ from: offset, to: offset, insert: change.value });
      continue;
    }
    if (change.removed) edits.push({ from: offset, to: offset + length, insert: "" });
    offset += length;
  }
  return edits;
}

/**
 * True when the user edit and the agent edit meet in the same words. Edits that only touch each
 * other across whitespace are independent and both survive.
 */
function touchesEdit(edit: UserEdit, baseText: string, from: number, to: number): boolean {
  if (edit.from === edit.to) {
    if (edit.from > from && edit.from < to) return true;
    if (edit.from === from) return /\S$/u.test(edit.insert);
    if (edit.from === to) return /^\S/u.test(edit.insert);
    return false;
  }
  if (edit.from < to && edit.to > from) return true;
  const removed = baseText.slice(edit.from, edit.to);
  if (edit.to === from) return /\S$/u.test(removed);
  if (edit.from === to) return /^\S/u.test(removed);
  return false;
}

function removesEdit(edit: UserEdit, from: number, to: number): boolean {
  return edit.insert === "" && edit.to > edit.from && edit.from <= from && edit.to >= to;
}

function contextScore(text: string, from: number, to: number, anchor: TextAnchor): number {
  const prefix = text.slice(Math.max(0, from - anchor.prefix.length), from);
  const suffix = text.slice(to, to + anchor.suffix.length);
  return commonSuffixLength(prefix, anchor.prefix) + commonPrefixLength(suffix, anchor.suffix);
}

function neighbourhoodPresent(text: string, anchor: TextAnchor): boolean {
  const needles = [
    anchor.prefix.slice(-MIN_CONTEXT_MATCH * 2),
    anchor.suffix.slice(0, MIN_CONTEXT_MATCH * 2)
  ];
  return needles.some((needle) => needle.trim().length >= MIN_CONTEXT_MATCH && text.includes(needle));
}

function occurrences(text: string, fragment: string): number[] {
  if (!fragment) return [];
  const found: number[] = [];
  let index = text.indexOf(fragment);
  while (index >= 0) {
    found.push(index);
    index = text.indexOf(fragment, index + Math.max(1, fragment.length));
  }
  return found;
}

/**
 * Looks for the fragment the agent rewrote in a document whose offsets no longer line up. The
 * surrounding context decides between several occurrences; a fragment without any context left
 * is accepted only when it is long enough and unique in both documents, so that a short
 * coincidental match elsewhere never wins.
 */
function searchFragment(
  baseText: string,
  text: string,
  fragment: string,
  anchor: TextAnchor,
  hint: number
): FragmentSearch {
  if (!fragment) return { kind: "missing" };
  const candidates = occurrences(text, fragment);
  if (candidates.length === 0) return { kind: "missing" };

  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: contextScore(text, candidate, candidate + fragment.length, anchor)
    }))
    .sort((left, right) =>
      right.score - left.score
      || Math.abs(left.candidate - hint) - Math.abs(right.candidate - hint));

  const best = scored[0];
  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < MIN_UNIQUE_MARGIN) return { kind: "ambiguous" };
  if (best.score >= MIN_CONTEXT_MATCH) {
    return { kind: "found", from: best.candidate, to: best.candidate + fragment.length };
  }
  const moved = fragment.trim().length >= MIN_MOVED_FRAGMENT
    && candidates.length === 1
    && occurrences(baseText, fragment).length === 1;
  return moved
    ? { kind: "found", from: candidates[0], to: candidates[0] + fragment.length }
    : { kind: "missing" };
}

function locateEdit(
  baseText: string,
  currentText: string,
  userChanges: CharacterChanges | null,
  userEdits: UserEdit[],
  baseFrom: number,
  baseTo: number,
  oldText: string,
  anchor: TextAnchor
): { outcome: AgentEditOutcome; from: number; to: number } {
  const skipped = (outcome: AgentEditOutcome) => ({ outcome, from: -1, to: -1 });
  if (!userChanges) return { outcome: "applied", from: baseFrom, to: baseTo };

  const from = mapOffset(userChanges, baseFrom, "start");
  const to = baseTo === baseFrom ? from : mapOffset(userChanges, baseTo, "end");
  const relocate = (): { outcome: AgentEditOutcome; from: number; to: number } => {
    const search = searchFragment(baseText, currentText, oldText, anchor, from);
    if (search.kind === "found") return { outcome: "applied", from: search.from, to: search.to };
    if (search.kind === "ambiguous") return skipped("conflict");
    return skipped(neighbourhoodPresent(currentText, anchor) ? "conflict" : "stale");
  };

  const touching = userEdits.filter((edit) => touchesEdit(edit, baseText, baseFrom, baseTo));
  if (touching.length > 0) {
    // The fragment may have been moved rather than rewritten, but a fragment that was not unique
    // to begin with cannot be recognised among its own copies.
    const removed = touching.some((edit) => removesEdit(edit, baseFrom, baseTo));
    if (!removed) return skipped("conflict");
    if (occurrences(baseText, oldText).length !== 1) return skipped("stale");
    const relocated = relocate();
    return relocated.outcome === "applied" ? relocated : skipped("stale");
  }

  if (to >= from && currentText.slice(from, to) === oldText) return { outcome: "applied", from, to };
  return relocate();
}

export function mergeAgentEdits(
  baseText: string,
  agentText: string,
  currentText: string
): AgentMergeResult {
  if (baseText === agentText) {
    return { text: currentText, edits: [], applied: [], skipped: [], changes: [] };
  }

  const userChanges = baseText === currentText ? null : diffChars(baseText, currentText);
  const userEdits = userChanges ? userEditRanges(userChanges) : [];

  const edits: AgentEdit[] = collectChangeHunks(baseText, agentText).map((hunk) => {
    const oldText = baseText.slice(hunk.oldStart, hunk.oldEnd);
    const anchor = createAnchor(baseText, hunk.oldStart, hunk.oldEnd);
    return {
      oldText,
      newText: agentText.slice(hunk.newStart, hunk.newEnd),
      baseFrom: hunk.oldStart,
      baseTo: hunk.oldEnd,
      anchor,
      resultFrom: -1,
      resultTo: -1,
      ...locateEdit(
        baseText,
        currentText,
        userChanges,
        userEdits,
        hunk.oldStart,
        hunk.oldEnd,
        oldText,
        anchor
      )
    };
  });

  let lastTo = -1;
  for (const edit of [...edits]
    .filter((edit) => edit.outcome === "applied")
    .sort((left, right) => left.from - right.from || left.to - right.to)) {
    if (edit.from < lastTo) {
      edit.outcome = "conflict";
      edit.from = -1;
      edit.to = -1;
      continue;
    }
    lastTo = edit.to;
  }

  const applied = edits
    .filter((edit): edit is AppliedAgentEdit => edit.outcome === "applied")
    .sort((left, right) => left.from - right.from);

  let text = currentText;
  for (let index = applied.length - 1; index >= 0; index -= 1) {
    const edit = applied[index];
    text = text.slice(0, edit.from) + edit.newText + text.slice(edit.to);
  }

  let delta = 0;
  for (const edit of applied) {
    edit.resultFrom = edit.from + delta;
    edit.resultTo = edit.resultFrom + edit.newText.length;
    delta += edit.newText.length - (edit.to - edit.from);
  }

  return {
    text,
    edits,
    applied,
    skipped: edits.filter((edit) => edit.outcome !== "applied"),
    changes: applied.map((edit) => ({ from: edit.from, to: edit.to, insert: edit.newText }))
  };
}

export function createInlineChangesFromEdits(
  filePath: string,
  turnId: string,
  baseText: string,
  resultText: string,
  edits: AppliedAgentEdit[],
  comments: ReviewComment[],
  idFactory: () => string,
  createdAt = new Date().toISOString()
): ReviewInlineChange[] {
  if (edits.length === 0 || comments.length === 0) return [];
  const resolveOwner = commentOwnerResolver(baseText, comments);
  return edits.flatMap((edit): ReviewInlineChange[] => {
    const owner = resolveOwner(edit.baseFrom, edit.baseTo);
    if (!owner) return [];
    return [{
      id: idFactory(),
      filePath,
      commentId: owner.id,
      turnId,
      oldText: edit.oldText,
      newText: edit.newText,
      anchor: createAnchor(resultText, edit.resultFrom, edit.resultTo),
      fromOffset: edit.resultFrom,
      toOffset: edit.resultTo,
      createdAt
    }];
  });
}

export function createConversationReviewFromEdits(
  filePath: string,
  turnId: string,
  resultText: string,
  edits: AppliedAgentEdit[],
  requestText: string,
  responseText: string,
  idFactory: () => string,
  createdAt = new Date().toISOString()
): ConversationInlineReview {
  const comments: ReviewComment[] = [];
  const changes: ReviewInlineChange[] = [];
  const groups: Array<{ from: number; to: number; edits: AppliedAgentEdit[] }> = [];

  const located = edits
    .map((edit) => ({ edit, paragraph: paragraphBounds(resultText, edit.resultFrom, edit.resultTo) }))
    .sort((left, right) =>
      left.paragraph.from - right.paragraph.from
      || left.edit.resultFrom - right.edit.resultFrom);

  for (const item of located) {
    const previous = groups.at(-1);
    if (previous && item.paragraph.from <= previous.to && item.paragraph.to >= previous.from) {
      previous.from = Math.min(previous.from, item.paragraph.from);
      previous.to = Math.max(previous.to, item.paragraph.to);
      previous.edits.push(item.edit);
      continue;
    }
    groups.push({ from: item.paragraph.from, to: item.paragraph.to, edits: [item.edit] });
  }

  for (const group of groups) {
    const commentId = idFactory();
    comments.push({
      id: commentId,
      filePath,
      kind: "selection",
      quote: resultText.slice(group.from, group.to),
      anchor: createAnchor(resultText, group.from, group.to),
      fromOffset: group.from,
      toOffset: group.to,
      feedback: requestText.trim() || "Изменить документ по запросу из чата",
      createdAt,
      status: "addressed",
      agentResponse: responseText.trim() || "Агент внес изменения по запросу из чата.",
      respondedAt: createdAt,
      followUps: []
    });
    for (const edit of group.edits) {
      changes.push({
        id: idFactory(),
        filePath,
        commentId,
        turnId,
        oldText: edit.oldText,
        newText: edit.newText,
        anchor: createAnchor(resultText, edit.resultFrom, edit.resultTo),
        fromOffset: edit.resultFrom,
        toOffset: edit.resultTo,
        createdAt
      });
    }
  }

  return { comments, changes };
}
