import {DndContext, closestCenter, closestCorners, pointerWithin, useDroppable} from '@dnd-kit/core';
import type {CollisionDetection, DragEndEvent, DragOverEvent, DragStartEvent} from '@dnd-kit/core';
import {SortableContext, verticalListSortingStrategy} from '@dnd-kit/sortable';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useSelector} from 'react-redux';

import type {GlobalState} from '@mattermost/types/store';

import {CardOverlay, SortableCard, cardAutoScroll, justDragged, noteDragEnd, useCardSensors} from './dnd';
import type {DragHandle} from './dnd';
import {CellDisplay, ChoiceChip, ChoiceSheet, choicesOf} from './fields';
import ItemSheet from './item_sheet';
import {useListMode} from './list_mode';
import ListSettingsSheet from './list_settings_sheet';
import {MentionInput, MentionText} from './mentions';
import ShareSheet from './share_sheet';
import SortSheet from './sort_sheet';

import {addItem, channelLocation, clearItemRequest, closeListPage, displayName, moveItemTo, openList, openListPage, patchItem, showListInSidebar, useItemRequest, useList, useUsers} from '../data';
import type {ChannelLocation} from '../data';
import {moveId, neighbours} from '../order';
import {MANUAL_SORT, formatSort, parseSort, sortItems, sortLabel} from '../sort';
import type {Sort} from '../sort';
import type {Column, Item, ListDetail} from '../types';
import {cellValue} from '../utils';

type View = 'list' | 'board';

// Per-viewer UI preferences, kept in the browser. Storage can be unavailable (private
// windows, blocked site data), in which case the defaults apply.
function loadPref<T extends string>(key: string, fallback: T): T {
    try {
        return (window.localStorage.getItem(`matterlists.${key}`) as T) || fallback;
    } catch {
        return fallback;
    }
}

function savePref(key: string, value: string) {
    try {
        window.localStorage.setItem(`matterlists.${key}`, value);
    } catch {
        // Not saved; the preference lasts until the page reloads.
    }
}

// itemId, when given, is an item to open straight away.
export default function ListView({listId, itemId}: {listId: string; itemId?: string}) {
    const detail = useList(listId);
    const mode = useListMode();

    if (detail === undefined) {
        return <div className='ml-empty'>{'Loading…'}</div>;
    }
    if (detail === null) {
        return (
            <div className='ml-empty'>
                {'This list was deleted or you no longer have access to it.'}
                <button
                    className='ml-btn ml-btn--ghost'
                    onClick={() => (mode === 'page' ? closeListPage() : openList(null))}
                >
                    {mode === 'page' ? 'Close' : 'Back to lists'}
                </button>
            </div>
        );
    }
    return (
        <ListBody
            detail={detail}
            initialItemId={itemId}
        />
    );
}

// PageHeading names the list and its channel on the full page. ‹ closes the page, back to
// the channel; "Show in sidebar" moves the list into the sidebar.
function PageHeading({detail}: {detail: ListDetail}) {
    const [channel, setChannel] = useState<ChannelLocation | null>(null);
    useEffect(() => {
        let cancelled = false;
        channelLocation(detail.list.channel_id).then((loc) => !cancelled && setChannel(loc), () => {});
        return () => {
            cancelled = true;
        };
    }, [detail.list.channel_id]);

    return (
        <>
            <button
                className='ml-icon-btn'
                onClick={closeListPage}
                aria-label='Close full page'
                title='Close'
            >
                {'‹'}
            </button>
            <div className='ml-list__heading'>
                <h2 className='ml-list__title'>{detail.list.title}</h2>
                <button
                    className='ml-list__channel'
                    onClick={() => showListInSidebar(detail.list.id)}
                >
                    {channel ? `in ${channel.name} · Show in sidebar` : 'Show in sidebar'}
                </button>
            </div>
        </>
    );
}

