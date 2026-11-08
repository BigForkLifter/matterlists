package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	"github.com/gorilla/mux"
	"github.com/mattermost/mattermost/server/public/model"

	"github.com/BigForkLifter/matterlists/server/store"
)

func (p *Plugin) registerListRoutes(r *mux.Router) {
	r.HandleFunc("/channels/{channel_id:[a-z0-9]{26}}/lists", p.handleGetChannelLists).Methods(http.MethodGet)
	r.HandleFunc("/channels/{channel_id:[a-z0-9]{26}}/lists", p.handleCreateList).Methods(http.MethodPost)

	r.HandleFunc("/lists/{list_id:[a-z0-9]{26}}", p.handleGetList).Methods(http.MethodGet)
	r.HandleFunc("/lists/{list_id:[a-z0-9]{26}}", p.handlePatchList).Methods(http.MethodPatch)
	r.HandleFunc("/lists/{list_id:[a-z0-9]{26}}", p.handleDeleteList).Methods(http.MethodDelete)

	r.HandleFunc("/lists/{list_id:[a-z0-9]{26}}/columns", p.handleCreateColumn).Methods(http.MethodPost)
	r.HandleFunc("/columns/{column_id:[a-z0-9]{26}}", p.handlePatchColumn).Methods(http.MethodPatch)
	r.HandleFunc("/columns/{column_id:[a-z0-9]{26}}", p.handleDeleteColumn).Methods(http.MethodDelete)

	r.HandleFunc("/lists/{list_id:[a-z0-9]{26}}/items", p.handleCreateItem).Methods(http.MethodPost)
	r.HandleFunc("/items/{item_id:[a-z0-9]{26}}", p.handlePatchItem).Methods(http.MethodPatch)
	r.HandleFunc("/items/{item_id:[a-z0-9]{26}}", p.handleDeleteItem).Methods(http.MethodDelete)
	r.HandleFunc("/items/{item_id:[a-z0-9]{26}}/thread", p.handleItemThread).Methods(http.MethodPost)

	r.HandleFunc("/items/{item_id:[a-z0-9]{26}}/columns/{column_id:[a-z0-9]{26}}/photos", p.handleUploadPhoto).Methods(http.MethodPost)
	r.HandleFunc("/photos/{photo_id:[a-z0-9]{26}}", p.handleGetPhoto).Methods(http.MethodGet)
}

// photoUploadPath matches the upload route, which takes larger bodies than the rest.
var photoUploadPath = regexp.MustCompile(`/api/v1/items/[a-z0-9]{26}/columns/[a-z0-9]{26}/photos$`)

// listDetail is everything the webapp needs to render one list.
type listDetail struct {
	List    *store.List     `json:"list"`
	Columns []*store.Column `json:"columns"`
	Items   []*store.Item   `json:"items"`
}

type createListRequest struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	// TemplateID is a built-in template's ID or a saved template's; empty means Tasks.
	TemplateID string `json:"template_id"`

	// Blank skips the default columns. Kept for older webapps; same as template "blank".
	Blank bool `json:"blank"`
}

type patchListRequest struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
}

type columnRequest struct {
	Name      *string              `json:"name"`
	Type      store.ColumnType     `json:"type"`
	Options   *store.ColumnOptions `json:"options"`
	SortOrder *float64             `json:"sort_order"`
}

type itemRequest struct {
	Title        *string                    `json:"title"`
	Values       map[string]json.RawMessage `json:"values"`
	SortOrder    *float64                   `json:"sort_order"`
	SourcePostID string                     `json:"source_post_id"`
}

func (p *Plugin) handleGetChannelLists(w http.ResponseWriter, r *http.Request) {
	channelID := mux.Vars(r)["channel_id"]
	if !p.canRead(userID(r), channelID) {
		writeError(w, r, http.StatusForbidden, "You don't have access to this channel.")
		return
	}
	lists, err := p.store.GetListsForChannel(channelID)
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, lists)
}

