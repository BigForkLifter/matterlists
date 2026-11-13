import manifest from 'manifest';
import {useEffect, useSyncExternalStore} from 'react';
import type {Store} from 'redux';

import type {GlobalState} from '@mattermost/types/store';

import {ApiError, Client, getSiteURL} from './client';
import {orderBetween, renumber} from './order';
import type {CellValue, Column, Item, List, ListDetail, Template, UserLite} from './types';

// A small cache shared by every MatterLists component. Changes are applied optimistically
// and reconciled with the server's response; WebSocket events trigger a refetch.

type State = {
    channelLists: Record<string, List[] | undefined>;
    lists: Record<string, ListDetail | null | undefined>; // null: deleted or not accessible
    users: Record<string, UserLite | undefined>;
    templates: Record<string, Template[] | undefined>; // by team ID

    // The list open in the sidebar, kept here so it survives the sidebar closing.
    openListId: string | null;

    // The list shown on the full page, a panel over the channel; null when it's closed.
    pageListId: string | null;

    // An item a link asked to open, picked up by the sidebar's list view.
    itemRequest: {listId: string; itemId: string} | null;

    // The message being added to a list from its "..." menu.
    addingPost: {id: string; channelId: string; message: string} | null;
    error: string | null;

    // Requests that change data: how many are in flight, and when the last one succeeded.
    save: {pending: number; savedAt: number};
};

let state: State = {channelLists: {}, lists: {}, users: {}, templates: {}, openListId: null, pageListId: null, itemRequest: null, addingPost: null, error: null, save: {pending: 0, savedAt: 0}};
const listeners = new Set<() => void>();
let hostStore: Store<GlobalState> | null = null;

