import assert from "node:assert/strict";
import test from "node:test";
import { reviewScrollbarMetrics } from "../src/review-scrollbar";

test("review scrollbar maps editor progress onto the thumb travel", () => {
  const metrics = reviewScrollbarMetrics(450, 1200, 300, 300);

  assert.equal(metrics.scrollRange, 900);
  assert.equal(metrics.thumbHeight, 75);
  assert.equal(metrics.thumbTravel, 225);
  assert.equal(metrics.thumbOffset, 112.5);
});

test("review scrollbar clamps values and fills a non-scrollable track", () => {
  const metrics = reviewScrollbarMetrics(80, 200, 300, 240);

  assert.equal(metrics.scrollRange, 0);
  assert.equal(metrics.thumbHeight, 240);
  assert.equal(metrics.thumbOffset, 0);
});

test("review scrollbar keeps a usable minimum thumb", () => {
  const metrics = reviewScrollbarMetrics(1000, 10000, 200, 200);

  assert.equal(metrics.thumbHeight, 28);
  assert.ok(metrics.thumbOffset > 0);
  assert.ok(metrics.thumbOffset < metrics.thumbTravel);
});
