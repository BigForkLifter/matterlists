import React, {useEffect, useState} from 'react';

import {CellEditor} from './fields';
import {useListMode} from './list_mode';
import {MentionInput} from './mentions';
import Sheet from './sheet';

import {deleteItem, moveItem, openThread, patchItem, startThread} from '../data';
import type {Item, ListDetail} from '../types';
import {cellValue} from '../utils';

type Props = {
    detail: ListDetail;
    itemId: string;

    // manualOrder is false while the viewer sorts by a field, when moving an item up or
    // down wouldn't visibly do anything.
    manualOrder: boolean;
    onClose: () => void;
};

// ItemSheet edits every field of one item. Each change saves as soon as it is made
// (text fields when they lose focus); Done just closes the sheet.
export default function ItemSheet({detail, itemId, manualOrder, onClose}: Props) {
    const item = detail.items.find((it) => it.id === itemId);
    const [title, setTitle] = useState(item?.title || '');
    useEffect(() => setTitle(item?.title || ''), [item?.title]);

    useEffect(() => {
        // Someone else deleted the item while it was open.
        if (!item) {
            onClose();
        }
    }, [item, onClose]);

    if (!item) {
        return null;
    }

    const index = detail.items.indexOf(item);
    const commitTitle = () => {
        const trimmed = title.trim();
        if (!trimmed) {
            setTitle(item.title);
        } else if (trimmed !== item.title) {
            patchItem(item, {title: trimmed});
        }
    };

    const onDelete = () => {
        // eslint-disable-next-line no-alert
        if (window.confirm(`Delete “${item.title}”?`)) {
            deleteItem(item);
            onClose();
        }
    };

    return (
        <Sheet
            title='Item'
            onClose={onClose}
            editor={true}
        >
            {/* Grows to fit, so long titles aren't cut off. */}
            <MentionInput
                multiline={true}
                channelId={detail.list.channel_id}
                className='ml-input ml-input--title'
                value={title}
                rows={1}
                ariaLabel='Title'
                onChange={setTitle}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.blur();
                    }
                }}
            />

            <div className='ml-fields'>
                {detail.columns.map((column) => (
                    <div
                        key={column.id}
                        className='ml-field'
                    >
                        <div className='ml-field__label'>{column.name}</div>
                        <div className='ml-field__value'>
                            <CellEditor
                                column={column}
                                value={cellValue(column, item)}
                                automatic={item.values[column.id] === undefined}
                                item={item}
                                channelId={detail.list.channel_id}
                                onChange={(value) => patchItem(item, {values: {[column.id]: value}})}
                            />
                        </div>
                    </div>
                ))}
            </div>

            <div className='ml-sheet__footer'>
                <ThreadButton
                    item={item}
                    onLeave={onClose}
                />
                {manualOrder ? (
                    <div className='ml-row'>
                        <button
                            className='ml-btn ml-btn--ghost'
                            disabled={index <= 0}
                            onClick={() => moveItem(detail, item, -1)}
                        >
                            {'↑ Move up'}
                        </button>
                        <button
                            className='ml-btn ml-btn--ghost'
                            disabled={index >= detail.items.length - 1}
                            onClick={() => moveItem(detail, item, 1)}
                        >
                            {'↓ Move down'}
                        </button>
                    </div>
                ) : (
                    <div className='ml-muted ml-center'>{'To reorder items by hand, sort by Manual order.'}</div>
                )}
                <button
                    className='ml-btn ml-btn--danger-ghost'
                    onClick={onDelete}
                >
                    {'Delete item'}
                </button>
            </div>
        </Sheet>
    );
}

function ThreadButton({item, onLeave}: {item: Item; onLeave: () => void}) {
    const mode = useListMode();
    const [busy, setBusy] = useState(false);
    const onClick = async () => {
        setBusy(true);

        // The server returns the existing thread, or starts a new one if it was deleted.
        const rootId = await startThread(item);
        setBusy(false);
        if (rootId) {
            // On the full page the thread opens in Mattermost's sidebar, beside the page on
            // desktop and over it on phones.
            if (mode === 'page') {
                onLeave();
            }
            openThread(rootId);
        }
    };
    return (
        <button
            className='ml-btn ml-btn--primary'
            disabled={busy}
            onClick={onClick}
        >
            {item.root_post_id ? '💬 Open discussion' : '💬 Start discussion'}
        </button>
    );
}