func (p *Plugin) handleCreateList(w http.ResponseWriter, r *http.Request) {
	channelID := mux.Vars(r)["channel_id"]
	if !p.canWrite(userID(r), channelID) {
		writeError(w, r, http.StatusForbidden, "You can't add lists to this channel.")
		return
	}
	var req createListRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	title, err := store.ValidateTitle(req.Title, store.MaxTitleLength)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "Title "+err.Error())
		return
	}

	templateID := req.TemplateID
	if templateID == "" {
		templateID = store.DefaultTemplateID
		if req.Blank {
			templateID = store.BlankTemplateID
		}
	}
	template, err := p.templateForList(userID(r), templateID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusBadRequest, "That template no longer exists.")
		return
	}
	if err != nil {
		p.internalError(w, r, err)
		return
	}

	now := model.GetMillis()
	list := &store.List{
		ID: model.NewId(), ChannelID: channelID, Title: title, Description: req.Description,
		CreatorID: userID(r), CreateAt: now, UpdateAt: now,
	}
	// Items from a template aren't announced to people they @mention: they're a
	// starting point, not something anyone wrote to them.
	columns, items := store.Instantiate(template.Content, list.ID, userID(r), now)
	if err = p.store.CreateList(list, columns, items); err != nil {
		p.internalError(w, r, err)
		return
	}
	p.notifyListChanged(channelID, list.ID, userID(r))
	writeJSON(w, r, http.StatusCreated, listDetail{List: list, Columns: columns, Items: items})
}

func (p *Plugin) handleGetList(w http.ResponseWriter, r *http.Request) {
	list, ok := p.listForRequest(w, r, mux.Vars(r)["list_id"], false)
	if !ok {
		return
	}
	columns, err := p.store.GetColumns(list.ID)
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	items, err := p.store.GetItems(list.ID)
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, listDetail{List: list, Columns: columns, Items: items})
}

func (p *Plugin) handlePatchList(w http.ResponseWriter, r *http.Request) {
	list, ok := p.listForRequest(w, r, mux.Vars(r)["list_id"], true)
	if !ok {
		return
	}
	var req patchListRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Title != nil {
		title, err := store.ValidateTitle(*req.Title, store.MaxTitleLength)
		if err != nil {
			writeError(w, r, http.StatusBadRequest, "Title "+err.Error())
			return
		}
		list.Title = title
	}
	if req.Description != nil {
		list.Description = *req.Description
	}
	list.UpdateAt = model.GetMillis()
	if err := p.store.UpdateList(list); err != nil {
		p.storeError(w, r, err)
		return
	}
	p.notifyListChanged(list.ChannelID, list.ID, userID(r))
	writeJSON(w, r, http.StatusOK, list)
}

func (p *Plugin) handleDeleteList(w http.ResponseWriter, r *http.Request) {
	list, ok := p.listForRequest(w, r, mux.Vars(r)["list_id"], true)
	if !ok {
		return
	}
	if err := p.store.DeleteList(list.ID, model.GetMillis()); err != nil {
		p.storeError(w, r, err)
		return
	}
	p.notifyListChanged(list.ChannelID, list.ID, userID(r))
	w.WriteHeader(http.StatusNoContent)
}

