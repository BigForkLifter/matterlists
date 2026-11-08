import React, {useEffect, useRef} from 'react';
import ReactDOM from 'react-dom';
import {useSelector} from 'react-redux';

import type {GlobalState} from '@mattermost/types/store';

import {ListModeContext} from './list_mode';
import ListView from './list_view';

import {closeListPage, usePageListId} from '../data';

// ListPage is the full page: a list laid over the channel, opened with the sidebar's ⤢.
//
// It is a root component rather than a route, because Mattermost unloads the channel (its
// sidebar, messages and drafts, two dozen requests to rebuild) when it leaves a channel
// URL. It is drawn into Mattermost's ".main-wrapper" grid over the channel sidebar and
// centre columns, which leaves the right-hand sidebar free for a thread beside it.
export default function ListPage() {
    const listId = usePageListId();
    const channelId = useSelector((s: GlobalState) => s.entities.channels.currentChannelId);

    // Switching channels (Ctrl+K, a notification) closes the page.
    const shownIn = useRef(channelId);
    useEffect(() => {
        if (shownIn.current !== channelId) {
            shownIn.current = channelId;
            closeListPage();
        }
    }, [channelId]);
    useEffect(() => {
        shownIn.current = channelId;

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [listId]);

    if (!listId) {
        return null;
    }
    const page = (
        <ListModeContext.Provider value='page'>
            <div
                className='ml-root ml-page ml-page--panel'
                role='region'
                aria-label='List'
            >
                <ListView
                    key={listId}
                    listId={listId}
                />
            </div>
        </ListModeContext.Provider>
    );
    const grid = document.querySelector('.main-wrapper');
    return grid ? ReactDOM.createPortal(page, grid) : page;
}
