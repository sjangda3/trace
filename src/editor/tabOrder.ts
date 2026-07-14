export type PathItem = {
  path: string;
};

/**
 * Moves one path-addressed item to another item's index without cloning items.
 * Invalid or ambiguous requests are no-ops and preserve the input array identity.
 */
export function reorderByPath<T extends PathItem>(
  items: T[],
  draggedPath: string,
  targetPath: string,
): T[] {
  if (draggedPath === targetPath) return items;

  const seenPaths = new Set<string>();
  let draggedIndex = -1;
  let targetIndex = -1;

  for (let index = 0; index < items.length; index += 1) {
    const path = items[index].path;
    if (seenPaths.has(path)) return items;
    seenPaths.add(path);
    if (path === draggedPath) draggedIndex = index;
    if (path === targetPath) targetIndex = index;
  }

  if (draggedIndex === -1 || targetIndex === -1) return items;

  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, dragged);
  return next;
}
