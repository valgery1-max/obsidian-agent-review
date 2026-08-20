import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

export interface PendingHighlightRange {
  from: number;
  to: number;
  commentId?: string;
}

/** Подсветка фрагмента, к которому пишется комментарий. null — снять подсветку. */
export const setPendingHighlight = StateEffect.define<PendingHighlightRange | null>();

export function clampPendingRange(
  range: PendingHighlightRange | null,
  documentLength: number
): PendingHighlightRange | null {
  if (!range) return null;
  const from = Math.max(0, Math.min(range.from, documentLength));
  const to = Math.max(from, Math.min(range.to, documentLength));
  if (from === to) return null;
  return {
    from,
    to,
    ...(range.commentId ? { commentId: range.commentId } : {})
  };
}

function pendingDecorations(range: PendingHighlightRange): DecorationSet {
  const attributes = range.commentId ? { "data-codex-review-id": range.commentId } : undefined;
  return Decoration.set([Decoration.mark({
    class: "codex-review-pending-highlight is-active",
    attributes
  }).range(range.from, range.to)]);
}

export function createPendingHighlightField(): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (value, transaction) => {
      let next = value;
      let assigned = false;
      for (const effect of transaction.effects) {
        if (!effect.is(setPendingHighlight)) continue;
        const range = clampPendingRange(effect.value, transaction.state.doc.length);
        next = range ? pendingDecorations(range) : Decoration.none;
        assigned = true;
      }
      // Правка документа сдвигает подсветку вместе с текстом.
      if (!assigned && transaction.docChanged) next = value.map(transaction.changes);
      return next;
    },
    provide: (field) => EditorView.decorations.from(field)
  });
}
