import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

export interface ReviewDecorationSync {
  path: string | null;
  revision: number;
}

export interface ReviewDecorationState {
  path: string | null;
  revision: number;
  decorations: DecorationSet;
}

export const syncReviewDecorations = StateEffect.define<ReviewDecorationSync>();

export function createReviewDecorationField(
  build: (path: string, text: string) => DecorationSet
): StateField<ReviewDecorationState> {
  return StateField.define<ReviewDecorationState>({
    create: () => ({ path: null, revision: -1, decorations: Decoration.none }),
    update: (value, transaction) => {
      let sync: ReviewDecorationSync | null = null;
      for (const effect of transaction.effects) {
        if (effect.is(syncReviewDecorations)) sync = effect.value;
      }

      const path = sync ? sync.path : value.path;
      const revision = sync ? sync.revision : value.revision;
      if (!path) {
        if (value.path === null && value.revision === revision && value.decorations === Decoration.none) {
          return value;
        }
        return { path: null, revision, decorations: Decoration.none };
      }
      if (!transaction.docChanged && !sync) return value;
      if (transaction.docChanged && !sync) {
        return {
          path,
          revision,
          decorations: value.decorations.map(transaction.changes)
        };
      }
      return {
        path,
        revision,
        decorations: build(path, transaction.state.doc.toString())
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
  });
}
