package command

import (
	"encoding/json"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest/mock"
	"github.com/mattermost/mattermost/server/public/pluginapi"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/BigForkLifter/matterlists/server/store"
)

// fakeStore keeps lists and items in memory; only the methods the command uses work.
type fakeStore struct {
	store.Store
	lists     []*store.List
	columns   map[string][]*store.Column
	items     map[string][]*store.Item
	templates []*store.Template
}

func (f *fakeStore) GetListsForChannel(channelID string) ([]*store.List, error) {
	out := []*store.List{}
	for _, l := range f.lists {
		if l.ChannelID == channelID {
			l.ItemCount = len(f.items[l.ID])
			out = append(out, l)
		}
	}
	return out, nil
}

func (f *fakeStore) CreateList(list *store.List, columns []*store.Column, items []*store.Item) error {
	f.lists = append(f.lists, list)
	f.columns[list.ID] = columns
	f.items[list.ID] = append(f.items[list.ID], items...)
	return nil
}

func (f *fakeStore) GetTemplates(teamID string) ([]*store.Template, error) {
	return f.templates, nil
}

func (f *fakeStore) GetColumns(listID string) ([]*store.Column, error) {
	return f.columns[listID], nil
}

func (f *fakeStore) GetItems(listID string) ([]*store.Item, error) {
	return f.items[listID], nil
}

func (f *fakeStore) CreateItem(item *store.Item) error {
	f.items[item.ListID] = append(f.items[item.ListID], item)
	return nil
}

type env struct {
	api      *plugintest.API
	store    *fakeStore
	handler  Command
	notified []string
}

func setupTest(t *testing.T) *env {
	api := &plugintest.API{}
	t.Cleanup(func() { api.AssertExpectations(t) })
	api.On("RegisterCommand", mock.Anything).Return(nil)
	api.On("HasPermissionToChannel", mock.Anything, mock.Anything, mock.Anything).Return(true).Maybe()

	e := &env{api: api, store: &fakeStore{columns: map[string][]*store.Column{}, items: map[string][]*store.Item{}}}
	client := pluginapi.NewClient(api, &plugintest.Driver{})
	e.handler = NewCommandHandler(client, e.store, func(_, listID, _ string) { e.notified = append(e.notified, listID) }, func(*store.Item, string) {})
	return e
}

func run(t *testing.T, e *env, command string) string {
	t.Helper()
	resp, err := e.handler.Handle(&model.CommandArgs{Command: command, UserId: "user1", ChannelId: "channel1"})
	require.NoError(t, err)
	assert.Equal(t, model.CommandResponseTypeEphemeral, resp.ResponseType)
	return resp.Text
}

func TestListCommandFlow(t *testing.T) {
	e := setupTest(t)

	assert.Contains(t, run(t, e, "/list"), "no lists yet")

	assert.Contains(t, run(t, e, "/list new  Launch *checklist*"), `Launch \*checklist\*`)
	require.Len(t, e.store.lists, 1)
	assert.Equal(t, "Launch *checklist*", e.store.lists[0].Title)

	assert.Contains(t, run(t, e, "/list add 1 Book the venue for 40"), "Added **Book the venue for 40**")
	require.Len(t, e.store.items[e.store.lists[0].ID], 1)
	assert.Equal(t, "Book the venue for 40", e.store.items[e.store.lists[0].ID][0].Title)
	assert.Len(t, e.notified, 2)

	assert.Contains(t, run(t, e, "/list ls"), "1. Launch \\*checklist\\* — 1 item")

	// Give the item a status so show prints the choice name.
	list := e.store.lists[0]
	status := e.store.columns[list.ID][0]
	e.store.items[list.ID][0].Values = map[string]json.RawMessage{status.ID: json.RawMessage(`"` + status.Options.Choices[1].ID + `"`)}
	assert.Contains(t, run(t, e, "/list show 1"), "1. Book the venue for 40 · In progress")
}

func TestListCommandErrors(t *testing.T) {
	e := setupTest(t)

	assert.Contains(t, run(t, e, "/list show 3"), "no list 3")
	assert.Contains(t, run(t, e, "/list add x thing"), "number from `/list ls`")
	assert.Contains(t, run(t, e, "/list new"), "Give the list a title")
	assert.Contains(t, run(t, e, "/list frobnicate"), "Unknown subcommand")
}

func TestListCommandNeedsPermission(t *testing.T) {
	api := &plugintest.API{}
	api.On("RegisterCommand", mock.Anything).Return(nil)
	api.On("HasPermissionToChannel", "user1", "channel1", model.PermissionCreatePost).Return(false)
	s := &fakeStore{columns: map[string][]*store.Column{}, items: map[string][]*store.Item{}}
	h := NewCommandHandler(pluginapi.NewClient(api, &plugintest.Driver{}), s, func(string, string, string) {}, func(*store.Item, string) {})

	resp, err := h.Handle(&model.CommandArgs{Command: "/list new Secret", UserId: "user1", ChannelId: "channel1"})
	require.NoError(t, err)
	assert.Contains(t, resp.Text, "can't add lists")
	assert.Empty(t, s.lists)
}

func TestListNewFromTemplate(t *testing.T) {
	e := setupTest(t)
	e.store.templates = []*store.Template{{
		ID: model.NewId(), TeamID: "team1", Name: "Onboarding",
		Content: store.TemplateContent{
			Columns: []store.TemplateColumn{{Key: "done", Name: "Done", Type: store.ColumnCheckbox}},
			Items:   []store.TemplateItem{{Title: "Create account"}, {Title: "Order laptop"}},
		},
	}}
	newList := func(command string) (*store.List, string) {
		resp, err := e.handler.Handle(&model.CommandArgs{Command: command, UserId: "user1", ChannelId: "channel1", TeamId: "team1"})
		require.NoError(t, err)
		return e.store.lists[len(e.store.lists)-1], resp.Text
	}

	list, text := newList("/list new Packing from checklist")
	assert.Equal(t, "Packing", list.Title)
	assert.Contains(t, text, "from the template **Checklist**")
	require.Len(t, e.store.columns[list.ID], 2)
	assert.Equal(t, "Done", e.store.columns[list.ID][0].Name)

	list, _ = newList("/list new Sam's first week from Onboarding")
	assert.Equal(t, "Sam's first week", list.Title)
	require.Len(t, e.store.items[list.ID], 2)
	assert.Equal(t, "user1", e.store.items[list.ID][0].CreatorID)

	list, text = newList("/list new Notes from the meeting")
	assert.Equal(t, "Notes from the meeting", list.Title, "\"from\" that names no template is part of the title")
	assert.Contains(t, text, "**Tasks**")
	assert.Len(t, e.store.columns[list.ID], 3)
}
