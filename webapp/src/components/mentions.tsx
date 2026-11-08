import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useSelector} from 'react-redux';

import type {GlobalState} from '@mattermost/types/store';

import {useAutoGrow} from './auto_grow';
import {Avatar} from './fields';

import {Client} from '../client';
import {displayName, fetchUsersByUsername, rememberUsers, useUserByUsername} from '../data';
import type {UserLite} from '../types';
import {insertMention, mentionQuery, splitMentions} from '../utils';
import type {TextPart} from '../utils';

// MentionText shows text with each @username as the person's name. Mentions of people
// who can't be found stay as typed.
export function MentionText({text}: {text: string}) {
    const parts = useMemo(() => splitMentions(text), [text]);
    const names = parts.flatMap((p) => (p.username ? [p.username] : [])).join(' ');
    useEffect(() => {
        if (names) {
            fetchUsersByUsername(names.split(' '));
        }
    }, [names]);
    return (
        <>
            {parts.map((part, i) => (part.username ? (
                <Mention
                    key={i}
                    part={part}
                />
            ) : part.text))}
        </>
    );
}

function Mention({part}: {part: TextPart}) {
    const user = useUserByUsername(part.username || '');
    if (!user) {
        return <>{part.text}</>;
    }
    return (
        <span
            className='ml-mention'
            title={`@${user.username}`}
        >
            {'@'}{displayName(user)}
        </span>
    );
}

const MAX_SUGGESTIONS = 5;

// Room the suggestions need below a field; with less, they open above it if there's more
// room there, as when the phone keyboard covers the bottom of the screen.
const SUGGESTIONS_HEIGHT = 240;

type Props = {
    channelId: string;
    value: string;
    onChange: (value: string) => void;

    // multiline fields are textareas that grow with their text; others are one-line inputs.
    multiline?: boolean;
    className: string;
    rows?: number;
    placeholder?: string;
    ariaLabel?: string;
    enterKeyHint?: 'done' | 'enter';
    onBlur?: () => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
};

// MentionInput is a text field where typing @ suggests channel members. Picking one
// writes @username, which the server turns into a DM to that person.
export function MentionInput({channelId, value, onChange, multiline, className, rows, placeholder, ariaLabel, enterKeyHint, onBlur, onKeyDown}: Props) {
    const teamId = useSelector((s: GlobalState) => s.entities.teams.currentTeamId);
    const areaRef = useAutoGrow(value);
    const inputRef = useRef<HTMLInputElement>(null);
    const field = () => (multiline ? areaRef.current : inputRef.current);

    const [query, setQuery] = useState<{start: number; term: string} | null>(null);
    const [above, setAbove] = useState(false);
    const [users, setUsers] = useState<UserLite[]>([]);
    const [active, setActive] = useState(0);
    const open = query !== null && users.length > 0;

    // Where the caret goes once a picked mention is in the text.
    const caretAfterPick = useRef<number | null>(null);
    useLayoutEffect(() => {
        const caret = caretAfterPick.current;
        if (caret !== null) {
            caretAfterPick.current = null;
            field()?.setSelectionRange(caret, caret);
        }
    });

    const refresh = (el: HTMLTextAreaElement | HTMLInputElement) => {
        const caret = el.selectionStart ?? el.value.length;
        const next = el.selectionEnd === caret ? mentionQuery(el.value, caret) : null;
        if (next && !query) {
            const rect = el.getBoundingClientRect();
            const viewHeight = window.visualViewport?.height ?? window.innerHeight;
            const below = viewHeight - rect.bottom;
            setAbove(below < SUGGESTIONS_HEIGHT && rect.top > below);
        }
        setQuery(next);
    };

    const term = query?.term;
    useEffect(() => {
        if (term === undefined) {
            setUsers([]);
            return undefined;
        }
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const res = await Client.searchChannelUsers(teamId, channelId, term);
                if (!cancelled) {
                    rememberUsers(res.users);
                    setUsers(res.users.slice(0, MAX_SUGGESTIONS));
                    setActive(0);
                }
            } catch {
                // Keep the previous suggestions; the next keystroke retries.
            }
        }, 150);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [term, teamId, channelId]);

    // Escape closes the suggestions, not the sheet around the field. Sheets listen on the
    // document while capturing, so this listens on the window, which comes first.
    useEffect(() => {
        if (!open) {
            return undefined;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                e.preventDefault();
                setQuery(null);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open]);

    const pick = (user: UserLite) => {
        if (!query) {
            return;
        }
        const caret = field()?.selectionStart ?? value.length;
        const next = insertMention(value, query.start, caret, user.username);
        caretAfterPick.current = next.caret;
        setQuery(null);
        onChange(next.text);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
        if (open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setActive((active + step + users.length) % users.length);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pick(users[active]);
                return;
            }
        }
        onKeyDown?.(e);
    };

    const common = {
        className,
        value,
        placeholder,
        enterKeyHint,
        'aria-label': ariaLabel,
        'aria-autocomplete': 'list' as const,
        'aria-expanded': open,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
            onChange(e.target.value);
            refresh(e.target);
        },
        onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement | HTMLInputElement>) => refresh(e.currentTarget),
        onKeyDown: handleKeyDown,
        onBlur: () => {
            setQuery(null);
            onBlur?.();
        },
    };

    return (
        <div className='ml-mention-field'>
            {multiline ? (
                <textarea
                    {...common}
                    ref={areaRef}
                    rows={rows}
                />
            ) : (
                <input
                    {...common}
                    ref={inputRef}
                />
            )}
            {open && (
                <div
                    className={`ml-mention-list${above ? ' ml-mention-list--above' : ''}`}
                    role='listbox'
                >
                    {users.map((u, i) => (
                        <button
                            key={u.id}
                            type='button'
                            role='option'
                            aria-selected={i === active}
                            className={`ml-option${i === active ? ' ml-option--selected' : ''}`}

                            // Keep focus in the field, so picking doesn't save a half-typed edit.
                            onPointerDown={(e) => e.preventDefault()}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pick(u)}
                        >
                            <span className='ml-row'>
                                <Avatar
                                    userId={u.id}
                                    size={24}
                                />
                                <span>
                                    {displayName(u)}
                                    <span className='ml-muted'>{' @'}{u.username}</span>
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
