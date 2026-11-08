import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useSelector} from 'react-redux';

import type {GlobalState} from '@mattermost/types/store';

import {CellDisplay, ChoiceChip, ChoiceSheet, choicesOf} from './fields';
import ItemSheet from './item_sheet';
import {useListMode} from './list_mode';
import ListSettingsSheet from './list_settings_sheet';
import {MentionInput, MentionText} from './mentions';
import ShareSheet from './share_sheet';
import SortSheet from './sort_sheet';

import {addItem, channelLocation, clearItemRequest, closeListPage, displayName, openList, openListPage, patchItem, showListInSidebar, useItemRequest, useList, useUsers} from '../data';
import type {ChannelLocation} from '../data';
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
    onOpen: (id: string) => void;
};

function Cards({detail, items, statusColumn, onOpen}: CardsProps) {
    if (!detail.items.length) {
        return <div className='ml-empty'>{'No items yet. Add the first one below.'}</div>;
    }
    if (!items.length) {
        return <div className='ml-empty'>{'No items match.'}</div>;
    }
    return (
        <ul className='ml-cards'>
            {items.map((it) => (
                <li key={it.id}>
                    <Card
                        detail={detail}
                        item={it}
                        statusColumn={statusColumn}
                        onOpen={onOpen}
                    />
                </li>
            ))}
        </ul>
    );
}

type CardProps = {
    detail: ListDetail;
    item: Item;
    statusColumn?: Column;
    onOpen: (id: string) => void;
};

const DONE_NAMES = /^(done|complete|completed|closed|finished)$/i;

function Card({detail, item, statusColumn, onOpen}: CardProps) {
    const [pickingStatus, setPickingStatus] = useState(false);
    const status = statusColumn && choicesOf(statusColumn).find((c) => c.id === item.values[statusColumn.id]);
    const isDone = Boolean(status && DONE_NAMES.test(status.name));

    return (
        <div
            className={`ml-card${isDone ? ' ml-card--done' : ''}`}
            role='button'
            tabIndex={0}
            onClick={() => onOpen(item.id)}
            onKeyDown={(e) => e.key === 'Enter' && onOpen(item.id)}
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
    onOpen: (id: string) => void;
};

// Board shows one column per choice, plus "None". On phones the columns scroll sideways
// one at a time; items move between them with the status button on each card.
function Board({detail, items, groupColumn, onOpen}: BoardProps) {
    const groups = [...choicesOf(groupColumn).map((c) => ({id: c.id, choice: c})), {id: '', choice: undefined}];
    return (
        <div className='ml-board'>
            {groups.map(({id, choice}) => {
                const groupItems = items.filter((it) => ((it.values[groupColumn.id] as string | undefined) || '') === id);
                if (!choice && !groupItems.length) {
                    return null;
                }
                return (
                    <section
                        key={id || 'none'}
                        className='ml-board__col'
                    >
                        <header className='ml-board__col-header'>
                            {choice ? <ChoiceChip choice={choice}/> : <span className='ml-muted'>{'No '}{groupColumn.name}</span>}
                            <span className='ml-muted'>{groupItems.length}</span>
                        </header>
                        <div className='ml-board__items'>
                            {groupItems.map((it) => (
                                <Card
                                    key={it.id}
                                    detail={detail}
                                    item={it}
                                    statusColumn={groupColumn}
                                    onOpen={onOpen}
                                />
                            ))}
                        </div>
                        {choice && (
                            <QuickAdd
                                listId={detail.list.id}
                                channelId={detail.list.channel_id}
                                defaults={{[groupColumn.id]: choice.id}}
                                compact={true}
                            />
                        )}
                    </section>
                );
            })}
        </div>
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
