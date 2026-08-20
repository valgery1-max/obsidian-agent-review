import assert from "node:assert/strict";
import test from "node:test";
import {
  isReviewMarginCardVisible,
  placeReviewMarginCards,
  reviewMarginCardSize
} from "../src/review-margin-layout";

test("shows an active comment at its full content height", () => {
  assert.deepEqual(reviewMarginCardSize(940, 600, true), {
    height: 940,
    maxHeight: null
  });
});

test("keeps an inactive comment within the viewport", () => {
  assert.deepEqual(reviewMarginCardSize(940, 600, false), {
    height: 584,
    maxHeight: 584
  });
});

test("margin card positions stay in document coordinates", () => {
  const placed = placeReviewMarginCards([
    { id: "first", anchorTop: 120, height: 80 },
    { id: "second", anchorTop: 150, height: 60 },
    { id: "third", anchorTop: 420, height: 70 }
  ]);

  assert.deepEqual(placed.map(({ id, documentTop }) => ({ id, documentTop })), [
    { id: "first", documentTop: 120 },
    { id: "second", documentTop: 212 },
    { id: "third", documentTop: 420 }
  ]);
});

test("margin card visibility depends only on the current scroll position", () => {
  assert.equal(isReviewMarginCardVisible(500, 120, 0, 300), false);
  assert.equal(isReviewMarginCardVisible(500, 120, 250, 300), true);
  assert.equal(isReviewMarginCardVisible(500, 120, 620, 300), true);
  assert.equal(isReviewMarginCardVisible(500, 120, 701, 300), false);
  assert.equal(isReviewMarginCardVisible(500, 120, 250, 300), true);
});

test("an active card aligns with its text while neighboring cards keep their order", () => {
  const placed = placeReviewMarginCards([
    { id: "first", anchorTop: 120, height: 80 },
    { id: "active", anchorTop: 260, height: 90 },
    { id: "third", anchorTop: 280, height: 70 }
  ], 12, "active");

  assert.equal(placed[1].documentTop, 260);
  assert.equal(placed[0].documentTop + placed[0].height + 12 <= placed[1].documentTop, true);
  assert.equal(placed[1].documentTop + placed[1].height + 12 <= placed[2].documentTop, true);
});

test("cards before an active comment move upward to leave its anchor aligned", () => {
  const placed = placeReviewMarginCards([
    { id: "first", anchorTop: 180, height: 80 },
    { id: "second", anchorTop: 230, height: 80 },
    { id: "active", anchorTop: 300, height: 120 }
  ], 12, "active");

  assert.deepEqual(placed.map(({ id, documentTop }) => ({ id, documentTop })), [
    { id: "first", documentTop: 116 },
    { id: "second", documentTop: 208 },
    { id: "active", documentTop: 300 }
  ]);
});

test("the active card keeps its anchor when earlier cards continue above the document viewport", () => {
  const placed = placeReviewMarginCards([
    { id: "first", anchorTop: 10, height: 80 },
    { id: "second", anchorTop: 25, height: 80 },
    { id: "active", anchorTop: 40, height: 120 }
  ], 12, "active");

  assert.equal(placed[2].documentTop, 40);
  assert.equal(placed[0].documentTop < 0, true);
  assert.equal(placed[0].documentTop + placed[0].height + 12, placed[1].documentTop);
  assert.equal(placed[1].documentTop + placed[1].height + 12, placed[2].documentTop);
});

test("nearby comments remain in document order without negative positions", () => {
  const placed = placeReviewMarginCards([
    { id: "first", anchorTop: 0, height: 90 },
    { id: "second", anchorTop: 40, height: 90 },
    { id: "active", anchorTop: 80, height: 80 },
    { id: "last", anchorTop: 90, height: 60 }
  ], 12);

  assert.equal(placed[0].documentTop, 0);
  assert.equal(placed[0].documentTop < placed[1].documentTop, true);
  assert.equal(placed[1].documentTop < placed[2].documentTop, true);
  assert.equal(placed.every((item, index) => {
    const next = placed[index + 1];
    return !next || item.documentTop + item.height + 12 <= next.documentTop;
  }), true);
});
