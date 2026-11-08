package main

import (
	"net/http"
	"sync"

	"github.com/gorilla/mux"
	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
	"github.com/mattermost/mattermost/server/public/pluginapi"
	"github.com/pkg/errors"

	"github.com/BigForkLifter/matterlists/server/command"
	"github.com/BigForkLifter/matterlists/server/store"
)

// Plugin implements the interface expected by the Mattermost server to communicate between the server and plugin processes.
type Plugin struct {
	plugin.MattermostPlugin

	// store persists lists, columns and items in the server's database.
	store store.Store

	// client is the Mattermost server API client.
	client *pluginapi.Client

	// botID is the user that posts item threads and sends notices.
	botID string

	// notifier holds DMs to people assigned or mentioned, until they are due.
	notifier *notifier

	// commandClient is the client used to register and execute slash commands.
	commandClient command.Command

	// router is the HTTP router for handling API requests.
	router *mux.Router

	// configurationLock synchronizes access to the configuration.
	configurationLock sync.RWMutex

	// configuration is the active plugin configuration. Consult getConfiguration and
	// setConfiguration for usage.
	configuration *configuration
}

// OnActivate is invoked when the plugin is activated. If an error is returned, the plugin will be deactivated.
func (p *Plugin) OnActivate() error {
	p.client = pluginapi.NewClient(p.API, p.Driver)

	if driver := p.client.Store.DriverName(); driver != model.DatabaseDriverPostgres {
		return errors.Errorf("MatterLists requires PostgreSQL, but the server uses %q", driver)
	}
	db, err := p.client.Store.GetMasterDB()
	if err != nil {
		return errors.Wrap(err, "failed to get database")
	}
	if err = store.Migrate(db); err != nil {
		return errors.Wrap(err, "failed to migrate database")
	}
	p.store = store.NewSQLStore(db)

	p.botID, err = p.client.Bot.EnsureBot(&model.Bot{
		Username:    "matterlists",
		DisplayName: "MatterLists",
		Description: "Starts threads for list items and tells people when they're assigned or mentioned.",
	})
	if err != nil {
		return errors.Wrap(err, "failed to ensure bot")
	}

	p.notifier = newNotifier()
	p.commandClient = command.NewCommandHandler(p.client, p.store, p.notifyListChanged, func(item *store.Item, actorID string) {
		p.itemChanged(nil, nil, item, actorID)
	})

	p.router = p.initRouter()

	return nil
}

// OnDeactivate is invoked when the plugin is deactivated.
func (p *Plugin) OnDeactivate() error {
	if p.notifier != nil {
		p.notifier.stop()
	}
	if p.client != nil {
		if err := p.client.Store.Close(); err != nil {
			p.API.LogError("Failed to close database", "err", err)
		}
	}
	return nil
}

// This will execute the commands that were registered in the NewCommandHandler function.
func (p *Plugin) ExecuteCommand(c *plugin.Context, args *model.CommandArgs) (*model.CommandResponse, *model.AppError) {
	response, err := p.commandClient.Handle(args)
	if err != nil {
		return nil, model.NewAppError("ExecuteCommand", "plugin.command.execute_command.app_error", nil, err.Error(), http.StatusInternalServerError)
	}
	return response, nil
}

// wsEventListUpdated tells clients viewing a channel's lists to refetch. The webapp
// receives it as "custom_<plugin id>_list_updated".
const wsEventListUpdated = "list_updated"

// notifyListChanged broadcasts that a list (or the set of lists in a channel) changed.
func (p *Plugin) notifyListChanged(channelID, listID, actorID string) {
	p.API.PublishWebSocketEvent(wsEventListUpdated, map[string]any{
		"channel_id": channelID,
		"list_id":    listID,
		"user_id":    actorID,
	}, &model.WebsocketBroadcast{ChannelId: channelID})
}

// See https://developers.mattermost.com/extend/plugins/server/reference/
