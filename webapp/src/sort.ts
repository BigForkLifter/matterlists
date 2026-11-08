import type {CellValue, Column, Item} from './types';
import {cellValue} from './utils';

// A sort is "manual" (the list's own order, which people rearrange with Move up/down),
// a built-in field, or a column ID.
export type SortKey = 'manual' | 'title' | 'created' | 'updated' | string;
export type SortDir = 'asc' | 'desc';
export type Sort = {key: SortKey; dir: SortDir};

export const MANUAL_SORT: Sort = {key: 'manual', dir: 'asc'};

export function parseSort(raw: string): Sort {
    const [key, dir] = raw.split(':');
    return key ? {key, dir: dir === 'desc' ? 'desc' : 'asc'} : MANUAL_SORT;
}

export function formatSort(sort: Sort): string {
    return `${sort.key}:${sort.dir}`;
}

// sortKeyOf maps a value to something comparable, or null when there's nothing to sort by.
type Comparable = string | number;

function columnKey(column: Column, value: CellValue | undefined, nameOf: (userId: string) => string): Comparable | null {
    if (value === undefined) {
        return null;
    }
    const choiceIndex = (id: string) => {
        const i = (column.options.choices || []).findIndex((c) => c.id === id);
        return i < 0 ? null : i;
    };
    switch (column.type) {
    case 'number':
        return value as number;
    case 'checkbox':
        // Checked items first when ascending.
        return value === true ? 0 : null;
    case 'select':
        return choiceIndex(value as string);
    case 'multi_select': {
        const indexes = (value as string[]).map(choiceIndex).filter((i): i is number => i !== null);
        return indexes.length ? Math.min(...indexes) : null;
    }
    case 'person':
    case 'created_by': {
        const names = (value as string[]).map(nameOf).sort(compareText);
        return names.length ? names[0] : null;
    }
    default:
        // text, url, and date (YYYY-MM-DD sorts correctly as text)
        return String(value);
    }
}

const collator = typeof Intl === 'undefined' ? null : new Intl.Collator(undefined, {sensitivity: 'base', numeric: true});

function compareText(a: string, b: string): number {
    return collator ? collator.compare(a, b) : a.localeCompare(b);
}

function compare(a: Comparable, b: Comparable): number {
    if (typeof a === 'number' && typeof b === 'number') {
        return a - b;
    }
    return compareText(String(a), String(b));
}

// sortItems orders items for display. Items with no value for the sort go last in both
// directions, and ties keep the manual order.
export function sortItems(items: Item[], sort: Sort, columns: Column[], nameOf: (userId: string) => string): Item[] {
    if (sort.key === 'manual') {
        return sort.dir === 'desc' ? [...items].reverse() : items;
    }

    const column = columns.find((c) => c.id === sort.key);
    const keyOf = (it: Item): Comparable | null => {
        switch (sort.key) {
        case 'title':
            return it.title;
        case 'created':
            return it.create_at;
        case 'updated':
            return it.update_at;
        default:
            return column ? columnKey(column, cellValue(column, it), nameOf) : null;
        }
    };

    const sign = sort.dir === 'desc' ? -1 : 1;
    return items.
        map((item, index) => ({item, index, key: keyOf(item)})).
        sort((a, b) => {
            if (a.key === null || b.key === null) {
                if (a.key === b.key) {
                    return a.index - b.index;
                }
                return a.key === null ? 1 : -1;
            }
            return (sign * compare(a.key, b.key)) || (a.index - b.index);
        }).
        map((x) => x.item);
}

// sortLabel names a sort for the toolbar button, or null if its column no longer exists.
export function sortLabel(sort: Sort, columns: Column[]): string | null {
    switch (sort.key) {
    case 'manual':
        return 'Manual';
    case 'title':
        return 'Title';
    case 'created':
        return 'Created';
    case 'updated':
        return 'Updated';
    default:
        return columns.find((c) => c.id === sort.key)?.name ?? null;
    }
}
