import type {CellValue, Column, Item, Template} from './types';

const MAX_TITLE = 200;

// itemTitleFrom turns a message into an item title: its first non-empty line, shortened.
export function itemTitleFrom(message: string): string {
    const line = message.split('\n').map((l) => l.trim()).find(Boolean) || 'Message';
    return line.length > MAX_TITLE ? line.slice(0, MAX_TITLE - 1).trimEnd() + '…' : line;
}

// cellValue is an item's value for a column. A Created by column shows the item's creator
// unless someone set a different person.
export function cellValue(column: Column, item: Item): CellValue | undefined {
    const stored = item.values[column.id];
    if (column.type === 'created_by' && stored === undefined) {
        return item.creator_id ? [item.creator_id] : undefined;
    }
    return stored;
}

// Mentions are written @username, as in Mattermost messages. The character before the @
// must not be part of a word, so email addresses aren't mentions. The server finds them
// with the same pattern (server/notify.go).
const MENTION = /(^|[^\w@.-])@([a-z0-9][a-z0-9._-]*)/gi;

export type TextPart = {text: string; username?: string};

// splitMentions cuts text into plain runs and mentions. A mention's username is
// lowercased, without a trailing period, which is taken as the end of a sentence.
export function splitMentions(text: string): TextPart[] {
    const parts: TextPart[] = [];
    let last = 0;
    for (const m of text.matchAll(MENTION)) {
        const name = m[2].replace(/\.+$/, '');
        const at = (m.index ?? 0) + m[1].length;
        if (at > last) {
            parts.push({text: text.slice(last, at)});
        }
        parts.push({text: '@' + name, username: name.toLowerCase()});
        last = at + 1 + name.length;
    }
    if (last < text.length) {
        parts.push({text: text.slice(last)});
    }
    return parts;
}

// mentionQuery finds a mention being typed just before the caret: where its @ is, and
// what follows it so far. The search term can be part of a name in any script, not just
// a username; picking someone writes their username.
export function mentionQuery(text: string, caret: number): {start: number; term: string} | null {
    const m = (/(^|[^\w@.-])@([^\s@]*)$/).exec(text.slice(0, caret));
    return m ? {start: m.index + m[1].length, term: m[2]} : null;
}

// insertMention replaces the mention being typed with @username and a space, returning
// the new text and where the caret goes.
export function insertMention(text: string, start: number, caret: number, username: string): {text: string; caret: number} {
    const inserted = `@${username} `;
    const rest = text.slice(caret).replace(/^[\w.-]* ?/, '');
    return {text: text.slice(0, start) + inserted + rest, caret: start + inserted.length};
}

// columnsLine summarizes what a template makes, e.g. "Status · Assignee · Due · 14 items".
export function columnsLine(t: Pick<Template, 'columns' | 'item_count'>): string {
    const parts = t.columns.map((c) => c.name);
    if (!parts.length) {
        parts.push('No columns');
    }
    if (t.item_count) {
        parts.push(t.item_count === 1 ? '1 item' : `${t.item_count} items`);
    }
    return parts.join(' · ');
}
