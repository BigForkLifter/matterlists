package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gorilla/mux"
	"github.com/mattermost/mattermost/server/public/model"

	"github.com/BigForkLifter/matterlists/server/store"
)

func (p *Plugin) registerTemplateRoutes(r *mux.Router) {
	r.HandleFunc("/teams/{team_id:[a-z0-9]{26}}/templates", p.handleGetTemplates).Methods(http.MethodGet)
	r.HandleFunc("/lists/{list_id:[a-z0-9]{26}}/templates", p.handleSaveTemplate).Methods(http.MethodPost)
	r.HandleFunc("/templates/{template_id:[a-z0-9]{26}}", p.handlePatchTemplate).Methods(http.MethodPatch)
	r.HandleFunc("/templates/{template_id:[a-z0-9]{26}}", p.handleDeleteTemplate).Methods(http.MethodDelete)
}

// templateColumnSummary describes a column for the template picker.
type templateColumnSummary struct {
	Name string           `json:"name"`
	Type store.ColumnType `json:"type"`
}

// templateSummary is a template as the webapp sees it: enough to show and pick it.
type templateSummary struct {
	ID          string                  `json:"id"`
	TeamID      string                  `json:"team_id"`
	Name        string                  `json:"name"`
	Description string                  `json:"description"`
	Builtin     bool                    `json:"builtin"`
	CreatorID   string                  `json:"creator_id"`
	CreateAt    int64                   `json:"create_at"`
	Columns     []templateColumnSummary `json:"columns"`
	ItemCount   int                     `json:"item_count"`

	// CanEdit is whether the requesting user may rename or delete it.
	CanEdit bool `json:"can_edit"`
}

func (p *Plugin) summarize(t *store.Template, userID string) templateSummary {
	s := templateSummary{
		ID: t.ID, TeamID: t.TeamID, Name: t.Name, Description: t.Description, Builtin: t.Builtin,
		CreatorID: t.CreatorID, CreateAt: t.CreateAt, Columns: []templateColumnSummary{}, ItemCount: len(t.Content.Items),
	}
	for _, c := range t.Content.Columns {
		s.Columns = append(s.Columns, templateColumnSummary{Name: c.Name, Type: c.Type})
	}
	if !t.Builtin {
		s.CanEdit = p.canEditTemplate(userID, t)
	}
	return s
}

// inTeam checks membership itself: PermissionViewTeam is also granted on open teams
// to people who haven't joined them.
func (p *Plugin) inTeam(userID, teamID string) bool {
	member, err := p.client.Team.GetMember(teamID, userID)
	return err == nil && member != nil && member.DeleteAt == 0
}

// canEditTemplate: whoever saved a template, and team admins, may rename or delete it.
func (p *Plugin) canEditTemplate(userID string, t *store.Template) bool {
	return t.CreatorID == userID || p.client.User.HasPermissionToTeam(userID, t.TeamID, model.PermissionManageTeam)
}

// templateForList finds the template a new list starts from: a built-in one by ID, or
// one saved in a team the user belongs to. Unknown and inaccessible IDs are not found.
func (p *Plugin) templateForList(userID, id string) (*store.Template, error) {
	if t := store.BuiltinTemplate(id); t != nil {
		return t, nil
	}
	if !model.IsValidId(id) {
		return nil, store.ErrNotFound
	}
	t, err := p.store.GetTemplate(id)
	if err != nil {
		return nil, err
	}
	if !p.inTeam(userID, t.TeamID) {
		return nil, store.ErrNotFound
	}
	return t, nil
}

func (p *Plugin) handleGetTemplates(w http.ResponseWriter, r *http.Request) {
	teamID := mux.Vars(r)["team_id"]
	if !p.inTeam(userID(r), teamID) {
		writeError(w, r, http.StatusForbidden, "You aren't in this team.")
		return
	}
	saved, err := p.store.GetTemplates(teamID)
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	out := make([]templateSummary, 0, len(store.BuiltinTemplates)+len(saved))
	for _, t := range store.BuiltinTemplates {
		out = append(out, p.summarize(t, userID(r)))
	}
	for _, t := range saved {
		out = append(out, p.summarize(t, userID(r)))
	}
	writeJSON(w, r, http.StatusOK, out)
}

