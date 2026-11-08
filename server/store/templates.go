package store

import (
	"encoding/json"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
)

const (
	MaxTemplateItems       = 500
	MaxTemplatesPerTeam    = 100
	MaxTemplateDescription = 200
	DefaultTemplateID      = "tasks"
	BlankTemplateID        = "blank"
)

// TemplateColumn is a column as saved in a template. Key identifies it within the
// template, so items can refer to it; a list made from the template gets new IDs.
type TemplateColumn struct {
	Key     string        `json:"key"`
	Name    string        `json:"name"`
	Type    ColumnType    `json:"type"`
	Options ColumnOptions `json:"options"`
}

// TemplateItem is an item as saved in a template, its values keyed by TemplateColumn.Key.
type TemplateItem struct {
	Title  string                     `json:"title"`
	Values map[string]json.RawMessage `json:"values,omitempty"`
}

// TemplateContent is what a template makes: columns, and optionally items.
type TemplateContent struct {
	Columns []TemplateColumn `json:"columns"`
	Items   []TemplateItem   `json:"items,omitempty"`
}

// Template is a starting point for new lists. Built-in templates are defined in code
// and have no team; saved ones belong to a team and are shared with everyone in it.
type Template struct {
	ID          string
	TeamID      string
	Name        string
	Description string
	CreatorID   string
	CreateAt    int64
	UpdateAt    int64
	Builtin     bool
	Content     TemplateContent
}

func choices(names ...string) ColumnOptions {
	opts := ColumnOptions{}
	for i, n := range names {
		opts.Choices = append(opts.Choices, Choice{ID: n, Name: n, Color: ChoiceColors[i%len(ChoiceColors)]})
	}
	return opts
}

func colored(opts ColumnOptions, colors ...string) ColumnOptions {
	for i := range opts.Choices {
		opts.Choices[i].Color = colors[i]
	}
	return opts
}

// BuiltinTemplates are offered to everyone, in this order. Tasks is the default.
var BuiltinTemplates = []*Template{
	{
		ID: DefaultTemplateID, Name: "Tasks", Description: "Track work with a status, an owner and a due date.", Builtin: true,
		Content: TemplateContent{Columns: []TemplateColumn{
			{Key: "status", Name: "Status", Type: ColumnSelect, Options: colored(choices("To do", "In progress", "Done"), "gray", "blue", "green")},
			{Key: "assignee", Name: "Assignee", Type: ColumnPerson},
			{Key: "due", Name: "Due", Type: ColumnDate},
		}},
	},
	{
		ID: "checklist", Name: "Checklist", Description: "Things to tick off, with room for notes.", Builtin: true,
		Content: TemplateContent{Columns: []TemplateColumn{
			{Key: "done", Name: "Done", Type: ColumnCheckbox},
			{Key: "notes", Name: "Notes", Type: ColumnText},
		}},
	},
	{
		ID: "inspection", Name: "Inspection", Description: "A punch list: what needs fixing, where, with photos.", Builtin: true,
		Content: TemplateContent{Columns: []TemplateColumn{
			{Key: "status", Name: "Status", Type: ColumnSelect, Options: colored(choices("Open", "In progress", "Done"), "red", "blue", "green")},
			{Key: "assignee", Name: "Assignee", Type: ColumnPerson},
			{Key: "location", Name: "Location", Type: ColumnText},
			{Key: "photos", Name: "Photos", Type: ColumnPhotos},
			{Key: "due", Name: "Due", Type: ColumnDate},
		}},
	},
	{
		ID: "issues", Name: "Issue tracker", Description: "Problems people report, by priority, through to fixed.", Builtin: true,
		Content: TemplateContent{Columns: []TemplateColumn{
			{Key: "status", Name: "Status", Type: ColumnSelect, Options: colored(choices("New", "Triaged", "In progress", "Fixed"), "gray", "yellow", "blue", "green")},
			{Key: "priority", Name: "Priority", Type: ColumnSelect, Options: colored(choices("Low", "Medium", "High", "Urgent"), "gray", "blue", "orange", "red")},
			{Key: "reporter", Name: "Reporter", Type: ColumnCreatedBy},
			{Key: "assignee", Name: "Assignee", Type: ColumnPerson},
		}},
	},
	{
		ID: "workbench", Name: "Workbench", Description: "Work in progress, who added it, and notes.", Builtin: true,
		Content: TemplateContent{Columns: []TemplateColumn{
			{Key: "status", Name: "Status", Type: ColumnSelect, Options: colored(choices("To do", "In progress", "Done"), "gray", "blue", "green")},
			{Key: "by", Name: "By", Type: ColumnCreatedBy},
			{Key: "notes", Name: "Notes", Type: ColumnText},
		}},
	},
	{
		ID: BlankTemplateID, Name: "Blank", Description: "No columns. Add your own.", Builtin: true,
		Content: TemplateContent{Columns: []TemplateColumn{}},
	},
}

