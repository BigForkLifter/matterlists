import {fitWithin} from './photos';
import {columnsLine, insertMention, itemTitleFrom, mentionQuery, splitMentions} from './utils';

describe('itemTitleFrom', () => {
    it('uses the first non-empty line', () => {
        expect(itemTitleFrom('\n  Fix the login page  \nmore details')).toBe('Fix the login page');
    });

    it('shortens long messages', () => {
        const title = itemTitleFrom('x'.repeat(500));
        expect(title).toHaveLength(200);
        expect(title.endsWith('…')).toBe(true);
    });

    it('falls back for empty messages', () => {
        expect(itemTitleFrom('   ')).toBe('Message');
    });
});

describe('splitMentions', () => {
    it('finds mentions but not email addresses', () => {
        expect(splitMentions('Ask @Sam.Park and @jo. Mail x@y.com')).toEqual([
            {text: 'Ask '},
            {text: '@Sam.Park', username: 'sam.park'},
            {text: ' and '},
            {text: '@jo', username: 'jo'},
            {text: '. Mail x@y.com'},
        ]);
    });

    it('keeps text without mentions whole', () => {
        expect(splitMentions('no one here')).toEqual([{text: 'no one here'}]);
        expect(splitMentions('')).toEqual([]);
    });
});

describe('mentionQuery', () => {
    it('finds the mention being typed', () => {
        expect(mentionQuery('call @sa', 8)).toEqual({start: 5, term: 'sa'});
        expect(mentionQuery('@', 1)).toEqual({start: 0, term: ''});
        expect(mentionQuery('line\n@j', 7)).toEqual({start: 5, term: 'j'});
        expect(mentionQuery('담당 @김민', 6)).toEqual({start: 3, term: '김민'});
    });

    it('ignores email addresses and finished mentions', () => {
        expect(mentionQuery('sam@ex', 6)).toBeNull();
        expect(mentionQuery('@sam ', 5)).toBeNull();
    });
});

describe('insertMention', () => {
    it('replaces the typed part and adds a space', () => {
        expect(insertMention('call @sa', 5, 8, 'sam')).toEqual({text: 'call @sam ', caret: 10});
    });

    it('replaces the rest of the word after the caret', () => {
        expect(insertMention('@sa|m now', 0, 3, 'sam').text).toBe('@sam |m now');
        expect(insertMention('@sax now', 0, 3, 'sam').text).toBe('@sam now');
        expect(insertMention('@s\nnext', 0, 2, 'sam').text).toBe('@sam \nnext');
    });
});

describe('fitWithin', () => {
    it('shrinks the longer side to the limit', () => {
        expect(fitWithin(4032, 3024, 2048)).toEqual({width: 2048, height: 1536});
        expect(fitWithin(3024, 4032, 2048)).toEqual({width: 1536, height: 2048});
    });
    it('leaves small images alone', () => {
        expect(fitWithin(800, 600, 2048)).toEqual({width: 800, height: 600});
    });
});

describe('columnsLine', () => {
    it('lists columns and the item count', () => {
        expect(columnsLine({columns: [{name: 'Status', type: 'select'}, {name: 'Due', type: 'date'}], item_count: 14})).toBe('Status · Due · 14 items');
        expect(columnsLine({columns: [{name: 'Done', type: 'checkbox'}], item_count: 1})).toBe('Done · 1 item');
    });
    it('says when there are no columns', () => {
        expect(columnsLine({columns: [], item_count: 0})).toBe('No columns');
    });
});
