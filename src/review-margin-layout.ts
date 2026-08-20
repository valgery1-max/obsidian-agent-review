export interface ReviewMarginAnchor {
  id: string;
  anchorTop: number;
  height: number;
}

export function reviewMarginCardSize(
  contentHeight: number,
  viewportHeight: number,
  expanded: boolean
): { height: number; maxHeight: number | null } {
  const maxHeight = Math.max(120, viewportHeight - 16);
  return expanded
    ? { height: contentHeight, maxHeight: null }
    : { height: Math.min(contentHeight, maxHeight), maxHeight };
}

export function placeReviewMarginCards<T extends ReviewMarginAnchor>(
  items: readonly T[],
  gap = 12,
  activeId: string | null = null
): Array<T & { documentTop: number }> {
  const activeIndex = activeId ? items.findIndex((item) => item.id === activeId) : -1;
  if (activeIndex >= 0) return placeAroundActive(items, activeIndex, gap);

  let nextTop = 0;
  return items.map((item) => {
    const documentTop = Math.max(item.anchorTop, nextTop);
    nextTop = documentTop + item.height + gap;
    return { ...item, documentTop };
  });
}

function placeAroundActive<T extends ReviewMarginAnchor>(
  items: readonly T[],
  activeIndex: number,
  gap: number
): Array<T & { documentTop: number }> {
  const placed = items.map((item) => ({ ...item, documentTop: item.anchorTop }));
  placed[activeIndex].documentTop = Math.max(0, placed[activeIndex].anchorTop);

  let nextTop = placed[activeIndex].documentTop;
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const item = placed[index];
    item.documentTop = Math.min(item.anchorTop, nextTop - item.height - gap);
    nextTop = item.documentTop;
  }

  nextTop = placed[activeIndex].documentTop + placed[activeIndex].height + gap;
  for (let index = activeIndex + 1; index < placed.length; index += 1) {
    const item = placed[index];
    item.documentTop = Math.max(item.anchorTop, nextTop);
    nextTop = item.documentTop + item.height + gap;
  }
  return placed;
}

export function isReviewMarginCardVisible(
  documentTop: number,
  height: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 80
): boolean {
  const viewportTop = documentTop - scrollTop;
  return viewportTop > -height - overscan && viewportTop < viewportHeight + overscan;
}