function ListBody({detail, initialItemId}: {detail: ListDetail; initialItemId?: string}) {
    const mode = useListMode();
    const currentUserId = useSelector((s: GlobalState) => s.entities.users.currentUserId);
    const listId = detail.list.id;

    const [view, setViewState] = useState<View>(() => loadPref<View>(`view.${listId}`, 'list'));
    const setView = (v: View) => {
        setViewState(v);
        savePref(`view.${listId}`, v);
    };

    const selectColumns = detail.columns.filter((c) => c.type === 'select');
    const [groupById, setGroupById] = useState<string>(() => loadPref<string>(`group.${listId}`, ''));
    const groupColumn = selectColumns.find((c) => c.id === groupById) || selectColumns[0];

    const [sortPref, setSortPref] = useState<Sort>(() => parseSort(loadPref(`sort.${listId}`, '')));
    const [sortOpen, setSortOpen] = useState(false);
    const setSort = (next: Sort) => {
        setSortPref(next);
        savePref(`sort.${listId}`, formatSort(next));
    };

    // A sort by a column that has since been deleted falls back to manual order.
    const sortName = sortLabel(sortPref, detail.columns);
    const sort = sortName ? sortPref : MANUAL_SORT;
    const users = useUsers();

    const [search, setSearch] = useState('');
    const [mineOnly, setMineOnly] = useState(false);
    const [createdByMe, setCreatedByMe] = useState(false);
    const [openItemId, setOpenItemId] = useState<string | null>(initialItemId || null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const closeItem = useCallback(() => setOpenItemId(null), []);

    // A link to one of this list's items (from the bot's messages) opens it here.
    const itemRequest = useItemRequest();
    useEffect(() => {
        if (itemRequest?.listId === listId) {
            setOpenItemId(itemRequest.itemId);
            clearItemRequest();
        }
    }, [itemRequest, listId]);

    const personColumns = detail.columns.filter((c) => c.type === 'person');
    const createdByColumn = detail.columns.find((c) => c.type === 'created_by');
    const items = useMemo(() => {
        const term = search.trim().toLowerCase();
        const shown = detail.items.filter((it) => {
            if (term && !it.title.toLowerCase().includes(term)) {
                return false;
            }
            if (mineOnly && !personColumns.some((c) => ((it.values[c.id] as string[]) || []).includes(currentUserId))) {
                return false;
            }
            if (createdByMe && createdByColumn && !((cellValue(createdByColumn, it) as string[] | undefined) || []).includes(currentUserId)) {
                return false;
            }
            return true;
        });
        return sortItems(shown, sort, detail.columns, (id) => displayName(users[id]));
    }, [detail.items, detail.columns, search, mineOnly, createdByMe, createdByColumn, personColumns, currentUserId, sort, users]);

    return (
        <div className={mode === 'page' ? 'ml-list ml-list--page' : 'ml-list'}>
            <div className='ml-list__header'>
                {mode === 'page' ? (
                    <PageHeading detail={detail}/>
                ) : (
                    <>
                        <button
                            className='ml-icon-btn'
                            onClick={() => openList(null)}
                            aria-label='Back to lists'
                        >
                            {'‹'}
                        </button>
                        <h2 className='ml-list__title'>{detail.list.title}</h2>
                        <button
                            className='ml-icon-btn'
                            onClick={() => openListPage(listId)}
                            aria-label='Open full page'
                            title='Open full page'
                        >
                            {'⤢'}
                        </button>
                    </>
                )}
                <button
                    className='ml-icon-btn'
                    onClick={() => setShareOpen(true)}
                    aria-label='Share list'
                    title='Copy link or add to channel bookmarks'
                >
                    {'🔗'}
                </button>
                <button
                    className='ml-icon-btn'
                    onClick={() => setSettingsOpen(true)}
                    aria-label='List settings'
                >
                    {'⚙'}
                </button>
            </div>

            <div className='ml-toolbar'>
                <div
                    className='ml-segmented'
                    role='tablist'
                >
                    {(['list', 'board'] as View[]).map((v) => (
                        <button
                            key={v}
                            role='tab'
                            aria-selected={view === v}
                            className={view === v ? 'ml-segmented--on' : ''}
                            onClick={() => setView(v)}
                        >
                            {v === 'list' ? 'List' : 'Board'}
                        </button>
                    ))}
                </div>
                {personColumns.length > 0 && (
                    <button
                        className={`ml-filter${mineOnly ? ' ml-filter--on' : ''}`}
                        aria-pressed={mineOnly}
                        onClick={() => setMineOnly(!mineOnly)}
                    >
                        {'Mine'}
                    </button>
                )}
                {createdByColumn && (
                    <button
                        className={`ml-filter${createdByMe ? ' ml-filter--on' : ''}`}
                        aria-pressed={createdByMe}
                        onClick={() => setCreatedByMe(!createdByMe)}
                    >
                        {'Created by me'}
                    </button>
                )}
                <button
                    className={`ml-filter${sort.key === 'manual' ? '' : ' ml-filter--on'}`}
                    onClick={() => setSortOpen(true)}
                    aria-label={sort.key === 'manual' ? 'Sort: Manual order' : `Sort: ${sortName}, ${sort.dir === 'asc' ? 'ascending' : 'descending'}`}
                >
                    {sort.key === 'manual' ? '⇅ Sort' : `${sort.dir === 'asc' ? '↑' : '↓'} ${sortName}`}
                </button>
                <input
                    className='ml-input ml-input--search'
                    type='search'
                    placeholder='Search'
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
            </div>

            {view === 'board' && selectColumns.length > 1 && groupColumn && (
                <label className='ml-group-by'>
                    {'Group by '}
                    <select
                        value={groupColumn.id}
                        onChange={(e) => {
                            setGroupById(e.target.value);
                            savePref(`group.${listId}`, e.target.value);
                        }}
                    >
                        {selectColumns.map((c) => (
                            <option
                                key={c.id}
                                value={c.id}
                            >
                                {c.name}
                            </option>
                        ))}
                    </select>
                </label>
            )}

            <div className='ml-list__content'>
                {view === 'board' && groupColumn ? (
                    <Board
                        detail={detail}
                        items={items}
                        groupColumn={groupColumn}
                        manual={sort.key === 'manual'}
                        onOpen={setOpenItemId}
                    />
                ) : (
                    <>
                        {view === 'board' && (
                            <div className='ml-hint'>{'Add a single-select column in list settings to use the board.'}</div>
                        )}
                        <Cards
                            detail={detail}
                            items={items}
                            statusColumn={groupColumn}
                            manual={sort.key === 'manual'}
                            onOpen={setOpenItemId}
                        />
                    </>
                )}
            </div>

            {!(view === 'board' && groupColumn) && (
                <QuickAdd
                    listId={listId}
                    channelId={detail.list.channel_id}
                    defaults={{}}
                />
            )}

            {openItemId && (
                <ItemSheet
                    detail={detail}
                    itemId={openItemId}
                    manualOrder={sort.key === 'manual'}
                    onClose={closeItem}
                />
            )}
            {sortOpen && (
                <SortSheet
                    sort={sort}
                    columns={detail.columns}
                    onChange={setSort}
                    onClose={() => setSortOpen(false)}
                />
            )}
            {shareOpen && (
                <ShareSheet
                    list={detail.list}
                    onClose={() => setShareOpen(false)}
                />
            )}
            {settingsOpen && (
                <ListSettingsSheet
                    detail={detail}
                    onClose={() => setSettingsOpen(false)}
                />
            )}
        </div>
    );
}

type CardsProps = {
    detail: ListDetail;
    items: Item[];
    statusColumn?: Column;

    // Cards can be dragged into a new order only in manual order; a sort by a field
    // decides the order itself.
    manual: boolean;
    onOpen: (id: string) => void;
};

function Cards({detail, items, statusColumn, manual, onOpen}: CardsProps) {
    const sensors = useCardSensors();
    const [activeId, setActiveId] = useState<string | null>(null);
    const ids = useMemo(() => items.map((it) => it.id), [items]);

    if (!detail.items.length) {
        return <div className='ml-empty'>{'No items yet. Add the first one below.'}</div>;
    }
    if (!items.length) {
        return <div className='ml-empty'>{'No items match.'}</div>;
    }

    const onDragEnd = ({active, over}: DragEndEvent) => {
        setActiveId(null);
        noteDragEnd();
        const item = items.find((it) => it.id === active.id);
        if (!item || !over || over.id === active.id) {
            return;
        }
        const order = moveId(ids, ids.indexOf(item.id), ids.indexOf(String(over.id)));
        const {prevId, nextId} = neighbours(order, item.id);
        moveItemTo(detail, item, prevId, nextId);
    };
    const active = activeId ? items.find((it) => it.id === activeId) : undefined;

    return (
        <DndContext
            sensors={sensors}
            autoScroll={cardAutoScroll}
            collisionDetection={closestCenter}
            onDragStart={({active: a}) => setActiveId(String(a.id))}
            onDragEnd={onDragEnd}
            onDragCancel={() => {
                setActiveId(null);
                noteDragEnd();
            }}
        >
            <SortableContext
                items={ids}
                strategy={verticalListSortingStrategy}
                disabled={!manual}
            >
                <ul className='ml-cards'>
                    {items.map((it) => (
                        <SortableCard
                            key={it.id}
                            id={it.id}
                            disabled={!manual}
                        >
                            {(handle) => (
                                <li>
                                    <Card
                                        detail={detail}
                                        item={it}
                                        statusColumn={statusColumn}
                                        onOpen={onOpen}
                                        handle={manual ? handle : undefined}
                                    />
                                </li>
                            )}
                        </SortableCard>
                    ))}
                </ul>
            </SortableContext>
            <CardOverlay>
                {active && (
                    <Card
                        detail={detail}
                        item={active}
                        statusColumn={statusColumn}
                        onOpen={onOpen}
                        overlay={true}
                    />
                )}
            </CardOverlay>
        </DndContext>
    );
}

type CardProps = {
    detail: ListDetail;
    item: Item;
    statusColumn?: Column;
    onOpen: (id: string) => void;

    // handle makes the card draggable; overlay is the copy that follows the pointer.
    handle?: DragHandle;
    overlay?: boolean;
};

const DONE_NAMES = /^(done|complete|completed|closed|finished)$/i;

function Card({detail, item, statusColumn, onOpen, handle, overlay}: CardProps) {
    const [pickingStatus, setPickingStatus] = useState(false);
    const status = statusColumn && choicesOf(statusColumn).find((c) => c.id === item.values[statusColumn.id]);
    const isDone = Boolean(status && DONE_NAMES.test(status.name));

    return (
        <div
            ref={handle?.setNodeRef}
            style={handle?.style}
            {...handle?.attributes}
            {...handle?.listeners}
            className={'ml-card' +
                (isDone ? ' ml-card--done' : '') +
                (handle ? ' ml-card--draggable' : '') +
                (handle?.isDragging ? ' ml-card--placeholder' : '') +
                (overlay ? ' ml-card--overlay' : '')}
            role='button'
            tabIndex={overlay ? -1 : 0}
            onClick={() => !justDragged() && onOpen(item.id)}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    onOpen(item.id);
                    return;
                }
                handle?.listeners?.onKeyDown?.(e);
            }}
        >
            <div className='ml-card__top'>
                <div className='ml-card__title'>
                    <MentionText text={item.title}/>
                </div>
                {statusColumn && (
                    <button
                        className='ml-card__status'
                        aria-label={`${statusColumn.name}: ${status ? status.name : 'None'}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            setPickingStatus(true);
                        }}
                    >
                        {status ? <ChoiceChip choice={status}/> : <span className='ml-chip ml-chip--empty'>{statusColumn.name}</span>}
                    </button>
                )}
            </div>
            <div className='ml-card__meta'>
                {detail.columns.
                    filter((c) => c.id !== statusColumn?.id).
                    map((c) => (
                        <CellDisplay
                            key={c.id}
                            column={c}
                            value={cellValue(c, item)}
                            done={isDone}
                        />
                    ))}
                {item.root_post_id && <span className='ml-chip ml-chip--plain'>{'💬'}</span>}
            </div>
            {pickingStatus && statusColumn && (
                <div onClick={(e) => e.stopPropagation()}>
                    <ChoiceSheet
                        column={statusColumn}
                        value={item.values[statusColumn.id] as string | undefined}
                        onPick={(id) => {
                            setPickingStatus(false);
                            patchItem(item, {values: {[statusColumn.id]: id}});
                        }}
                        onClose={() => setPickingStatus(false)}
                    />
                </div>
            )}
        </div>
    );
}

type BoardProps = {
    detail: ListDetail;
    items: Item[];
    groupColumn: Column;

    // In manual order a drop also places the card among the column's cards; under a sort
    // by a field it only changes the card's group.
    manual: boolean;
    onOpen: (id: string) => void;
};

// Board containers are keyed by group so an empty column can still take a drop; "" is
// "No <column>".
const groupKey = (choiceId: string) => `group:${choiceId}`;
const choiceOfKey = (key: string) => key.slice('group:'.length);

// boardCollisions picks what a dragged card is over: a card under the pointer, else the
// column under the pointer (so an empty column takes a drop), else, for keyboard drags,
// the nearest by corners. Corners alone lose an empty column to the cards beside it.
const boardCollisions: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    if (hits.length) {
        const cards = hits.filter((c) => !String(c.id).startsWith('group:'));
        return cards.length ? cards : hits;
    }
    return closestCorners(args);
};

// Board shows one column per choice, plus "None". On phones the columns scroll sideways
// one at a time. Cards move between them by dragging, or with the status button on each
// card.
function Board({detail, items, groupColumn, manual, onOpen}: BoardProps) {
    const sensors = useCardSensors();
    const groups = [...choicesOf(groupColumn).map((c) => ({id: c.id, choice: c})), {id: '', choice: undefined}];
    const valueOf = (it: Item) => (it.values[groupColumn.id] as string | undefined) || '';

    const shown = useMemo(() => {
        const byGroup: Record<string, string[]> = {};
        for (const g of choicesOf(groupColumn)) {
            byGroup[groupKey(g.id)] = [];
        }
        byGroup[groupKey('')] = [];
        for (const it of items) {
            const key = groupKey((it.values[groupColumn.id] as string | undefined) || '');
            (byGroup[key] ??= []).push(it.id);
        }
        return byGroup;
    }, [items, groupColumn]);

    // While dragging, the card is shown where it would land, which may be another column.
    // leftMargin holds the centred full-page board still while "No <column>" is added.
    const [drag, setDrag] = useState<{activeId: string; containers: Record<string, string[]>; leftMargin: number} | null>(null);
    const boardRef = useRef<HTMLDivElement>(null);
    const containers = drag?.containers ?? shown;
    const containerOf = (id: string) => (id in containers ? id : Object.keys(containers).find((k) => containers[k].includes(id)));

    const onDragStart = ({active}: DragStartEvent) => {
        const first = boardRef.current?.firstElementChild;
        const leftMargin = first ? parseFloat(window.getComputedStyle(first).marginLeft) || 0 : 0;
        setDrag({activeId: String(active.id), containers: shown, leftMargin});
    };

    const onDragOver = ({active, over}: DragOverEvent) => {
        if (!drag || !over) {
            return;
        }
        const from = containerOf(String(active.id));
        const to = containerOf(String(over.id));
        if (!from || !to || from === to) {
            return;
        }
        const target = containers[to];
        const overIndex = target.indexOf(String(over.id));
        const at = overIndex < 0 ? target.length : overIndex;
        setDrag({
            ...drag,
            containers: {
                ...containers,
                [from]: containers[from].filter((id) => id !== active.id),
                [to]: [...target.slice(0, at), String(active.id), ...target.slice(at)],
            },
        });
    };

    const onDragEnd = ({active, over}: DragEndEvent) => {
        const current = containers;
        setDrag(null);
        noteDragEnd();
        const item = items.find((it) => it.id === active.id);
        const to = containerOf(String(active.id));
        if (!item || !over || !to) {
            return;
        }
        let ids = current[to];
        const overIndex = ids.indexOf(String(over.id));
        if (overIndex >= 0 && over.id !== active.id) {
            ids = moveId(ids, ids.indexOf(item.id), overIndex);
        }
        const choiceId = choiceOfKey(to);
        const values = choiceId === valueOf(item) ? undefined : {[groupColumn.id]: choiceId || null};
        if (!manual) {
            if (values) {
                patchItem(item, {values});
            }
            return;
        }
        const {prevId, nextId} = neighbours(ids, item.id);
        const before = neighbours(shown[groupKey(valueOf(item))] || [], item.id);
        if (!values && before.prevId === prevId && before.nextId === nextId) {
            return;
        }
        moveItemTo(detail, item, prevId, nextId, values);
    };

    const active = drag ? items.find((it) => it.id === drag.activeId) : undefined;
    return (
        <DndContext
            sensors={sensors}
            autoScroll={cardAutoScroll}
            collisionDetection={boardCollisions}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={() => {
                setDrag(null);
                noteDragEnd();
            }}
        >
            <div
                ref={boardRef}
                className={drag ? 'ml-board ml-board--dragging' : 'ml-board'}
            >
                {groups.map(({id, choice}, index) => {
                    const key = groupKey(id);
                    const groupIds = containers[key] || [];

                    // "No <column>" appears when it has cards, and during a drag as a place to
                    // clear the value.
                    if (!choice && !groupIds.length && !drag) {
                        return null;
                    }
                    return (
                        <BoardColumn
                            key={key}
                            id={key}
                            style={drag && index === 0 ? {marginLeft: drag.leftMargin} : undefined}
                            header={choice ? <ChoiceChip choice={choice}/> : <span className='ml-muted'>{'No '}{groupColumn.name}</span>}
                            count={groupIds.length}
                        >
                            <SortableContext
                                id={key}
                                items={groupIds}
                                strategy={verticalListSortingStrategy}
                            >
                                <div className='ml-board__items'>
                                    {groupIds.map((itemId) => {
                                        const it = items.find((i) => i.id === itemId);
                                        if (!it) {
                                            return null;
                                        }
                                        return (
                                            <SortableCard
                                                key={it.id}
                                                id={it.id}
                                            >
                                                {(handle) => (
                                                    <Card
                                                        detail={detail}
                                                        item={it}
                                                        statusColumn={groupColumn}
                                                        onOpen={onOpen}
                                                        handle={handle}
                                                    />
                                                )}
                                            </SortableCard>
                                        );
                                    })}
                                </div>
                            </SortableContext>
                            {choice && (
                                <QuickAdd
                                    listId={detail.list.id}
                                    channelId={detail.list.channel_id}
                                    defaults={{[groupColumn.id]: choice.id}}
                                    compact={true}
                                />
                            )}
                        </BoardColumn>
                    );
                })}
            </div>
            <CardOverlay>
                {active && (
                    <Card
                        detail={detail}
                        item={active}
                        statusColumn={groupColumn}
                        onOpen={onOpen}
                        overlay={true}
                    />
                )}
            </CardOverlay>
        </DndContext>
    );
}

// BoardColumn is a drop target, so a card can be dropped into an empty column or below
// the last card.
function BoardColumn({id, style, header, count, children}: {id: string; style?: React.CSSProperties; header: React.ReactNode; count: number; children: React.ReactNode}) {
    const {setNodeRef, isOver} = useDroppable({id});
    return (
        <section
            ref={setNodeRef}
            style={style}
            className={isOver ? 'ml-board__col ml-board__col--over' : 'ml-board__col'}
        >
            <header className='ml-board__col-header'>
                {header}
                <span className='ml-muted'>{count}</span>
            </header>
            {children}
        </section>
    );
}

function QuickAdd({listId, channelId, defaults, compact}: {listId: string; channelId: string; defaults: Record<string, string>; compact?: boolean}) {
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = title.trim();
        if (!trimmed || busy) {
            return;
        }
        setBusy(true);
        const item = await addItem(listId, trimmed, defaults);
        setBusy(false);
        if (item) {
            setTitle('');
        }
    };

    return (
        <form
            className={compact ? 'ml-quick-add ml-quick-add--compact' : 'ml-quick-add'}
            onSubmit={submit}
        >
            <MentionInput
                channelId={channelId}
                className='ml-input'
                placeholder='+ Add item'
                value={title}
                enterKeyHint='done'
                onChange={setTitle}
            />
            {title.trim() && (
                <button
                    className='ml-btn ml-btn--primary'
                    type='submit'
                    disabled={busy}
                >
                    {'Add'}
                </button>
            )}
        </form>
    );
}
