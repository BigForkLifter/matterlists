import {DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors} from '@dnd-kit/core';
import type {DraggableAttributes, DraggableSyntheticListeners} from '@dnd-kit/core';
import {sortableKeyboardCoordinates, useSortable} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import React from 'react';
import ReactDOM from 'react-dom';

// Drag and drop for cards. Move up/down in the item sheet stays as the other way to
// reorder; see the plugin's agent docs on drag and drop.

// On phones a drag starts after a long press, so a plain touch still scrolls the list and
// swipes between board columns. With a mouse it starts after a few pixels of movement, so a
// click still opens the card. From the keyboard, Space picks a card up and drops it
// (Enter opens it, as before), arrows move it, Escape cancels.
export function useCardSensors() {
    return useSensors(
        useSensor(MouseSensor, {activationConstraint: {distance: 6}}),
        useSensor(TouchSensor, {activationConstraint: {delay: 250, tolerance: 8}}),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
            keyboardCodes: {start: ['Space'], cancel: ['Escape'], end: ['Space']},
        }),
    );
}

// Holding a card near the edge scrolls the board or list. The default speed crosses a
// whole phone-width board column in a fraction of a second, so it's slowed down to about
// one column a second, with a narrower edge zone.
export const cardAutoScroll = {acceleration: 2, threshold: {x: 0.12, y: 0.15}};

// A drop is followed by a click on whatever is under the pointer. Cards ignore clicks that
// come right after a drag, so dropping one doesn't also open it.
let lastDragEnd = 0;
export function noteDragEnd() {
    lastDragEnd = Date.now();
}
export function justDragged() {
    return Date.now() - lastDragEnd < 300;
}

export type DragHandle = {
    setNodeRef: (el: HTMLElement | null) => void;
    style: React.CSSProperties;
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
    isDragging: boolean;
};

// SortableCard gives a card its drag handle: the whole card is the handle.
export function SortableCard({id, disabled, children}: {id: string; disabled?: boolean; children: (handle: DragHandle) => React.ReactNode}) {
    const {setNodeRef, transform, transition, attributes, listeners, isDragging} = useSortable({id, disabled});
    return (
        <>
            {children({
                setNodeRef,
                style: {transform: CSS.Translate.toString(transform), transition},
                attributes,
                listeners,
                isDragging,
            })}
        </>
    );
}

// CardOverlay draws the card being dragged above everything. It's portalled to the body so
// it can leave the sidebar or a board column, and wrapped in ml-root for the theme colors.
export function CardOverlay({children}: {children: React.ReactNode}) {
    return ReactDOM.createPortal(
        <div className='ml-root'>
            <DragOverlay
                dropAnimation={{duration: 150, easing: 'ease-out'}}
                zIndex={2000}
            >
                {children}
            </DragOverlay>
        </div>,
        document.body,
    );
}