type saveTemplateRequest struct {
	TeamID       string `json:"team_id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	IncludeItems bool   `json:"include_items"`
}

// validateTemplateText checks a template's name and description. A non-empty problem
// is shown to the user.
func validateTemplateText(name, description string) (string, string, string) {
	name, err := store.ValidateTitle(name, store.MaxTitleLength)
	if err != nil {
		return "", "", "Name " + err.Error() + "."
	}
	description = strings.TrimSpace(description)
	if utf8.RuneCountInString(description) > store.MaxTemplateDescription {
		return "", "", fmt.Sprintf("Description must be at most %d characters.", store.MaxTemplateDescription)
	}
	return name, description, ""
}

// handleSaveTemplate saves a list's columns, and optionally its items, as a template
// for everyone in a team. Lists in DMs and group messages have no team, so the
// webapp sends the team the user is in.
func (p *Plugin) handleSaveTemplate(w http.ResponseWriter, r *http.Request) {
	list, ok := p.listForRequest(w, r, mux.Vars(r)["list_id"], false)
	if !ok {
		return
	}
	var req saveTemplateRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	channel, err := p.client.Channel.Get(list.ChannelID)
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	if channel.TeamId != "" {
		req.TeamID = channel.TeamId
	}
	if !model.IsValidId(req.TeamID) || !p.inTeam(userID(r), req.TeamID) {
		writeError(w, r, http.StatusForbidden, "You aren't in this team.")
		return
	}
	name, description, problem := validateTemplateText(req.Name, req.Description)
	if problem != "" {
		writeError(w, r, http.StatusBadRequest, problem)
		return
	}

	existing, err := p.store.GetTemplates(req.TeamID)
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	if len(existing) >= store.MaxTemplatesPerTeam {
		writeError(w, r, http.StatusBadRequest, fmt.Sprintf("A team can have at most %d templates. Delete one you no longer use.", store.MaxTemplatesPerTeam))
		return
	}
	if store.FindTemplateByName(existing, name) != nil || store.FindTemplateByName(store.BuiltinTemplates, name) != nil {
		writeError(w, r, http.StatusBadRequest, fmt.Sprintf("There's already a template called “%s”.", name))
		return
	}

	columns, err := p.store.GetColumns(list.ID)
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	var items []*store.Item
	if req.IncludeItems {
		if items, err = p.store.GetItems(list.ID); err != nil {
			p.internalError(w, r, err)
			return
		}
		if len(items) > store.MaxTemplateItems {
			writeError(w, r, http.StatusBadRequest, fmt.Sprintf("A template can have at most %d items. Save it without items, or make the list shorter.", store.MaxTemplateItems))
			return
		}
	}

	now := model.GetMillis()
	t := &store.Template{
		ID: model.NewId(), TeamID: req.TeamID, Name: name, Description: description, CreatorID: userID(r),
		CreateAt: now, UpdateAt: now, Content: store.Snapshot(columns, items, req.IncludeItems),
	}
	if err = p.store.CreateTemplate(t); err != nil {
		p.internalError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusCreated, p.summarize(t, userID(r)))
}

// editableTemplate loads a saved template for renaming or deleting. People outside its
// team get 404, and people in it who didn't save it get 403 unless they're team admins.
func (p *Plugin) editableTemplate(w http.ResponseWriter, r *http.Request) (*store.Template, bool) {
	t, err := p.store.GetTemplate(mux.Vars(r)["template_id"])
	if errors.Is(err, store.ErrNotFound) || (err == nil && !p.inTeam(userID(r), t.TeamID)) {
		writeError(w, r, http.StatusNotFound, "Template not found.")
		return nil, false
	}
	if err != nil {
		p.internalError(w, r, err)
		return nil, false
	}
	if !p.canEditTemplate(userID(r), t) {
		writeError(w, r, http.StatusForbidden, "Only the person who saved this template, or a team admin, can change it.")
		return nil, false
	}
	return t, true
}

func (p *Plugin) handlePatchTemplate(w http.ResponseWriter, r *http.Request) {
	t, ok := p.editableTemplate(w, r)
	if !ok {
		return
	}
	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	name, description := t.Name, t.Description
	if req.Name != nil {
		name = *req.Name
	}
	if req.Description != nil {
		description = *req.Description
	}
	name, description, problem := validateTemplateText(name, description)
	if problem != "" {
		writeError(w, r, http.StatusBadRequest, problem)
		return
	}
	if !strings.EqualFold(name, t.Name) {
		existing, err := p.store.GetTemplates(t.TeamID)
		if err != nil {
			p.internalError(w, r, err)
			return
		}
		if store.FindTemplateByName(existing, name) != nil || store.FindTemplateByName(store.BuiltinTemplates, name) != nil {
			writeError(w, r, http.StatusBadRequest, fmt.Sprintf("There's already a template called “%s”.", name))
			return
		}
	}
	t.Name, t.Description, t.UpdateAt = name, description, model.GetMillis()
	if err := p.store.UpdateTemplate(t); err != nil {
		p.storeError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, p.summarize(t, userID(r)))
}

func (p *Plugin) handleDeleteTemplate(w http.ResponseWriter, r *http.Request) {
	t, ok := p.editableTemplate(w, r)
	if !ok {
		return
	}
	if err := p.store.DeleteTemplate(t.ID); err != nil {
		p.storeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
