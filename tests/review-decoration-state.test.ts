import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { createReviewDecorationField, syncReviewDecorations } from "../src/review-decoration-state";

class BlockWidget extends WidgetType {
  toDOM(): HTMLElement {
    return {} as HTMLElement;
  }
}

function blockDecorations(): DecorationSet {
  return Decoration.set([
    Decoration.widget({ widget: new BlockWidget(), block: true, side: -1 }).range(0)
  ]);
}

test("provides block review widgets as direct state decorations", () => {
  const field = createReviewDecorationField(() => blockDecorations());
  const initial = EditorState.create({ doc: "Абзац", extensions: [field] });
  const state = initial.update({
    effects: syncReviewDecorations.of({ path: "note.md", revision: 1 })
  }).state;

  const sources = state.facet(EditorView.decorations);
  assert.equal(sources.length, 1);
  assert.notEqual(typeof sources[0], "function");
  assert.equal(state.field(field).path, "note.md");
});

test("maps direct decorations without rebuilding them while the Markdown document changes", () => {
  const seen: string[] = [];
  const field = createReviewDecorationField((_path, text) => {
    seen.push(text);
    return Decoration.set([Decoration.mark({ class: "review" }).range(0, text.length)]);
  });
  const initial = EditorState.create({ doc: "До", extensions: [field] });
  const synced = initial.update({
    effects: syncReviewDecorations.of({ path: "note.md", revision: 1 })
  }).state;
  const changed = synced.update({ changes: { from: 0, to: 2, insert: "После" } }).state;

  assert.deepEqual(seen, ["До"]);
  assert.equal(changed.field(field).decorations.size, 1);
  const ranges: Array<{ from: number; to: number }> = [];
  changed.field(field).decorations.between(0, changed.doc.length, (from, to) => {
    ranges.push({ from, to });
  });
  assert.deepEqual(ranges, [{ from: 0, to: 5 }]);
});

test("rebuilds direct decorations when an explicit review sync accompanies a document change", () => {
  const seen: string[] = [];
  const field = createReviewDecorationField((_path, text) => {
    seen.push(text);
    return Decoration.none;
  });
  const initial = EditorState.create({ doc: "До", extensions: [field] });
  const synced = initial.update({
    effects: syncReviewDecorations.of({ path: "note.md", revision: 1 })
  }).state;
  synced.update({
    changes: { from: 0, to: 2, insert: "После" },
    effects: syncReviewDecorations.of({ path: "note.md", revision: 2 })
  }).state;

  assert.deepEqual(seen, ["До", "После"]);
});
