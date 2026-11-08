# MatterLists

Lightweight lists for Mattermost channels, designed for phone browsers first.

- **Lists belong to a channel.** Members who can read the channel see its lists; members who can post can edit them.
- **Typed columns:** text, number, single select, multi-select, people, date, checkbox, link, and **Created by** (filled in automatically with whoever added the item; can be changed by hand or reset). Columns can be reordered in list settings. New lists start with Status, Assignee and Due.
- **List and Board views.** The board groups items by any single-select column. On phones it scrolls one column per swipe.
- **Discussions use Mattermost threads.** "Start discussion" posts a root message in the channel, so replies, mentions and notifications work as usual.
- **Add to list** from any message's actions menu.
- **Links to lists** (`/<team>/com.otules.matterlists/list/<id>`) go to the list's channel and open it in the sidebar. The 🔗 button copies one or adds it to the channel's bookmarks; ⤢ in the sidebar opens the list as a full page over the channel (‹ closes it).
- **Live updates** over WebSocket.
- **`/list` slash command** (`ls`, `show`, `new`, `add`) for the native mobile app, which can't load plugin UI.

## Where to find it

| Where | How |
|---|---|
| Desktop | App bar icon on the right, or the channel header |
| Phone browser | Channel name ▾ → **Lists**, or main menu → **Lists** |
| Mattermost mobile app | `/list` |

## Requirements

- Mattermost 10.0+
- PostgreSQL. The plugin refuses to activate on MySQL.

The plugin stores data in its own tables (`ml_lists`, `ml_columns`, `ml_items`), which it creates and migrates on activation.

## Development

```bash
make dist                                  # build the bundle in dist/
make deploy                                # upload to a server (set MM_SERVICESETTINGS_SITEURL and MM_ADMIN_TOKEN)
SKIP_DOCKER_TESTS=1 go test ./server/...   # server unit tests
cd webapp && npx jest && npm run lint && npx tsc
```

Integration tests (`server/integration_test.go`) start Mattermost and Postgres in Docker:

```bash
make dist MM_SERVICESETTINGS_ENABLEDEVELOPER=true DEFAULT_GOOS=linux DEFAULT_GOARCH=amd64
go test ./server -run TestListLifecycle
```

## Layout

- `server/store`: schema migrations, SQL, and cell value validation
- `server/api_lists.go`, `server/access.go`: REST API and permission checks
- `server/command`: the `/list` command
- `webapp/src/data.ts`: client cache with optimistic updates
- `webapp/src/components`: sidebar, list and board views, and sheets for editing on phones

## Not built yet

Due-date reminders, drag and drop, CSV import/export, list templates, a full-page view, and limits on items per list.
