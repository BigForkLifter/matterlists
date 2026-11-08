import React, {useEffect, useRef, useState} from 'react';

import Sheet from './sheet';

import {Client} from '../client';
import {showError, uploadPhoto} from '../data';
import {shrinkPhoto} from '../photos';
import {MAX_PHOTOS_PER_CELL} from '../types';
import type {CellValue, Column, Item} from '../types';

// PhotoCardThumb shows a photos cell on a card: the first photo, and how many more there are.
export function PhotoCardThumb({ids}: {ids: string[]}) {
    if (!ids.length) {
        return null;
    }
    return (
        <span className='ml-card-photo'>
            <img
                src={Client.photoURL(ids[0], 'thumb')}
                alt={ids.length === 1 ? '1 photo' : `${ids.length} photos`}
                loading='lazy'
            />
            {ids.length > 1 && <span className='ml-card-photo__more'>{`+${ids.length - 1}`}</span>}
        </span>
    );
}

type EditorProps = {
    column: Column;
    value: CellValue | undefined;
    onChange: (value: CellValue | null) => void;
    item?: Item;
};

// PhotosEditor shows a cell's photos as a grid. "Add photos" offers the camera and the
// photo library on phones; each photo is shrunk and uploaded in turn, and saved as soon
// as it arrives. Tapping a photo opens it full screen, where it can be removed.
export function PhotosEditor({column, value, onChange, item}: EditorProps) {
    const ids = (value as string[] | undefined) || [];
    const [uploading, setUploading] = useState(0);
    const [viewing, setViewing] = useState<number | null>(null);
    const input = useRef<HTMLInputElement>(null);

    const onFiles = async (files: File[]) => {
        if (!item || !files.length) {
            return;
        }
        const room = MAX_PHOTOS_PER_CELL - ids.length - uploading;
        if (files.length > room) {
            showError(`${column.name} can have at most ${MAX_PHOTOS_PER_CELL} photos.`);
        }
        const chosen = files.slice(0, Math.max(0, room));
        setUploading((n) => n + chosen.length);

        // One at a time keeps the order people picked them in, and the memory use low.
        for (const file of chosen) {
            // eslint-disable-next-line no-await-in-loop
            await uploadPhoto(item, column.id, await shrinkPhoto(file));
            setUploading((n) => n - 1);
        }
    };

    const remove = (id: string) => {
        const next = ids.filter((x) => x !== id);
        onChange(next.length ? next : null);
    };

    return (
        <div className='ml-photo-grid'>
            {ids.map((id, i) => (
                <button
                    key={id}
                    className='ml-photo-tile'
                    aria-label={`Photo ${i + 1}`}
                    onClick={() => setViewing(i)}
                >
                    <img
                        src={Client.photoURL(id, 'thumb')}
                        alt=''
                        loading='lazy'
                    />
                </button>
            ))}
            {Array.from({length: uploading}, (_, i) => (
                <div
                    key={`uploading-${i}`}
                    className='ml-photo-tile ml-photo-tile--uploading'
                    role='status'
                >
                    {'Uploading…'}
                </div>
            ))}
            {ids.length + uploading < MAX_PHOTOS_PER_CELL && (
                <button
                    className='ml-photo-tile ml-photo-tile--add'
                    onClick={() => input.current?.click()}
                >
                    <span className='ml-photo-tile__plus'>{'+'}</span>
                    {'Add photos'}
                </button>
            )}
            <input
                ref={input}
                className='ml-visually-hidden'
                type='file'
                accept='image/*'
                multiple={true}
                tabIndex={-1}
                aria-hidden='true'
                onChange={(e) => {
                    const files = Array.from(e.target.files || []);

                    // Cleared so picking the same photo again still fires a change.
                    e.target.value = '';
                    onFiles(files);
                }}
            />
            {viewing !== null && ids.length > 0 && (
                <PhotoViewer
                    ids={ids}
                    index={Math.min(viewing, ids.length - 1)}
                    onIndex={setViewing}
                    onRemove={remove}
                    onClose={() => setViewing(null)}
                />
            )}
        </div>
    );
}

type ViewerProps = {
    ids: string[];
    index: number;
    onIndex: (index: number) => void;
    onRemove: (id: string) => void;
    onClose: () => void;
};

// PhotoViewer shows one photo at a time, full screen on phones. Swipe or use the arrows
// (or arrow keys) to move between photos.
function PhotoViewer({ids, index, onIndex, onRemove, onClose}: ViewerProps) {
    const touchX = useRef<number | null>(null);
    const id = ids[index];
    const go = (delta: number) => {
        const next = index + delta;
        if (next >= 0 && next < ids.length) {
            onIndex(next);
        }
    };
    const goRef = useRef(go);
    goRef.current = go;

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') {
                goRef.current(-1);
            } else if (e.key === 'ArrowRight') {
                goRef.current(1);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    const onRemoveClick = () => {
        // eslint-disable-next-line no-alert
        if (window.confirm('Remove this photo? It will be deleted for everyone.')) {
            onRemove(id);
            if (ids.length <= 1) {
                onClose();
            } else if (index >= ids.length - 1) {
                onIndex(index - 1);
            }
        }
    };

    return (
        <Sheet
            title={ids.length > 1 ? `Photo ${index + 1} of ${ids.length}` : 'Photo'}
            onClose={onClose}
        >
            <div
                className='ml-photo-view'
                onTouchStart={(e) => {
                    touchX.current = e.touches[0].clientX;
                }}
                onTouchEnd={(e) => {
                    if (touchX.current === null) {
                        return;
                    }
                    const dx = e.changedTouches[0].clientX - touchX.current;
                    touchX.current = null;
                    if (Math.abs(dx) > 50) {
                        go(dx < 0 ? 1 : -1);
                    }
                }}
            >
                <img
                    key={id}
                    src={Client.photoURL(id)}
                    alt={`Photo ${index + 1}`}
                />
            </div>
            {ids.length > 1 && (
                <div className='ml-row ml-photo-nav'>
                    <button
                        className='ml-btn ml-btn--ghost'
                        disabled={index <= 0}
                        onClick={() => go(-1)}
                    >
                        {'‹ Previous'}
                    </button>
                    <button
                        className='ml-btn ml-btn--ghost'
                        disabled={index >= ids.length - 1}
                        onClick={() => go(1)}
                    >
                        {'Next ›'}
                    </button>
                </div>
            )}
            <div className='ml-sheet__footer'>
                {/* Plugins can't import the webapp's ExternalLink component. */}
                {/* eslint-disable-next-line @mattermost/use-external-link */}
                <a
                    className='ml-btn ml-btn--ghost'
                    href={Client.photoURL(id)}
                    target='_blank'
                    rel='noopener noreferrer'
                >
                    {'Open full size'}
                </a>
                <button
                    className='ml-btn ml-btn--danger-ghost'
                    onClick={onRemoveClick}
                >
                    {'Remove photo'}
                </button>
            </div>
        </Sheet>
    );
}
