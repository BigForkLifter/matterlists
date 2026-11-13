import {MIN_GAP, moveId, neighbours, orderBetween, renumber} from './order';

describe('orderBetween', () => {
    test('midpoint between two neighbours', () => {
        expect(orderBetween(1, 2)).toBe(1.5);
        expect(orderBetween(-3, 5)).toBe(1);
    });

    test('after the last item', () => {
        expect(orderBetween(4, undefined)).toBe(5);
    });

    test('before the first item', () => {
        expect(orderBetween(undefined, 4)).toBe(3);
    });

    test('an empty list or group', () => {
        expect(orderBetween()).toBe(0);
    });

    test('null when the gap is too small to split', () => {
        expect(orderBetween(1, 1)).toBeNull();
        expect(orderBetween(1, 1 + (MIN_GAP / 2))).toBeNull();
        expect(orderBetween(1, 1 + (MIN_GAP * 4))).not.toBeNull();
    });

    test('repeated inserts at the same spot run out of room eventually', () => {
        let prev = 1;
        const next = 2;
        let steps = 0;
        for (;;) {
            const order = orderBetween(prev, next);
            if (order === null) {
                break;
            }
            prev = order;
            steps++;
        }
        expect(steps).toBeGreaterThan(20);
        expect(steps).toBeLessThan(40);
    });
});

describe('neighbours', () => {
    const ids = ['a', 'b', 'c'];
    test('middle', () => expect(neighbours(ids, 'b')).toEqual({prevId: 'a', nextId: 'c'}));
    test('start', () => expect(neighbours(ids, 'a')).toEqual({prevId: undefined, nextId: 'b'}));
    test('end', () => expect(neighbours(ids, 'c')).toEqual({prevId: 'b', nextId: undefined}));
    test('alone', () => expect(neighbours(['a'], 'a')).toEqual({prevId: undefined, nextId: undefined}));
    test('missing', () => expect(neighbours(ids, 'x')).toEqual({}));
});

describe('moveId', () => {
    test('down', () => expect(moveId(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']));
    test('up', () => expect(moveId(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']));
    test('in place', () => expect(moveId(['a', 'b'], 1, 1)).toEqual(['a', 'b']));
});

test('renumber', () => {
    expect(renumber(['x', 'y', 'z'])).toEqual({x: 1, y: 2, z: 3});
});
