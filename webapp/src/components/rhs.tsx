import React, {useEffect, useState} from 'react';
import {useSelector} from 'react-redux';

import type {GlobalState} from '@mattermost/types/store';

import ListView from './list_view';
import {TemplatePicker} from './templates';

import {clearError, createList, openList, prefetchLists, useChannelLists, useError, useList, useOpenListId} from '../data';
import {DEFAULT_TEMPLATE_ID} from '../types';

// RHS is the sidebar: the current channel's lists, or the open list.
export default function RHS() {
    const channelId = useSelector((s: GlobalState) => s.entities.channels.currentChannelId);
    const openListId = useOpenListId();

    return (
        <div className='ml-root ml-rhs'>
            <ErrorBanner/>
            {openListId ? (
                <OpenList
                    listId={openListId}
                    channelId={channelId}
                />
            ) : (
                <ChannelLists channelId={channelId}/>
            )}
        </div>
    );
}

// OpenList closes the open list when the user switches to a channel it doesn't belong to.
function OpenList({listId, channelId}: {listId: string; channelId: string}) {
    const detail = useList(listId);
    if (detail && detail.list.channel_id !== channelId) {
        return <ChannelLists channelId={channelId}/>;
    }
    return <ListView listId={listId}/>;
}

function ErrorBanner() {
    const error = useError();
    if (!error) {
        return null;
    }
    return (
        <div
            className='ml-error'
            role='alert'
        >
            <span>{error}</span>
            <button
                className='ml-icon-btn ml-icon-btn--small'
                onClick={clearError}
                aria-label='Dismiss'
            >
                {'✕'}
            </button>
        </div>
    );
}

function ChannelLists({channelId}: {channelId: string}) {
    const lists = useChannelLists(channelId);
    const [creating, setCreating] = useState(false);

    // Load the lists shown here, so opening one is instant.
    useEffect(() => {
        if (lists) {
            prefetchLists(lists.slice(0, 20).map((l) => l.id));
        }
    }, [lists]);
    const [title, setTitle] = useState('');
    const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) {
            return;
        }
        const detail = await createList(channelId, title.trim(), templateId);
        if (detail) {
            setTitle('');
            setTemplateId(DEFAULT_TEMPLATE_ID);
            setCreating(false);
            openList(detail.list.id);
        }
    };

    return (
        <div className='ml-index'>
            <div className='ml-index__header'>
                <h2>{'Lists in this channel'}</h2>
                {!creating && (
                    <button
                        className='ml-btn ml-btn--primary'
                        onClick={() => setCreating(true)}
                    >
                        {'+ New list'}
                    </button>
                )}
            </div>

            {creating && (
                <form
                    className='ml-new-list'
                    onSubmit={submit}
                >
                    <input
                        className='ml-input'
                        autoFocus={true}
                        placeholder='List name, e.g. Launch checklist'
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                    />
                    <TemplatePicker
                        value={templateId}
                        onChange={setTemplateId}
                    />
                    <div className='ml-muted'>{'You can change the columns later.'}</div>
                    <div className='ml-row ml-new-list__actions'>
                        <button
                            className='ml-btn ml-btn--primary'
                            type='submit'
                            disabled={!title.trim()}
                        >
                            {'Create'}
                        </button>
                        <button
                            className='ml-btn ml-btn--ghost'
                            type='button'
                            onClick={() => setCreating(false)}
                        >
                            {'Cancel'}
                        </button>
                    </div>
                </form>
            )}

            {lists === undefined && <div className='ml-empty'>{'Loading…'}</div>}
            {lists?.length === 0 && !creating && (
                <div className='ml-empty'>{'No lists here yet. Track tasks, requests or anything else with your channel.'}</div>
            )}
            <ul className='ml-index__lists'>
                {lists?.map((l) => (
                    <li key={l.id}>
                        <button
                            className='ml-index__row'
                            onClick={() => openList(l.id)}
                        >
                            <span className='ml-index__name'>{l.title}</span>
                            <span className='ml-muted'>
                                {l.item_count}{l.item_count === 1 ? ' item' : ' items'}{' ›'}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}