function setState(patch: Partial<State>) {
    state = {...state, ...patch};
    listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function useStore<T>(select: (s: State) => T): T {
    return useSyncExternalStore(subscribe, () => select(state));
}

export function setHostStore(store: Store<GlobalState>) {
    hostStore = store;
}

export function showError(err: unknown) {
    setState({error: err instanceof Error ? err.message : String(err)});
}

export function clearError() {
    setState({error: null});
}

export const useError = () => useStore((s) => s.error);

export const useOpenListId = () => useStore((s) => s.openListId);

export function openList(listId: string | null) {
    setState({openListId: listId});
}

// The plugin's actions that open and close its sidebar, set once registered.
let sidebar: {show: () => void; hide: () => void} | null = null;

export function setSidebarActions(actions: {show: () => void; hide: () => void}) {
    sidebar = actions;
}

// hideSidebar closes the Lists sidebar, if it is the one open. Mattermost keeps the
// sidebar on plugin pages too, so the full page closes it to avoid showing the list twice.
export function hideSidebar() {
    sidebar?.hide();
}

export const useItemRequest = () => useStore((s) => s.itemRequest);

export function clearItemRequest() {
    setState({itemRequest: null});
}

// listPath is the in-app path of a list's link, which opens the list in its channel's
// sidebar. It uses the list ID, so it keeps working if the list or channel is renamed.
export function listPath(listId: string): string {
    const entities = hostStore?.getState().entities;
    const team = entities?.teams.teams[entities.teams.currentTeamId];
    return `/${team?.name || 'team'}/${manifest.id}/list/${listId}`;
}

export function listURL(listId: string): string {
    return `${getSiteURL() || window.location.origin}${listPath(listId)}`;
}

export type ChannelLocation = {path: string; name: string};

const channelLocations = new Map<string, Promise<ChannelLocation>>();

// channelLocation finds a channel's URL, in whichever team it is, and the name to show
// for it. DMs and group messages have their own URL forms.
export function channelLocation(channelId: string): Promise<ChannelLocation> {
    let location = channelLocations.get(channelId);
    if (!location) {
        location = resolveChannelLocation(channelId);
        location.catch(() => channelLocations.delete(channelId));
        channelLocations.set(channelId, location);
    }
    return location;
}

async function resolveChannelLocation(channelId: string): Promise<ChannelLocation> {
    const channel = await Client.getChannel(channelId);
    const entities = hostStore?.getState().entities;
    let teamName = entities?.teams.teams[entities.teams.currentTeamId]?.name || '';
    if (channel.team_id) {
        teamName = entities?.teams.teams[channel.team_id]?.name || (await Client.getTeam(channel.team_id)).name;
    }

    if (channel.type === 'D') {
        // A DM's name is "<userId>__<userId>"; its URL uses the other person's username.
        const me = entities?.users.currentUserId;
        const otherId = channel.name.split('__').find((id) => id !== me) || me || '';
        const [other] = await Client.getUsersByIds([otherId]);
        rememberUsers([other]);
        return {path: `/${teamName}/messages/@${other.username}`, name: displayName(other)};
    }
    if (channel.type === 'G') {
        return {path: `/${teamName}/messages/${channel.name}`, name: channel.display_name};
    }
    return {path: `/${teamName}/channels/${channel.name}`, name: channel.display_name};
}

// openListInChannel goes to the list's channel and opens the list in the sidebar, and
// itemId in it if given. replace swaps out the current history entry (a link's page)
// instead of adding one, so Back doesn't land on the link and bounce forward again.
export async function openListInChannel(listId: string, channelId: string, opts: {itemId?: string; replace?: boolean} = {}) {
    try {
        const {path} = await channelLocation(channelId);
        setState({openListId: listId, pageListId: null, itemRequest: opts.itemId ? {listId, itemId: opts.itemId} : null});
        const history = (window as HostWindow).WebappUtils?.browserHistory;
        if (opts.replace) {
            history?.replace(path);
        } else {
            history?.push(path);
        }
        sidebar?.show();
    } catch (err) {
        showError(err);
    }
}

export const usePageListId = () => useStore((s) => s.pageListId);

// openListPage shows a list on the full page: a panel laid over the channel rather than a
// route of its own, so Mattermost doesn't unload and rebuild the channel going there and
// back. The Lists sidebar closes so the list isn't shown twice.
export function openListPage(listId: string) {
    hideSidebar();
    setState({pageListId: listId});
}

export function closeListPage() {
    setState({pageListId: null});
}

// showListInSidebar closes the full page and shows its list in the sidebar instead.
export function showListInSidebar(listId: string) {
    setState({openListId: listId, pageListId: null});
    sidebar?.show();
}

// prefetchLists loads lists not fetched yet, so opening one shows it without "Loading…".
export function prefetchLists(listIds: string[]) {
    listIds.filter((id) => state.lists[id] === undefined).forEach(fetchList);
}

// addListBookmark adds the list's link to its channel's bookmarks. It throws, so the share
// sheet can explain a refusal in place.
export function addListBookmark(list: List): Promise<unknown> {
    return Client.createLinkBookmark(list.channel_id, list.title, listURL(list.id));
}

export const useAddingPost = () => useStore((s) => s.addingPost);

export function setAddingPost(post: State['addingPost']) {
    setState({addingPost: post});
}

// Lists in a channel

const inflight = new Map<string, Promise<unknown>>();
const rerun = new Set<string>();

// once runs one fetch per key at a time. A request made while one is in flight runs again
// after it, since the in-flight response may predate the change that prompted the request.
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key);
    if (existing) {
        rerun.add(key);
        return existing as Promise<T>;
    }
    const p = fn().finally(() => {
        inflight.delete(key);
        if (rerun.delete(key)) {
            once(key, fn);
        }
    });
    inflight.set(key, p);
    return p;
}

export function fetchChannelLists(channelId: string) {
    return once(`channel:${channelId}`, async () => {
        try {
            const lists = await Client.getChannelLists(channelId);
            setState({channelLists: {...state.channelLists, [channelId]: lists}});
        } catch (err) {
            showError(err);
        }
    });
}

export function useChannelLists(channelId: string): List[] | undefined {
    const lists = useStore((s) => s.channelLists[channelId]);
    useEffect(() => {
        if (channelId) {
            fetchChannelLists(channelId);
        }
    }, [channelId]);
    return lists;
}

export async function createList(channelId: string, title: string, templateId?: string): Promise<ListDetail | null> {
    try {
        const detail = await Client.createList(channelId, title, templateId);
        setState({lists: {...state.lists, [detail.list.id]: detail}});
        fetchChannelLists(channelId);
        return detail;
    } catch (err) {
        showError(err);
        return null;
    }
}

// Templates

export function currentTeamId(): string {
    return hostStore?.getState().entities.teams.currentTeamId || '';
}

export function fetchTemplates(teamId: string) {
    return once(`templates:${teamId}`, async () => {
        try {
            const templates = await Client.getTemplates(teamId);
            setState({templates: {...state.templates, [teamId]: templates}});
        } catch (err) {
            showError(err);
        }
    });
}

export function useTemplates(teamId: string): Template[] | undefined {
    const templates = useStore((s) => s.templates[teamId]);
    useEffect(() => {
        if (teamId) {
            fetchTemplates(teamId);
        }
    }, [teamId]);
    return templates;
}

