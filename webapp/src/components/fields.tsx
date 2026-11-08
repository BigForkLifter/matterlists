import React, {useEffect, useState} from 'react';
import {useSelector} from 'react-redux';

import type {GlobalState} from '@mattermost/types/store';

import {MentionInput, MentionText} from './mentions';
import {PhotoCardThumb, PhotosEditor} from './photos';
import Sheet from './sheet';

import {Client} from '../client';
import {displayName, fetchUsers, rememberUsers, useUser} from '../data';
import type {CellValue, Choice, Column, Item, UserLite} from '../types';

// Display

export function ChoiceChip({choice}: {choice: Choice}) {
    return <span className={`ml-chip ml-chip--${choice.color}`}>{choice.name}</span>;
}

export function Avatar({userId, size = 20}: {userId: string; size?: number}) {
    const user = useUser(userId);
    useEffect(() => {
        fetchUsers([userId]);
    }, [userId]);
    return (
        <img
            className='ml-avatar'
            src={Client.userImageURL(user || {id: userId})}
            alt=''
            width={size}
            height={size}
        />
    );
}

export function PersonChip({userId}: {userId: string}) {
    const user = useUser(userId);
    return (
        <span className='ml-chip ml-chip--person'>
            <Avatar userId={userId}/>
            {displayName(user)}
        </span>
    );
}

export function formatDate(value: string): string {
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric'});
}

export function isOverdue(value: string): boolean {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return value < iso;
}

export function choicesOf(column: Column): Choice[] {
    return column.options.choices || [];
}

