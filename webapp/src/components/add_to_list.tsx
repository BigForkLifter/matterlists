import React, {useState} from 'react';

import {MentionInput} from './mentions';
import Sheet from './sheet';

import {addItem, setAddingPost, useAddingPost, useChannelLists} from '../data';
import {itemTitleFrom} from '../utils';

// AddToList is mounted at the app root and opens when "Add to list" is picked from a message's menu.
export default function AddToList() {
    const post = useAddingPost();
    if (!post) {
        return null;
    }
    return (
        <AddToListSheet
            key={post.id}
            post={post}
        />
    );
}

function AddToListSheet({post}: {post: {id: string; channelId: string; message: string}}) {
    const lists = useChannelLists(post.channelId);
    const [title, setTitle] = useState(() => itemTitleFrom(post.message));
    const [added, setAdded] = useState<string | null>(null);
    const close = () => setAddingPost(null);

    const add = async (listId: string, listTitle: string) => {
        if (!title.trim()) {
            return;
        }
        const item = await addItem(listId, title.trim(), undefined, post.id);
        if (item) {
            setAdded(listTitle);
            setTimeout(close, 900);
        }
    };

    return (
        <Sheet
            title='Add to list'
            onClose={close}
        >
            {added ? (
                <div className='ml-empty'>{'✓ Added to '}{added}</div>
            ) : (
                <>
                    <div className='ml-field'>
                        <div className='ml-field__label'>{'Item'}</div>
                        <MentionInput
                            multiline={true}
                            channelId={post.channelId}
                            className='ml-input ml-input--area ml-input--grow'
                            value={title}
                            rows={2}
                            onChange={setTitle}
                        />
                    </div>
                    <div className='ml-field__label'>{'Choose a list'}</div>
                    <div className='ml-options'>
                        {lists?.map((l) => (
                            <button
                                key={l.id}
                                className='ml-option'
                                disabled={!title.trim()}
                                onClick={() => add(l.id, l.title)}
                            >
                                <span>{l.title}</span>
                                <span className='ml-muted'>{l.item_count}</span>
                            </button>
                        ))}
                        {lists?.length === 0 && (
                            <div className='ml-empty'>{'This channel has no lists yet. Create one from the channel header’s Lists button.'}</div>
                        )}
                    </div>
                </>
            )}
        </Sheet>
    );
}
