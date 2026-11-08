import manifest from 'manifest';
import React from 'react';
import type {Store} from 'redux';

import type {GlobalState} from '@mattermost/types/store';

import type {PluginRegistry} from 'types/mattermost-webapp';

import {setSiteURL} from './client';
import AddToList from './components/add_to_list';
import ListLink from './components/list_link';
import ListPage from './components/list_page';
import RHS from './components/rhs';
import {handleListUpdated, handleReconnect, setAddingPost, setHostStore, setSidebarActions} from './data';

import './styles.css';

const ListIcon = () => (
    <svg
        width='18'
        height='18'
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
        aria-hidden='true'

        // Mattermost's menu styles fill icons; this one is drawn with strokes only.
        style={{fill: 'none'}}
    >
        <rect
            x='3'
            y='4'
            width='18'
            height='16'
            rx='2'
        />
        <path d='M7 9h1M11 9h6M7 13h1M11 13h6M7 17h1M11 17h6'/>
    </svg>
);

type ListUpdatedEvent = {channel_id: string; list_id: string; user_id: string};

export default class Plugin {
    public async initialize(registry: PluginRegistry, store: Store<GlobalState>) {
        setHostStore(store);
        setSiteURL(store.getState().entities.general.config.SiteURL || window.location.origin);

        const {showRHSPlugin, hideRHSPlugin, toggleRHSPlugin} = registry.registerRightHandSidebarComponent(RHS, 'Lists');
        setSidebarActions({
            show: () => store.dispatch(showRHSPlugin),
            hide: () => store.dispatch(hideRHSPlugin),
        });

        // Links to a list: /<team>/<plugin id>/list/<list id>. Mattermost matches the route as
        // a prefix, so the list ID after it reaches the page.
        registry.registerNeedsTeamRoute('/list', ListLink);

        // On desktop this is a channel header (app bar) button; on phone-sized browsers
        // Mattermost moves it into the channel header menu.
        registry.registerChannelHeaderButtonAction(
            <ListIcon/>,
            () => store.dispatch(toggleRHSPlugin),
            'Lists',
            'Lists in this channel',
        );
        registry.registerMainMenuAction('Lists', () => store.dispatch(showRHSPlugin), <ListIcon/>);

        const postById = (postId: string) => store.getState().entities.posts.posts[postId];
        registry.registerPostDropdownMenuAction(
            'Add to list',
            ((postId: string) => {
                const post = postById(postId);
                if (post) {
                    setAddingPost({id: post.id, channelId: post.channel_id, message: post.message});
                }
            }) as () => void,
            ((postId: string) => {
                const post = postById(postId);
                return Boolean(post && !post.type?.startsWith('system_'));
            }) as never,
        );
        registry.registerRootComponent(AddToList);
        registry.registerRootComponent(ListPage);

        registry.registerWebSocketEventHandler<ListUpdatedEvent>(`custom_${manifest.id}_list_updated`, (msg) => {
            handleListUpdated(msg.data.channel_id, msg.data.list_id);
        });
        registry.registerReconnectHandler(handleReconnect);
    }
}

declare global {
    interface Window {
        registerPlugin(pluginId: string, plugin: Plugin): void;
    }
}

window.registerPlugin(manifest.id, new Plugin());