func (p *Plugin) handleCreateColumn(w http.ResponseWriter, r *http.Request) {
	list, ok := p.listForRequest(w, r, mux.Vars(r)["list_id"], true)
	if !ok {
		return
	}
	var req columnRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !store.IsValidColumnType(req.Type) {
		writeError(w, r, http.StatusBadRequest, fmt.Sprintf("Unknown column type %q.", req.Type))
		return
	}
	existing, err := p.store.GetColumns(list.ID)
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	if len(existing) >= store.MaxColumnsPerList {
		writeError(w, r, http.StatusBadRequest, fmt.Sprintf("A list can have at most %d columns.", store.MaxColumnsPerList))
		return
	}

	column := &store.Column{ID: model.NewId(), ListID: list.ID, Type: req.Type, CreateAt: model.GetMillis()}
	if err = applyColumnRequest(column, &req); err != nil {
		writeError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	if column.Name == "" {
		writeError(w, r, http.StatusBadRequest, "Column name must not be empty.")
		return
	}
	if err = p.store.CreateColumn(column); err != nil {
		p.internalError(w, r, err)
		return
	}
	p.notifyListChanged(list.ChannelID, list.ID, userID(r))
	writeJSON(w, r, http.StatusCreated, column)
}

func (p *Plugin) handlePatchColumn(w http.ResponseWriter, r *http.Request) {
	column, list, ok := p.columnForRequest(w, r)
	if !ok {
		return
	}
	var req columnRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Type != "" && req.Type != column.Type {
		writeError(w, r, http.StatusBadRequest, "A column's type can't be changed.")
		return
	}
	if err := applyColumnRequest(column, &req); err != nil {
		writeError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	if err := p.store.UpdateColumn(column); err != nil {
		p.storeError(w, r, err)
		return
	}
	p.notifyListChanged(list.ChannelID, list.ID, userID(r))
	writeJSON(w, r, http.StatusOK, column)
}

func (p *Plugin) handleDeleteColumn(w http.ResponseWriter, r *http.Request) {
	column, list, ok := p.columnForRequest(w, r)
	if !ok {
		return
	}
	if err := p.store.DeleteColumn(column); err != nil {
		p.storeError(w, r, err)
		return
	}
	p.notifyListChanged(list.ChannelID, list.ID, userID(r))
	w.WriteHeader(http.StatusNoContent)
}

func applyColumnRequest(column *store.Column, req *columnRequest) error {
	if req.Name != nil {
		name, err := store.ValidateTitle(*req.Name, store.MaxColumnNameLength)
		if err != nil {
			return fmt.Errorf("column name %w", err)
		}
		column.Name = name
	}
	if req.Options != nil {
		opts, err := store.NormalizeOptions(column.Type, *req.Options)
		if err != nil {
			return err
		}
		column.Options = opts
	}
	if req.SortOrder != nil {
		column.SortOrder = *req.SortOrder
	}
	return nil
}

func (p *Plugin) handleCreateItem(w http.ResponseWriter, r *http.Request) {
	list, ok := p.listForRequest(w, r, mux.Vars(r)["list_id"], true)
	if !ok {
		return
	}
	var req itemRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Title == nil {
		writeError(w, r, http.StatusBadRequest, "Title must not be empty.")
		return
	}
	title, err := store.ValidateTitle(*req.Title, store.MaxTextValueLength)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "Title "+err.Error())
		return
	}
	if req.SourcePostID != "" && !p.canReadPost(userID(r), req.SourcePostID) {
		writeError(w, r, http.StatusBadRequest, "The message to add can't be found.")
		return
	}
	columns, err := p.store.GetColumns(list.ID)
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	values, err := store.ApplyValues(columns, nil, req.Values)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, err.Error())
		return
	}

	now := model.GetMillis()
	item := &store.Item{
		ID: model.NewId(), ListID: list.ID, Title: title, Values: values,
		SourcePostID: req.SourcePostID, CreatorID: userID(r), CreateAt: now, UpdateAt: now,
	}
	if req.SortOrder != nil {
		item.SortOrder = *req.SortOrder
	}
	if err = p.store.CreateItem(item); err != nil {
		p.internalError(w, r, err)
		return
	}
	p.notifyListChanged(list.ChannelID, list.ID, userID(r))
	p.itemChanged(columns, nil, item, userID(r))
	writeJSON(w, r, http.StatusCreated, item)
}

