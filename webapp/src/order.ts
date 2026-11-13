// Manual order of items and columns. Each has a float sort_order, and moving one gives it a
// value between its new neighbours, so a move is a single update.

// Below this gap, halving it again would lose precision, so the list is renumbered first.
export const MIN_GAP = 1e-9;

// orderBetween returns a sort order between prev and next, either of which may be missing
// (the start or end of the list). It returns null when the two are too close to split.
export function orderBetween(prev?: number, next?: number): number | null {
    if (prev !== undefined && next !== undefined) {
        if (next - prev < MIN_GAP) {
            return null;
        }
        return (prev + next) / 2;
    }
    if (prev !== undefined) {
        return prev + 1;
    }
    if (next !== undefined) {
        return next - 1;
    }
    return 0;
}

// neighbours returns the IDs on either side of id in an ordered list of IDs.
export function neighbours(ids: string[], id: string): {prevId?: string; nextId?: string} {
    const index = ids.indexOf(id);
    if (index < 0) {
        return {};
    }
    return {prevId: ids[index - 1], nextId: ids[index + 1]};
}

// moveId returns ids with the ID at from moved to index to.
export function moveId(ids: string[], from: number, to: number): string[] {
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
}

// renumber gives ordered IDs evenly spaced sort orders, 1, 2, 3…
export function renumber(ids: string[]): Record<string, number> {
    const orders: Record<string, number> = {};
    ids.forEach((id, i) => {
        orders[id] = i + 1;
    });
    return orders;
}
