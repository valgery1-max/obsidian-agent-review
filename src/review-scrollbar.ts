export interface ReviewScrollbarMetrics {
  scrollRange: number;
  thumbHeight: number;
  thumbOffset: number;
  thumbTravel: number;
}

export function reviewScrollbarMetrics(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number,
  minThumbHeight = 28
): ReviewScrollbarMetrics {
  const safeClientHeight = Math.max(0, clientHeight);
  const safeScrollHeight = Math.max(safeClientHeight, scrollHeight);
  const safeTrackHeight = Math.max(0, trackHeight);
  const scrollRange = Math.max(0, safeScrollHeight - safeClientHeight);
  const proportionalHeight = safeScrollHeight > 0
    ? safeTrackHeight * (safeClientHeight / safeScrollHeight)
    : safeTrackHeight;
  const thumbHeight = Math.min(
    safeTrackHeight,
    Math.max(Math.min(minThumbHeight, safeTrackHeight), proportionalHeight)
  );
  const thumbTravel = Math.max(0, safeTrackHeight - thumbHeight);
  const clampedScrollTop = Math.min(scrollRange, Math.max(0, scrollTop));
  const thumbOffset = scrollRange > 0
    ? thumbTravel * (clampedScrollTop / scrollRange)
    : 0;

  return { scrollRange, thumbHeight, thumbOffset, thumbTravel };
}
