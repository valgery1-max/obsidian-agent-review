import assert from "node:assert/strict";
import test from "node:test";
import { clampPendingRange } from "../src/pending-highlight";

test("возвращает диапазон без изменений, когда он внутри документа", () => {
  assert.deepEqual(clampPendingRange({ from: 10, to: 25 }, 100), { from: 10, to: 25 });
});

test("снимает подсветку, когда диапазона нет", () => {
  assert.equal(clampPendingRange(null, 100), null);
});

test("обрезает диапазон по длине документа", () => {
  assert.deepEqual(clampPendingRange({ from: 90, to: 140 }, 100), { from: 90, to: 100 });
});

test("подтягивает отрицательное начало к нулю", () => {
  assert.deepEqual(clampPendingRange({ from: -5, to: 12 }, 100), { from: 0, to: 12 });
});

test("не подсвечивает пустой диапазон", () => {
  assert.equal(clampPendingRange({ from: 30, to: 30 }, 100), null);
});

test("не подсвечивает диапазон, целиком выпавший за конец документа", () => {
  assert.equal(clampPendingRange({ from: 150, to: 200 }, 100), null);
});

test("выправляет перевёрнутый диапазон вместо отрицательной длины", () => {
  assert.equal(clampPendingRange({ from: 40, to: 20 }, 100), null);
});