// track counts a request toward the "Saving… / ✓ Saved" status and shows its error.
async function track<T>(request: () => Promise<T>): Promise<T | null> {
    setState({save: {...state.save, pending: state.save.pending + 1}});
    try {
        const result = await request();
        setState({save: {pending: state.save.pending - 1, savedAt: Date.now()}});
        return result;
    } catch (err) {
        setState({save: {...state.save, pending: state.save.pending - 1}});
        showError(err);
        return null;
    }
}

// saveTemplate saves a list as a template for everyone in the team. Lists in DMs have
// no team of their own, so they go to the team being viewed.
export async function saveTemplate(listId: string, name: string, description: string, includeItems: boolean): Promise<Template | null> {
    const teamId = currentTeamId();
    const template = await track(() => Client.saveTemplate(listId, {team_id: teamId, name, description, include_items: includeItems}));
    if (template) {
        fetchTemplates(template.team_id);
    }
    return template;
}

export async function patchTemplate(template: Template, patch: {name?: string; description?: string}) {
    const updated = await track(() => Client.patchTemplate(template.id, patch));
    fetchTemplates(template.team_id);
    return updated;
}

export async function deleteTemplate(template: Template) {
    const teamId = template.team_id;
    setState({templates: {...state.templates, [teamId]: state.templates[teamId]?.filter((t) => t.id !== template.id)}});
    await track(() => Client.deleteTemplate(template.id));
    fetchTemplates(teamId);
}

// One list

export function fetchList(listId: string) {
    return once(`list:${listId}`, async () => {
        try {
            const detail = await Client.getList(listId);
            setState({lists: {...state.lists, [listId]: detail}});
            fetchUsers(detail.items.flatMap((it) => personIds(detail, it)));
        } catch (err) {
            if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
                setState({lists: {...state.lists, [listId]: null}});
                return;
            }
            showError(err);
        }
    });
}

export function useList(listId: string): ListDetail | null | undefined {
    const detail = useStore((s) => s.lists[listId]);
    useEffect(() => {
        fetchList(listId);
    }, [listId]);
    return detail;
}

function updateDetail(listId: string, fn: (d: ListDetail) => ListDetail) {
    const detail = state.lists[listId];
    if (detail) {
        setState({lists: {...state.lists, [listId]: fn(detail)}});
    }
}

// mutate applies an optimistic change, runs the request, and refetches on failure so the
// cache matches the server again.
async function mutate<T>(listId: string, optimistic: ((d: ListDetail) => ListDetail) | null, request: () => Promise<T>): Promise<T | null> {
    if (optimistic) {
        updateDetail(listId, optimistic);
    }
    setState({save: {...state.save, pending: state.save.pending + 1}});
    try {
        const result = await request();
        setState({save: {pending: state.save.pending - 1, savedAt: Date.now()}});
        return result;
    } catch (err) {
        setState({save: {...state.save, pending: state.save.pending - 1}});
        showError(err);
        fetchList(listId);
        return null;
    }
}

export const useSaveState = () => useStore((s) => s.save);

export async function patchList(listId: string, patch: {title?: string; description?: string}) {
    const list = await mutate(listId, (d) => ({...d, list: {...d.list, ...patch}}), () => Client.patchList(listId, patch));
    if (list) {
        fetchChannelLists(list.channel_id);
    }
}

export async function deleteList(list: List) {
    try {
        await Client.deleteList(list.id);
        setState({
            lists: {...state.lists, [list.id]: null},
            openListId: state.openListId === list.id ? null : state.openListId,
            pageListId: state.pageListId === list.id ? null : state.pageListId,
        });
        fetchChannelLists(list.channel_id);
    } catch (err) {
        showError(err);
    }
}

export async function addItem(listId: string, title: string, values?: Record<string, CellValue>, sourcePostId?: string) {
    const item = await mutate(listId, null, () => Client.createItem(listId, {title, values, source_post_id: sourcePostId}));
    if (item) {
        updateDetail(listId, (d) => (d.items.some((it) => it.id === item.id) ? d : {...d, items: [...d.items, item]}));
    }
    return item;
}

export async function patchItem(item: Item, patch: {title?: string; values?: Record<string, CellValue | null>; sort_order?: number}) {
    const optimistic = (d: ListDetail): ListDetail => ({
        ...d,
        items: sortItems(d.items.map((it) => (it.id === item.id ? applyItemPatch(it, patch) : it))),
    });
    const updated = await mutate(item.list_id, optimistic, () => Client.patchItem(item.id, patch));
    if (updated) {
        updateDetail(item.list_id, (d) => ({...d, items: sortItems(d.items.map((it) => (it.id === updated.id ? updated : it)))}));
    }
}

