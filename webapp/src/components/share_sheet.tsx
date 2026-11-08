import React, {useEffect, useRef, useState} from 'react';
import {useSelector} from 'react-redux';

import type {GlobalState} from '@mattermost/types/store';

import Sheet from './sheet';

import {ApiError} from '../client';
import {addListBookmark, listURL} from '../data';
import type {List} from '../types';

// copyText copies to the clipboard, falling back to a selected text field where the
// Clipboard API is unavailable (plain-http servers, older browsers).
async function copyText(text: string, fallback: HTMLInputElement | null): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        if (!fallback) {
            return false;
        }
        fallback.select();
        try {
            return document.execCommand('copy');
        } catch {
            return false;
        }
    }
}

type BookmarkState = 'idle' | 'busy' | 'added';

// ShareSheet gives a list's link, to paste anywhere or add as a channel bookmark. It
// behaves like MatterMarkdown's share dialog, in this plugin's sheet.
export default function ShareSheet({list, onClose}: {list: List; onClose: () => void}) {
    const url = listURL(list.id);
    const inputRef = useRef<HTMLInputElement>(null);
    const [copied, setCopied] = useState(false);
    const [bookmark, setBookmark] = useState<BookmarkState>('idle');
    const [error, setError] = useState('');

    const canBookmark = useSelector((s: GlobalState) => bookmarkAllowed(s, list.channel_id));
    const alreadyBookmarked = useSelector((s: GlobalState) => {
        const bookmarks = s.entities.channelBookmarks?.byChannelId[list.channel_id];
        return Object.values(bookmarks ?? {}).some((b) => b.link_url === url);
    });

    // "Copied" goes back to "Copy link" after a moment, so it can be copied again.
    useEffect(() => {
        if (!copied) {
            return undefined;
        }
        const timer = window.setTimeout(() => setCopied(false), 2000);
        return () => window.clearTimeout(timer);
    }, [copied]);

    const copy = async () => {
        setError('');
        if (await copyText(url, inputRef.current)) {
            setCopied(true);
        } else {
            inputRef.current?.select();
            setError('Couldn’t copy. The link is selected above; copy it with Ctrl+C, or press and hold it on a phone.');
        }
    };

    const addBookmark = async () => {
        setError('');
        setBookmark('busy');
        try {
            await addListBookmark(list);
            setBookmark('added');
        } catch (err) {
            setBookmark('idle');
            setError(err instanceof ApiError && err.status === 403 ? 'You don’t have permission to add bookmarks in this channel.' : `Couldn’t add the bookmark: ${(err as Error).message}`);
        }
    };

    return (
        <Sheet
            title='Share list'
            onClose={onClose}
        >
            <div className='ml-field__label'>{'Link to this list'}</div>
            <input
                ref={inputRef}
                className='ml-input'
                value={url}
                readOnly={true}
                onFocus={(e) => e.target.select()}
                aria-label='Link to this list'
            />
            <button
                className='ml-btn ml-btn--primary'
                onClick={copy}
            >
                {copied ? '✓ Copied' : 'Copy link'}
            </button>
            <div className='ml-muted'>
                {'Anyone in this channel can open it. It opens the channel with the list in the sidebar, and keeps working if the list or channel is renamed.'}
            </div>

            {canBookmark && (
                <>
                    <h3 className='ml-section-title'>{'Channel bookmark'}</h3>
                    {alreadyBookmarked || bookmark === 'added' ? (
                        <div
                            className='ml-muted'
                            role='status'
                        >
                            {bookmark === 'added' ? '✓ Added to this channel’s bookmarks.' : '✓ Already in this channel’s bookmarks.'}
                        </div>
                    ) : (
                        <>
                            <button
                                className='ml-btn ml-btn--ghost'
                                disabled={bookmark === 'busy'}
                                onClick={addBookmark}
                            >
                                {'+ Add to this channel’s bookmarks'}
                            </button>
                            <div className='ml-muted'>{'Or paste the link in the bookmarks bar with “Add a link”.'}</div>
                        </>
                    )}
                </>
            )}

            {error && (
                <div
                    className='ml-error'
                    role='alert'
                >
                    {error}
                </div>
            )}
        </Sheet>
    );
}

// bookmarkAllowed mirrors MatterMarkdown: channel bookmarks only exist on licensed servers
// (Entry edition counts). In public and private channels adding one is a permission from
// the viewer's system, team or channel roles; in DMs and group messages every member may.
// It reads the roles directly rather than importing mattermost-redux's selectors, which
// would add about 70 KB to the bundle. The server checks again.
function bookmarkAllowed(state: GlobalState, channelId: string): boolean {
    const {entities} = state;
    if (entities.general.license?.IsLicensed !== 'true') {
        return false;
    }
    const channel = entities.channels.channels[channelId];
    if (!channel || channel.delete_at) {
        return false;
    }
    if (channel.type === 'D' || channel.type === 'G') {
        return true;
    }
    const permission = channel.type === 'O' ? 'add_bookmark_public_channel' : 'add_bookmark_private_channel';
    const roleNames = [
        entities.users.profiles[entities.users.currentUserId]?.roles,
        entities.teams.myMembers[channel.team_id]?.roles,
        entities.channels.myMembers[channelId]?.roles,
    ].join(' ').split(' ').filter(Boolean);
    return roleNames.some((name) => entities.roles.roles[name]?.permissions?.includes(permission));
}