// CellDisplay renders a value compactly for cards. It returns null for an empty cell.
// A done item's past dates aren't shown as overdue.
export function CellDisplay({column, value, done}: {column: Column; value: CellValue | undefined; done?: boolean}) {
    if (value === undefined) {
        return null;
    }
    switch (column.type) {
    case 'select': {
        const choice = choicesOf(column).find((c) => c.id === value);
        return choice ? <ChoiceChip choice={choice}/> : null;
    }
    case 'multi_select': {
        const ids = value as string[];
        const chosen = choicesOf(column).filter((c) => ids.includes(c.id));
        return chosen.length ? (
            <>
                {chosen.map((c) => (
                    <ChoiceChip
                        key={c.id}
                        choice={c}
                    />
                ))}
            </>
        ) : null;
    }
    case 'created_by':
        // Labelled, so the creator isn't mistaken for an assignee on cards.
        return (
            <span className='ml-chip ml-chip--plain'>
                {column.name}{':'}
                {(value as string[]).map((id) => (
                    <PersonChip
                        key={id}
                        userId={id}
                    />
                ))}
            </span>
        );
    case 'person':
        return (
            <>
                {(value as string[]).map((id) => (
                    <PersonChip
                        key={id}
                        userId={id}
                    />
                ))}
            </>
        );
    case 'date':
        return (
            <span className={`ml-chip ml-chip--plain${!done && isOverdue(value as string) ? ' ml-chip--overdue' : ''}`}>
                {'📅 '}{formatDate(value as string)}
            </span>
        );
    case 'checkbox':
        return <span className='ml-chip ml-chip--plain'>{'✓ '}{column.name}</span>;
    case 'url':
        return (

            // Plugins can't import the webapp's ExternalLink component.
            // eslint-disable-next-line @mattermost/use-external-link
            <a
                className='ml-chip ml-chip--plain ml-chip--link'
                href={value as string}
                target='_blank'
                rel='noopener noreferrer'
                onClick={(e) => e.stopPropagation()}
            >
                {hostOf(value as string)}
            </a>
        );
    case 'number':
        return <span className='ml-chip ml-chip--plain'>{column.name}{': '}{String(value)}</span>;
    case 'photos':
        return <PhotoCardThumb ids={value as string[]}/>;
    default:
        // Up to two lines, on a row of their own; the item editor shows the rest.
        return (
            <span className='ml-card-text'>
                <MentionText text={String(value)}/>
            </span>
        );
    }
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

// Editors. Each calls onChange with the new value, or null to clear the cell.

type EditorProps = {
    column: Column;
    value: CellValue | undefined;
    onChange: (value: CellValue | null) => void;
    channelId: string;

    // automatic is true when a Created by value is the item's creator rather than a
    // person someone picked.
    automatic?: boolean;

    // The item being edited, which photo uploads go to.
    item?: Item;
};

export function CellEditor(props: EditorProps) {
    switch (props.column.type) {
    case 'select':
        return <SelectEditor {...props}/>;
    case 'multi_select':
        return <MultiSelectEditor {...props}/>;
    case 'person':
        return <PersonEditor {...props}/>;
    case 'created_by':
        return <CreatedByEditor {...props}/>;
    case 'photos':
        return <PhotosEditor {...props}/>;
    case 'checkbox':
        return (
            <label className='ml-switch'>
                <input
                    type='checkbox'
                    checked={props.value === true}
                    onChange={(e) => props.onChange(e.target.checked)}
                />
                <span className='ml-switch__track'/>
            </label>
        );
    case 'date':
        return (
            <div className='ml-row'>
                <input
                    className='ml-input'
                    type='date'
                    value={(props.value as string) || ''}
                    onChange={(e) => props.onChange(e.target.value || null)}
                />
                {props.value !== undefined && (
                    <button
                        className='ml-btn ml-btn--ghost'
                        onClick={() => props.onChange(null)}
                    >
                        {'Clear'}
                    </button>
                )}
            </div>
        );
    default:
        return <TextishEditor {...props}/>;
    }
}

// TextishEditor edits text, number and url values, saving when the field loses focus.
function TextishEditor({column, value, onChange, channelId}: EditorProps) {
    const initial = value === undefined ? '' : String(value);
    const [draft, setDraft] = useState(initial);
    useEffect(() => setDraft(initial), [initial]);

    const commit = () => {
        const trimmed = draft.trim();
        if (trimmed === initial) {
            return;
        }
        if (trimmed === '') {
            onChange(null);
        } else if (column.type === 'number') {
            const n = Number(trimmed);
            if (Number.isNaN(n)) {
                setDraft(initial);
                return;
            }
            onChange(n);
        } else {
            onChange(trimmed);
        }
    };

    if (column.type === 'text') {
        return (
            <MentionInput
                multiline={true}
                channelId={channelId}
                className='ml-input ml-input--area ml-input--grow'
                value={draft}
                rows={3}
                placeholder='Add text, or @ someone'
                onChange={setDraft}
                onBlur={commit}
            />
        );
    }
    return (
        <input
            className='ml-input'
            type={column.type === 'number' ? 'text' : 'url'}
            inputMode={column.type === 'number' ? 'decimal' : 'url'}
            value={draft}
            placeholder={column.type === 'number' ? '0' : 'https://'}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
    );
}

function SelectEditor({column, value, onChange}: EditorProps) {
    const [open, setOpen] = useState(false);
    const current = choicesOf(column).find((c) => c.id === value);
    return (
        <>
            <button
                className='ml-picker-btn'
                onClick={() => setOpen(true)}
            >
                {current ? <ChoiceChip choice={current}/> : <span className='ml-muted'>{'None'}</span>}
                <span className='ml-muted'>{'▾'}</span>
            </button>
            {open && (
                <ChoiceSheet
                    column={column}
                    value={value as string | undefined}
                    onPick={(id) => {
                        setOpen(false);
                        onChange(id);
                    }}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
}

// ChoiceSheet picks one choice of a select column, or none.
export function ChoiceSheet({column, value, onPick, onClose}: {column: Column; value?: string; onPick: (id: string | null) => void; onClose: () => void}) {
    return (
        <Sheet
            title={column.name}
            onClose={onClose}
        >
            <div className='ml-options'>
                {choicesOf(column).map((c) => (
                    <button
                        key={c.id}
                        className={`ml-option${c.id === value ? ' ml-option--selected' : ''}`}
                        onClick={() => onPick(c.id)}
                    >
                        <ChoiceChip choice={c}/>
                        {c.id === value && <span>{'✓'}</span>}
                    </button>
                ))}
                <button
                    className='ml-option'
                    onClick={() => onPick(null)}
                >
                    <span className='ml-muted'>{'None'}</span>
                    {value === undefined && <span>{'✓'}</span>}
                </button>
            </div>
        </Sheet>
    );
}

function MultiSelectEditor({column, value, onChange}: EditorProps) {
    const selected = (value as string[] | undefined) || [];
    const toggle = (id: string) => {
        const next = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
        onChange(next.length ? next : null);
    };
    if (!choicesOf(column).length) {
        return <span className='ml-muted'>{'No options yet. Add some in list settings.'}</span>;
    }
    return (
        <div className='ml-wrap'>
            {choicesOf(column).map((c) => (
                <button
                    key={c.id}
                    className={`ml-toggle-chip${selected.includes(c.id) ? ' ml-toggle-chip--on' : ''}`}
                    onClick={() => toggle(c.id)}
                    aria-pressed={selected.includes(c.id)}
                >
                    <ChoiceChip choice={c}/>
                </button>
            ))}
        </div>
    );
}

function PersonEditor({value, onChange, channelId}: EditorProps) {
    const [open, setOpen] = useState(false);
    const selected = (value as string[] | undefined) || [];
    return (
        <div className='ml-wrap'>
            {selected.map((id) => (
                <span
                    key={id}
                    className='ml-removable'
                >
                    <PersonChip userId={id}/>
                    <button
                        className='ml-icon-btn ml-icon-btn--small'
                        aria-label='Remove'
                        onClick={() => {
                            const next = selected.filter((s) => s !== id);
                            onChange(next.length ? next : null);
                        }}
                    >
                        {'✕'}
                    </button>
                </span>
            ))}
            <button
                className='ml-btn ml-btn--ghost'
                onClick={() => setOpen(true)}
            >
                {'+ Add person'}
            </button>
            {open && (
                <PersonSheet
                    channelId={channelId}
                    exclude={selected}
                    onPick={(user) => {
                        setOpen(false);
                        onChange([...selected, user.id]);
                    }}
                    onClose={() => setOpen(false)}
                />
            )}
        </div>
    );
}

// CreatedByEditor shows who created the item and lets people pick someone else instead,
// or go back to the creator.
function CreatedByEditor({value, onChange, channelId, automatic}: EditorProps) {
    const [open, setOpen] = useState(false);
    const current = (value as string[] | undefined) || [];
    return (
        <div className='ml-wrap'>
            {current.map((id) => (
                <PersonChip
                    key={id}
                    userId={id}
                />
            ))}
            <span className='ml-muted'>{automatic ? 'Set automatically' : 'Changed by hand'}</span>
            <button
                className='ml-btn ml-btn--ghost'
                onClick={() => setOpen(true)}
            >
                {'Change'}
            </button>
            {!automatic && (
                <button
                    className='ml-btn ml-btn--ghost'
                    onClick={() => onChange(null)}
                >
                    {'Reset to creator'}
                </button>
            )}
            {open && (
                <PersonSheet
                    channelId={channelId}
                    exclude={current}
                    onPick={(user) => {
                        setOpen(false);
                        onChange([user.id]);
                    }}
                    onClose={() => setOpen(false)}
                />
            )}
        </div>
    );
}

function PersonSheet({channelId, exclude, onPick, onClose}: {channelId: string; exclude: string[]; onPick: (user: UserLite) => void; onClose: () => void}) {
    const teamId = useSelector((s: GlobalState) => s.entities.teams.currentTeamId);
    const [term, setTerm] = useState('');
    const [users, setUsers] = useState<UserLite[]>([]);

    useEffect(() => {
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const res = await Client.searchChannelUsers(teamId, channelId, term.trim());
                if (!cancelled) {
                    rememberUsers(res.users);
                    setUsers(res.users);
                }
            } catch {
                // Keep the previous results; the next keystroke retries.
            }
        }, 200);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [term, teamId, channelId]);

    const shown = users.filter((u) => !exclude.includes(u.id));
    return (
        <Sheet
            title='Add person'
            onClose={onClose}
        >
            <input
                className='ml-input'
                type='search'
                autoFocus={true}
                placeholder='Search channel members'
                value={term}
                onChange={(e) => setTerm(e.target.value)}
            />
            <div className='ml-options'>
                {shown.map((u) => (
                    <button
                        key={u.id}
                        className='ml-option'
                        onClick={() => onPick(u)}
                    >
                        <span className='ml-row'>
                            <Avatar
                                userId={u.id}
                                size={28}
                            />
                            <span>
                                {displayName(u)}
                                <span className='ml-muted'>{' @'}{u.username}</span>
                            </span>
                        </span>
                    </button>
                ))}
                {!shown.length && <div className='ml-empty'>{'No matching channel members.'}</div>}
            </div>
        </Sheet>
    );
}