// uploadPhoto adds a photo to the end of an item's photos cell. It resolves to false if
// the upload failed; the error is shown.
export async function uploadPhoto(item: Item, columnId: string, photo: Blob): Promise<boolean> {
    const updated = await mutate(item.list_id, null, () => Client.uploadPhoto(item.id, columnId, photo));
    if (updated) {
        updateDetail(item.list_id, (d) => ({...d, items: d.items.map((it) => (it.id === updated.id ? updated : it))}));
    }
    return Boolean(updated);
}

export async function deleteItem(item: Item) {
    await mutate(item.list_id, (d) => ({...d, items: d.items.filter((it) => it.id !== item.id)}), () => Client.deleteItem(item.id));
}

export async function startThread(item: Item): Promise<string | null> {
    try {
        const {root_post_id: rootId} = await Client.startThread(item.id);
        updateDetail(item.list_id, (d) => ({...d, items: d.items.map((it) => (it.id === item.id ? {...it, root_post_id: rootId} : it))}));
        return rootId;
    } catch (err) {
        showError(err);
        return null;
    }
}

type HostWindow = Window & {
    ProductApi?: {selectRhsPost?: (postId: string) => unknown};
    WebappUtils?: {browserHistory?: {push: (path: string) => void; replace: (path: string) => void}};
};

// openThread shows a post's thread in the sidebar, or goes to its permalink on servers
// that don't expose a way to select it.
export function openThread(postId: string) {
    const win = window as HostWindow;
    if (hostStore && win.ProductApi?.selectRhsPost) {
        hostStore.dispatch(win.ProductApi.selectRhsPost(postId) as never);
        return;
    }
    const entities = hostStore?.getState().entities;
    const team = entities?.teams.teams[entities.teams.currentTeamId];
    if (team && win.WebappUtils?.browserHistory) {
        win.WebappUtils.browserHistory.push(`/${team.name}/pl/${postId}`);
    }
}

export async function columnRequest(listId: string, request: () => Promise<unknown>) {
    await mutate(listId, null, request);
    await fetchList(listId);
}

// moveColumn moves a column one place left (-1) or right (1) among the list's columns,
// which sets the order fields appear in on cards and in the item editor.
export function moveColumn(detail: ListDetail, column: Column, direction: -1 | 1) {
    const columns = detail.columns;
    const index = columns.findIndex((c) => c.id === column.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= columns.length) {
        return;
    }
    const neighbour = columns[target];
    const beyond = columns[target + direction];
    const order = beyond ? (neighbour.sort_order + beyond.sort_order) / 2 : neighbour.sort_order + direction;

    const optimistic = (d: ListDetail): ListDetail => ({
        ...d,
        columns: d.columns.
            map((c) => (c.id === column.id ? {...c, sort_order: order} : c)).
            sort((a, b) => a.sort_order - b.sort_order || a.create_at - b.create_at),
    });
    mutate(detail.list.id, optimistic, () => Client.patchColumn(column.id, {sort_order: order}));
}

// moveItem moves an item one place up or down.
export function moveItem(detail: ListDetail, item: Item, direction: -1 | 1) {
    const items = detail.items;
    const index = items.findIndex((it) => it.id === item.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= items.length) {
        return;
    }
    const others = items.filter((it) => it.id !== item.id);
    moveItemTo(detail, item, others[target - 1]?.id, others[target]?.id);
}

// moveItemTo places an item between two others, either of which may be missing (the
// start or end), and can change cell values in the same request, as a drop on another
// board column does. Neighbours are looked up in the whole list, so they can be the
// neighbours shown in a filtered view.
export async function moveItemTo(detail: ListDetail, item: Item, prevId?: string, nextId?: string, values?: Record<string, CellValue | null>) {
    const byId = new Map(detail.items.map((it) => [it.id, it]));
    const order = orderBetween(prevId ? byId.get(prevId)?.sort_order : undefined, nextId ? byId.get(nextId)?.sort_order : undefined);
    if (order !== null) {
        await patchItem(item, values ? {sort_order: order, values} : {sort_order: order});
        return;
    }

    // No room left between the neighbours: renumber the whole list with the item in place.
    const ids = detail.items.map((it) => it.id).filter((id) => id !== item.id);
    let at = nextId ? ids.indexOf(nextId) : -1;
    if (at < 0) {
        at = prevId ? ids.indexOf(prevId) + 1 : ids.length;
    }
    ids.splice(at, 0, item.id);
    const orders = renumber(ids);
    const listId = detail.list.id;
    const renumbered = (d: ListDetail): ListDetail => {
        const items = d.items.map((it) => {
            const moved = it.id === item.id && values ? applyItemPatch(it, {values}) : it;
            return orders[it.id] === undefined ? moved : {...moved, sort_order: orders[it.id]};
        });
        return {...d, items: sortItems(items)};
    };
    await mutate(
        listId,
        renumbered,
        () => Promise.all(ids.map((id) => Client.patchItem(id, id === item.id && values ? {sort_order: orders[id], values} : {sort_order: orders[id]}))),
    );
}

