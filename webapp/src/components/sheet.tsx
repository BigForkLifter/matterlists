import React, {useEffect, useRef, useState} from 'react';
import ReactDOM from 'react-dom';

import {useSaveState} from '../data';

type Props = {
    title: React.ReactNode;
    onClose: () => void;

    // editor sheets save as you go: they show a Done button and whether changes are saved,
    // instead of a close button.
    editor?: boolean;
    children: React.ReactNode;
};

// Open sheets, topmost last, so Escape closes only the one on top.
const openSheets: Array<{current: () => void}> = [];

// Sheet is full-screen on phones and a centered dialog on wider screens. It renders into
// document.body so it isn't clipped by the narrow sidebar it is opened from.
export default function Sheet({title, onClose, editor, children}: Props) {
    // Closing blurs the focused field first so its onBlur saves an edit still being typed.
    const close = () => {
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
        onClose();
    };
    const closeRef = useRef(close);
    closeRef.current = close;

    useEffect(() => {
        openSheets.push(closeRef);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && openSheets[openSheets.length - 1] === closeRef) {
                e.stopPropagation();
                closeRef.current();
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            openSheets.splice(openSheets.indexOf(closeRef), 1);
        };
    }, []);

    return ReactDOM.createPortal(
        <div
            className='ml-root ml-backdrop'
            onClick={(e) => e.target === e.currentTarget && close()}
        >
            <div
                className='ml-sheet'
                role='dialog'
                aria-modal='true'
            >
                <div className='ml-sheet__header'>
                    {!editor && (
                        <button
                            className='ml-icon-btn'
                            onClick={close}
                            aria-label='Close'
                        >
                            {'✕'}
                        </button>
                    )}
                    <div className={`ml-sheet__title${editor ? ' ml-sheet__title--padded' : ''}`}>{title}</div>
                    {editor && (
                        <div className='ml-sheet__actions'>
                            <SaveStatus/>
                            <button
                                className='ml-btn ml-btn--primary'
                                onClick={close}
                            >
                                {'Done'}
                            </button>
                        </div>
                    )}
                </div>
                <div className='ml-sheet__body'>{children}</div>
            </div>
        </div>,
        document.body,
    );
}

// SaveStatus tells people their edits are kept without a save button: a hint until they
// change something, then "Saving…" and "Saved".
function SaveStatus() {
    const {pending, savedAt} = useSaveState();
    const [openedAt] = useState(Date.now);

    let text = 'Changes save automatically';
    if (pending > 0) {
        text = 'Saving…';
    } else if (savedAt >= openedAt) {
        text = '✓ Saved';
    }
    return (
        <span
            className='ml-save-status'
            role='status'
        >
            {text}
        </span>
    );
}