// BuiltinTemplate returns the built-in template with the given ID, or nil.
func BuiltinTemplate(id string) *Template {
	for _, t := range BuiltinTemplates {
		if t.ID == id {
			return t
		}
	}
	return nil
}

// FindTemplateByName finds a template by name, ignoring case and surrounding spaces.
func FindTemplateByName(templates []*Template, name string) *Template {
	name = strings.TrimSpace(name)
	for _, t := range templates {
		if strings.EqualFold(t.Name, name) {
			return t
		}
	}
	return nil
}

// DefaultColumns returns the columns a new list starts with when no template is chosen.
func DefaultColumns(listID string, now int64) []*Column {
	columns, _ := Instantiate(BuiltinTemplate(DefaultTemplateID).Content, listID, "", now)
	return columns
}

// Instantiate makes the columns and items of a new list from a template's content.
// Columns and choices get new IDs, so the list shares no IDs with the template or
// with other lists made from it. Values that no longer fit their column are dropped.
func Instantiate(content TemplateContent, listID, creatorID string, now int64) ([]*Column, []*Item) {
	columns := make([]*Column, 0, len(content.Columns))
	byKey := map[string]*Column{}
	choiceIDs := map[string]map[string]string{} // column key -> template choice ID -> new ID
	for i, tc := range content.Columns {
		col := &Column{ID: model.NewId(), ListID: listID, Name: tc.Name, Type: tc.Type, SortOrder: float64(i + 1), CreateAt: now}
		ids := map[string]string{}
		for _, ch := range tc.Options.Choices {
			ids[ch.ID] = model.NewId()
			col.Options.Choices = append(col.Options.Choices, Choice{ID: ids[ch.ID], Name: ch.Name, Color: ch.Color})
		}
		choiceIDs[tc.Key] = ids
		byKey[tc.Key] = col
		columns = append(columns, col)
	}

	items := make([]*Item, 0, len(content.Items))
	for i, ti := range content.Items {
		item := &Item{
			ID: model.NewId(), ListID: listID, Title: ti.Title, Values: map[string]json.RawMessage{},
			SortOrder: float64(i + 1), CreatorID: creatorID, CreateAt: now, UpdateAt: now,
		}
		for key, raw := range ti.Values {
			col := byKey[key]
			if col == nil {
				continue
			}
			v, err := NormalizeValue(col, remapChoices(col.Type, raw, choiceIDs[key]))
			if err == nil && v != nil {
				item.Values[col.ID] = v
			}
		}
		items = append(items, item)
	}
	return columns, items
}

func remapChoices(t ColumnType, raw json.RawMessage, ids map[string]string) json.RawMessage {
	switch t {
	case ColumnSelect:
		var id string
		if json.Unmarshal(raw, &id) == nil {
			b, _ := json.Marshal(ids[id])
			return b
		}
	case ColumnMultiSelect:
		var in []string
		if json.Unmarshal(raw, &in) == nil {
			out := []string{}
			for _, id := range in {
				if ids[id] != "" {
					out = append(out, ids[id])
				}
			}
			b, _ := json.Marshal(out)
			return b
		}
	}
	return raw
}

// Snapshot saves a list's columns, and its items when includeItems is set, as template
// content. Items are saved ready to be done again:
//   - titles, text, numbers, links and select values are kept
//   - the status (the first single-select column) goes back to its first choice
//   - checkboxes are cleared, as are people, dates, photos and Created by, which
//     belong to the run the list was saved from
func Snapshot(columns []*Column, items []*Item, includeItems bool) TemplateContent {
	content := TemplateContent{Columns: make([]TemplateColumn, 0, len(columns))}
	var status *Column
	for _, c := range columns {
		content.Columns = append(content.Columns, TemplateColumn{Key: c.ID, Name: c.Name, Type: c.Type, Options: c.Options})
		if status == nil && c.Type == ColumnSelect {
			status = c
		}
	}
	if !includeItems {
		return content
	}

	for _, it := range items {
		ti := TemplateItem{Title: it.Title, Values: map[string]json.RawMessage{}}
		for _, c := range columns {
			raw, ok := it.Values[c.ID]
			if !ok {
				continue
			}
			switch {
			case c == status:
				if len(c.Options.Choices) > 0 {
					ti.Values[c.ID], _ = json.Marshal(c.Options.Choices[0].ID)
				}
			case c.Type == ColumnText, c.Type == ColumnNumber, c.Type == ColumnURL, c.Type == ColumnSelect, c.Type == ColumnMultiSelect:
				ti.Values[c.ID] = raw
			}
		}
		if len(ti.Values) == 0 {
			ti.Values = nil
		}
		content.Items = append(content.Items, ti)
		if len(content.Items) >= MaxTemplateItems {
			break
		}
	}
	return content
}