func (p *Plugin) handlePatchItem(w http.ResponseWriter, r *http.Request) {
	item, list, ok := p.itemForRequest(w, r)
	if !ok {
		return
	}
	var req itemRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	before := copyItem(item)
	if req.Title != nil {
		title, err := store.ValidateTitle(*req.Title, store.MaxTextValueLength)
		if err != nil {
			writeError(w, r, http.StatusBadRequest, "Title "+err.Error())
			return
		}
		item.Title = title
	}
	// Columns are needed to check values and to find who was assigned or mentioned.
	var columns []*store.Column
	if req.Title != nil || len(req.Values) > 0 {
		var err error
		if columns, err = p.store.GetColumns(list.ID); err != nil {
			p.internalError(w, r, err)
			return
		}
	}
	if len(req.Values) > 0 {
		values, err := store.ApplyValues(columns, item.Values, req.Values)
		if err != nil {
			writeError(w, r, http.StatusBadRequest, err.Error())
			return
		}
		item.Values = values
	}
	if req.SortOrder != nil {
		item.SortOrder = *req.SortOrder
	}
	item.UpdateAt = model.GetMillis()
	if err := p.store.UpdateItem(item); err != nil {
		p.storeError(w, r, err)
		return
	}
	if hasPhotoValues(columns, req.Values) {
		// Delete the photos the patch removed.
		if err := p.store.PrunePhotos(item.ID); err != nil {
			requestLogger(r).WithError(err).Warnf("Failed to delete removed photos")
		}
	}
	p.notifyListChanged(list.ChannelID, list.ID, userID(r))
	if columns != nil {
		p.itemChanged(columns, before, item, userID(r))
	}
	writeJSON(w, r, http.StatusOK, item)
}

func hasPhotoValues(columns []*store.Column, values map[string]json.RawMessage) bool {
	for _, c := range columns {
		if _, ok := values[c.ID]; ok && c.Type == store.ColumnPhotos {
			return true
		}
	}
	return false
}

func (p *Plugin) handleDeleteItem(w http.ResponseWriter, r *http.Request) {
	item, list, ok := p.itemForRequest(w, r)
	if !ok {
		return
	}
	if err := p.store.DeleteItem(item.ID); err != nil {
		p.storeError(w, r, err)
		return
	}
	p.notifyListChanged(list.ChannelID, list.ID, userID(r))
	w.WriteHeader(http.StatusNoContent)
}

// handleItemThread returns the item's discussion thread, starting it with a bot post
// in the list's channel the first time it is asked for.
func (p *Plugin) handleItemThread(w http.ResponseWriter, r *http.Request) {
	item, list, ok := p.itemForRequest(w, r)
	if !ok {
		return
	}
	if item.RootPostID != "" {
		if post, err := p.client.Post.GetPost(item.RootPostID); err == nil && post.DeleteAt == 0 {
			writeJSON(w, r, http.StatusOK, map[string]string{"root_post_id": item.RootPostID})
			return
		}
		// The thread's post was deleted; start a new one in its place.
	}

	starter := "someone"
	if user, err := p.client.User.Get(userID(r)); err == nil {
		starter = "@" + user.Username
	}
	post := &model.Post{
		UserId:    p.botID,
		ChannelId: list.ChannelID,
		Message:   fmt.Sprintf("**%s**\n_Discussion for an item in the list **%s**, started by %s._", postTitle(item.Title), postTitle(list.Title), starter),
	}
	post.AddProp("matterlists_item_id", item.ID)
	post.AddProp("matterlists_list_id", list.ID)
	if err := p.client.Post.CreatePost(post); err != nil {
		p.internalError(w, r, err)
		return
	}

	rootID, err := p.store.SetItemRootPost(item.ID, item.RootPostID, post.Id)
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	if rootID != post.Id {
		// Another request started the thread first; keep theirs.
		_ = p.client.Post.DeletePost(post.Id)
	}
	p.notifyListChanged(list.ChannelID, list.ID, userID(r))
	writeJSON(w, r, http.StatusOK, map[string]string{"root_post_id": rootID})
}
