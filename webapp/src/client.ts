import manifest from 'manifest';

import type {CellValue, Column, Item, List, ListDetail, Template, UserLite} from './types';

let siteURL = '';

export class ApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export function setSiteURL(url: string) {
    siteURL = url.replace(/\/+$/, '');
}

export const getSiteURL = () => siteURL;

function csrfToken(): string {
    const match = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrfToken(),
    };
    let payload: BodyInit | undefined;
    if (body instanceof Blob) {
        headers['Content-Type'] = body.type || 'application/octet-stream';
        payload = body;
    } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const res = await fetch(siteURL + url, {
        method,
        credentials: 'include',
        headers,
        body: payload,
    });
    if (!res.ok) {
        let message = '';
        try {
            const data = await res.json();
            message = data.error || data.message || '';
        } catch {
            // The body wasn't JSON; fall back to a generic message.
        }
        throw new ApiError(message || `Request failed (${res.status}).`, res.status);
    }
    if (res.status === 204) {
        return undefined as T;
    }
    return res.json();
}

const api = (path: string) => `/plugins/${manifest.id}/api/v1${path}`;

export const Client = {
    getChannelLists: (channelId: string) => request<List[]>('GET', api(`/channels/${channelId}/lists`)),
    createList: (channelId: string, title: string, templateId?: string) => request<ListDetail>('POST', api(`/channels/${channelId}/lists`), {title, template_id: templateId}),
    getList: (listId: string) => request<ListDetail>('GET', api(`/lists/${listId}`)),
    patchList: (listId: string, patch: {title?: string; description?: string}) => request<List>('PATCH', api(`/lists/${listId}`), patch),
    deleteList: (listId: string) => request<void>('DELETE', api(`/lists/${listId}`)),

    createColumn: (listId: string, column: Pick<Column, 'name' | 'type'> & {options?: Column['options']}) => request<Column>('POST', api(`/lists/${listId}/columns`), column),
    patchColumn: (columnId: string, patch: {name?: string; options?: Column['options']; sort_order?: number}) => request<Column>('PATCH', api(`/columns/${columnId}`), patch),
    deleteColumn: (columnId: string) => request<void>('DELETE', api(`/columns/${columnId}`)),

    createItem: (listId: string, item: {title: string; values?: Record<string, CellValue | null>; source_post_id?: string}) => request<Item>('POST', api(`/lists/${listId}/items`), item),
    patchItem: (itemId: string, patch: {title?: string; values?: Record<string, CellValue | null>; sort_order?: number}) => request<Item>('PATCH', api(`/items/${itemId}`), patch),
    deleteItem: (itemId: string) => request<void>('DELETE', api(`/items/${itemId}`)),
    startThread: (itemId: string) => request<{root_post_id: string}>('POST', api(`/items/${itemId}/thread`)),

    // uploadPhoto sends the image as the request body and returns the updated item.
    uploadPhoto: (itemId: string, columnId: string, photo: Blob) => request<Item>('POST', api(`/items/${itemId}/columns/${columnId}/photos`), photo),
    photoURL: (photoId: string, size: 'thumb' | 'full' = 'full') => `${siteURL}${api(`/photos/${photoId}`)}${size === 'thumb' ? '?size=thumb' : ''}`,

    getTemplates: (teamId: string) => request<Template[]>('GET', api(`/teams/${teamId}/templates`)),
    saveTemplate: (listId: string, template: {team_id: string; name: string; description: string; include_items: boolean}) => request<Template>('POST', api(`/lists/${listId}/templates`), template),
    patchTemplate: (templateId: string, patch: {name?: string; description?: string}) => request<Template>('PATCH', api(`/templates/${templateId}`), patch),
    deleteTemplate: (templateId: string) => request<void>('DELETE', api(`/templates/${templateId}`)),

    getUsersByIds: (ids: string[]) => request<UserLite[]>('POST', '/api/v4/users/ids', ids),
    getUsersByUsernames: (usernames: string[]) => request<UserLite[]>('POST', '/api/v4/users/usernames', usernames),
    getChannel: (channelId: string) => request<{id: string; team_id: string; name: string; type: string; display_name: string}>('GET', `/api/v4/channels/${channelId}`),
    getTeam: (teamId: string) => request<{id: string; name: string}>('GET', `/api/v4/teams/${teamId}`),
    createLinkBookmark: (channelId: string, name: string, url: string) => request<unknown>('POST', `/api/v4/channels/${channelId}/bookmarks`, {
        display_name: name,
        type: 'link',
        link_url: url,
        emoji: 'clipboard',
    }),
    searchChannelUsers: (teamId: string, channelId: string, term: string) => request<{users: UserLite[]}>(
        'GET',
        `/api/v4/users/autocomplete?in_team=${teamId}&in_channel=${channelId}&name=${encodeURIComponent(term)}&limit=20`,
    ),
    userImageURL: (user: Pick<UserLite, 'id' | 'last_picture_update'>) => `${siteURL}/api/v4/users/${user.id}/image?_=${user.last_picture_update || 0}`,
};
