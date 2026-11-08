package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/mattermost/mattermost/server/public/model"

	"github.com/BigForkLifter/matterlists/server/store"
)

// A list inherits its channel's access: members who can read the channel can see its
// lists, and members who can post in it can change them.

func (p *Plugin) canRead(userID, channelID string) bool {
	return p.client.User.HasPermissionToChannel(userID, channelID, model.PermissionReadChannel)
}

func (p *Plugin) canWrite(userID, channelID string) bool {
	if !p.client.User.HasPermissionToChannel(userID, channelID, model.PermissionCreatePost) {
		return false
	}
	channel, err := p.client.Channel.Get(channelID)
	return err == nil && channel.DeleteAt == 0
}

func (p *Plugin) canReadPost(userID, postID string) bool {
	post, err := p.client.Post.GetPost(postID)
	return err == nil && post.DeleteAt == 0 && p.canRead(userID, post.ChannelId)
}

// listForRequest loads a list and checks the requesting user's access to it, writing
// the error response itself when it returns false. A list the user can't read is
// reported as missing so its existence isn't revealed.
func (p *Plugin) listForRequest(w http.ResponseWriter, r *http.Request, listID string, write bool) (*store.List, bool) {
	list, err := p.store.GetList(listID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "List not found.")
		return nil, false
	}
	if err != nil {
		p.internalError(w, r, err)
		return nil, false
	}
	if !p.canRead(userID(r), list.ChannelID) {
		writeError(w, r, http.StatusNotFound, "List not found.")
		return nil, false
	}
	if write && !p.canWrite(userID(r), list.ChannelID) {
		writeError(w, r, http.StatusForbidden, "You can't edit lists in this channel.")
		return nil, false
	}
	return list, true
}

func (p *Plugin) columnForRequest(w http.ResponseWriter, r *http.Request) (*store.Column, *store.List, bool) {
	column, err := p.store.GetColumn(mux.Vars(r)["column_id"])
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "Column not found.")
		return nil, nil, false
	}
	if err != nil {
		p.internalError(w, r, err)
		return nil, nil, false
	}
	list, ok := p.listForRequest(w, r, column.ListID, true)
	return column, list, ok
}

func (p *Plugin) itemForRequest(w http.ResponseWriter, r *http.Request) (*store.Item, *store.List, bool) {
	item, err := p.store.GetItem(mux.Vars(r)["item_id"])
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "Item not found.")
		return nil, nil, false
	}
	if err != nil {
		p.internalError(w, r, err)
		return nil, nil, false
	}
	list, ok := p.listForRequest(w, r, item.ListID, true)
	return item, list, ok
}

func userID(r *http.Request) string {
	return r.Header.Get("Mattermost-User-ID")
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid request body.")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		requestLogger(r).WithError(err).Errorf("Failed to write response")
	}
}

// writeError responds with {"error": message}; the message is shown to the user as is.
func writeError(w http.ResponseWriter, r *http.Request, status int, message string) {
	writeJSON(w, r, status, map[string]string{"error": message})
}

func (p *Plugin) internalError(w http.ResponseWriter, r *http.Request, err error) {
	requestLogger(r).WithError(err).Errorf("Request failed")
	writeError(w, r, http.StatusInternalServerError, "Something went wrong. Please try again.")
}

// storeError handles errors from writes to a row that may have been deleted concurrently.
func (p *Plugin) storeError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "It was deleted by someone else.")
		return
	}
	p.internalError(w, r, err)
}
