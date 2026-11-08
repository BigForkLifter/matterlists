import React, {useEffect} from 'react';

import {openListInChannel, useList} from '../data';

// ListLink handles links to a list, /<team>/<plugin id>/list/<list id>, from the share
// sheet, channel bookmarks and the bot's messages (which add ?item=<item id>). It goes to
// the list's channel and opens the list, and the item if given, in the sidebar.
export default function ListLink() {
    const listId = window.location.pathname.split('/list/')[1]?.split(/[/?#]/)[0] || '';
    const itemId = new URLSearchParams(window.location.search).get('item') || undefined;

    return (
        <div className='ml-root ml-page'>
            {listId ? (
                <OpenInChannel
                    key={`${listId}:${itemId}`}
                    listId={listId}
                    itemId={itemId}
                />
            ) : (
                <div className='ml-empty'>{'This link is missing the list.'}</div>
            )}
        </div>
    );
}

function OpenInChannel({listId, itemId}: {listId: string; itemId?: string}) {
    const detail = useList(listId);
    const channelId = detail?.list.channel_id;
    useEffect(() => {
        if (channelId) {
            openListInChannel(listId, channelId, {itemId, replace: true});
        }
    }, [listId, channelId, itemId]);

    if (detail === null) {
        return (
            <div className='ml-empty'>
                {'This list was deleted or you no longer have access to it.'}
                <button
                    className='ml-btn ml-btn--ghost'
                    onClick={() => window.history.back()}
                >
                    {'Go back'}
                </button>
            </div>
        );
    }
    return <div className='ml-empty'>{'Opening…'}</div>;
}