function applyItemPatch(item: Item, patch: {title?: string; values?: Record<string, CellValue | null>; sort_order?: number}): Item {
    const values = {...item.values};
    for (const [k, v] of Object.entries(patch.values || {})) {
        if (v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0)) {
            delete values[k];
        } else {
            values[k] = v;
        }
    }
    return {...item, title: patch.title ?? item.title, sort_order: patch.sort_order ?? item.sort_order, values};
}

function sortItems(items: Item[]): Item[] {
    return [...items].sort((a, b) => a.sort_order - b.sort_order || a.create_at - b.create_at);
}

// Users

function personIds(detail: ListDetail, item: Item): string[] {
    const ids = detail.columns.
        filter((c) => c.type === 'person' || c.type === 'created_by').
        flatMap((c) => (Array.isArray(item.values[c.id]) ? item.values[c.id] as string[] : []));
    if (detail.columns.some((c) => c.type === 'created_by')) {
        ids.push(item.creator_id);
    }
    return ids;
}

export function rememberUsers(users: UserLite[]) {
    const next = {...state.users};
    users.forEach((u) => {
        next[u.id] = u;
    });
    setState({users: next});
}

export async function fetchUsers(ids: string[]) {
    const profiles = hostStore?.getState().entities.users.profiles || {};
    const fromHost: UserLite[] = [];
    const missing: string[] = [];
    for (const id of new Set(ids)) {
        if (state.users[id]) {
            continue;
        }
        if (profiles[id]) {
            fromHost.push(profiles[id]);
        } else {
            missing.push(id);
        }
    }
    if (fromHost.length) {
        rememberUsers(fromHost);
    }
    if (missing.length) {
        try {
            rememberUsers(await Client.getUsersByIds(missing));
        } catch {
            // Unknown users render as "Unknown"; nothing else depends on them.
        }
    }
}

// Usernames already looked up, found or not, so unknown ones aren't asked for again.
const askedUsernames = new Set<string>();

// fetchUsersByUsername loads the people named in @mentions. Usernames are lowercase.
export async function fetchUsersByUsername(usernames: string[]) {
    const known = new Set(Object.values(state.users).map((u) => u?.username));
    const profiles = Object.values(hostStore?.getState().entities.users.profiles || {});
    const fromHost: UserLite[] = [];
    const missing: string[] = [];
    for (const name of new Set(usernames)) {
        if (known.has(name) || askedUsernames.has(name)) {
            continue;
        }
        askedUsernames.add(name);
        const profile = profiles.find((u) => u.username === name);
        if (profile) {
            fromHost.push(profile);
        } else {
            missing.push(name);
        }
    }
    if (fromHost.length) {
        rememberUsers(fromHost);
    }
    if (missing.length) {
        try {
            rememberUsers(await Client.getUsersByUsernames(missing));
        } catch {
            // Mentions of people who can't be found stay as typed.
        }
    }
}

export const useUser = (id: string) => useStore((s) => s.users[id]);

export const useUserByUsername = (username: string) => useStore((s) => Object.values(s.users).find((u) => u?.username === username));

export const useUsers = () => useStore((s) => s.users);

export function displayName(user: UserLite | undefined): string {
    if (!user) {
        return 'Unknown';
    }
    const full = [user.first_name, user.last_name].filter(Boolean).join(' ');
    return user.nickname || full || user.username;
}

// WebSocket

export function handleListUpdated(channelId: string, listId: string) {
    if (state.channelLists[channelId]) {
        fetchChannelLists(channelId);
    }
    if (state.lists[listId]) {
        fetchList(listId);
    }
}

export function handleReconnect() {
    Object.keys(state.channelLists).forEach(fetchChannelLists);
    Object.entries(state.lists).forEach(([id, d]) => d && fetchList(id));
}
