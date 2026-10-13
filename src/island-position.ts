export const ISLAND_ANCHORS = [
  'top-left', 'top-center', 'top-right', 'right-center',
  'bottom-right', 'bottom-center', 'bottom-left', 'left-center',
] as const;

export type IslandAnchor = typeof ISLAND_ANCHORS[number];
export type Rectangle = { x: number; y: number; width: number; height: number };
export const DEFAULT_ISLAND_ANCHOR: IslandAnchor = 'bottom-center';

export function isIslandAnchor(value: unknown): value is IslandAnchor {
  return typeof value === 'string' && ISLAND_ANCHORS.some(anchor => anchor === value);
}

/** Use work-area coordinates so the island stays clear of the menu bar and Dock. */
export function positionForAnchor(
  area: Rectangle,
  size: { width: number; height: number },
  anchor: IslandAnchor,
  padding = 12,
): { x: number; y: number } {
  const horizontalRoom = Math.max(0, area.width - size.width);
  const verticalRoom = Math.max(0, area.height - size.height);
  const inset = Math.max(0, padding);
  const horizontalInset = Math.min(inset, horizontalRoom / 2);
  const verticalInset = Math.min(inset, verticalRoom / 2);
  const left = area.x + horizontalInset;
  const right = area.x + horizontalRoom - horizontalInset;
  const top = area.y + verticalInset;
  const bottom = area.y + verticalRoom - verticalInset;
  const centerX = area.x + horizontalRoom / 2;
  const centerY = area.y + verticalRoom / 2;
  const positions: Record<IslandAnchor, { x: number; y: number }> = {
    'top-left': { x: left, y: top },
    'top-center': { x: centerX, y: top },
    'top-right': { x: right, y: top },
    'right-center': { x: right, y: centerY },
    'bottom-right': { x: right, y: bottom },
    'bottom-center': { x: centerX, y: bottom },
    'bottom-left': { x: left, y: bottom },
    'left-center': { x: left, y: centerY },
  };
  const position = positions[anchor];
  return { x: Math.round(position.x), y: Math.round(position.y) };
}

export function nearestIslandAnchor(
  area: Rectangle,
  size: { width: number; height: number },
  position: { x: number; y: number },
  padding = 12,
): IslandAnchor {
  // Equal distances prefer the usual bottom-center position, then clockwise
  // from top-left. This is stable even when a small display collapses anchors.
  const candidates = [DEFAULT_ISLAND_ANCHOR, ...ISLAND_ANCHORS.filter(anchor => anchor !== DEFAULT_ISLAND_ANCHOR)];
  let nearest: IslandAnchor = DEFAULT_ISLAND_ANCHOR;
  let nearestDistance = Infinity;
  for (const anchor of candidates) {
    const target = positionForAnchor(area, size, anchor, padding);
    const distance = (target.x - position.x) ** 2 + (target.y - position.y) ** 2;
    if (distance < nearestDistance) {
      nearest = anchor;
      nearestDistance = distance;
    }
  }
  return nearest;
}
