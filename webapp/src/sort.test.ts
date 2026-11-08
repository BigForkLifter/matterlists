import {parseSort, sortItems} from './sort';
import type {Column, Item} from './types';

const status: Column = {
    id: 'status',
    list_id: 'l',
    name: 'Status',
    type: 'select',
    sort_order: 1,
    create_at: 0,
    options: {choices: [{id: 'todo', name: 'To do', color: 'gray'}, {id: 'doing', name: 'Doing', color: 'blue'}, {id: 'done', name: 'Done', color: 'green'}]},
};
const due: Column = {id: 'due', list_id: 'l', name: 'Due', type: 'date', sort_order: 2, create_at: 0, options: {}};
const points: Column = {id: 'pts', list_id: 'l', name: 'Points', type: 'number', sort_order: 3, create_at: 0, options: {}};
const owner: Column = {id: 'owner', list_id: 'l', name: 'Owner', type: 'person', sort_order: 4, create_at: 0, options: {}};
const createdBy: Column = {id: 'cb', list_id: 'l', name: 'Assigner', type: 'created_by', sort_order: 5, create_at: 0, options: {}};
const columns = [status, due, points, owner, createdBy];

function item(id: string, title: string, values: Item['values'], createAt = 0, creator = 'u1'): Item {
    return {id, list_id: 'l', title, values, sort_order: 0, root_post_id: '', source_post_id: '', creator_id: creator, create_at: createAt, update_at: createAt};
}

const items = [
    item('a', 'banana', {status: 'done', due: '2026-11-02', pts: 10, owner: ['u2']}, 3),
    item('b', 'Apple', {status: 'todo', pts: 2}, 1),
    item('c', 'cherry', {due: '2026-10-20', pts: 2.5, owner: ['u1'], cb: ['u2']}, 2),
    item('d', 'item 10', {status: 'doing', due: '2026-10-25'}, 4, 'u2'),
    item('e', 'item 9', {}, 5),
];
const names: Record<string, string> = {u1: 'Zoe', u2: 'Adam'};
const ids = (sorted: Item[]) => sorted.map((it) => it.id).join('');
const sortBy = (raw: string) => ids(sortItems(items, parseSort(raw), columns, (id) => names[id]));

describe('sortItems', () => {
    it('keeps manual order, or reverses it', () => {
        expect(sortBy('manual:asc')).toBe('abcde');
        expect(sortBy('manual:desc')).toBe('edcba');
    });

    it('sorts titles ignoring case and with numbers in order', () => {
        expect(sortBy('title:asc')).toBe('baced');
        expect(sortBy('title:desc')).toBe('decab');
    });

    it('sorts select columns by choice order, empty last either way', () => {
        expect(sortBy('status:asc')).toBe('bdace');
        expect(sortBy('status:desc')).toBe('adbce');
    });

    it('sorts dates and numbers, empty last', () => {
        expect(sortBy('due:asc')).toBe('cdabe');
        expect(sortBy('due:desc')).toBe('adcbe');
        expect(sortBy('pts:asc')).toBe('bcade');
    });

    it('sorts people by display name', () => {
        expect(sortBy('owner:asc')).toBe('acbde');
    });

    it('sorts by who created the item, or whoever it was changed to', () => {
        expect(sortBy('cb:asc')).toBe('cdabe');
    });

    it('sorts by created time', () => {
        expect(sortBy('created:desc')).toBe('edacb');
    });

    it('falls back to manual for a deleted column', () => {
        expect(sortBy('gone:asc')).toBe('abcde');
    });
});
