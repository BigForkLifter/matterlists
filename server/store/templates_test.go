package store

import (
	"encoding/json"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuiltinTemplatesAreValid(t *testing.T) {
	names := map[string]bool{}
	for _, tpl := range BuiltinTemplates {
		assert.False(t, names[tpl.Name], "duplicate name %q", tpl.Name)
		names[tpl.Name] = true
		for _, c := range tpl.Content.Columns {
			assert.True(t, IsValidColumnType(c.Type), "%s: %s", tpl.Name, c.Name)
			_, err := NormalizeOptions(c.Type, c.Options)
			assert.NoError(t, err, "%s: %s", tpl.Name, c.Name)
		}
	}
	require.NotNil(t, BuiltinTemplate(DefaultTemplateID))
	require.NotNil(t, BuiltinTemplate(BlankTemplateID))
	assert.Empty(t, BuiltinTemplate(BlankTemplateID).Content.Columns)
}

func raw(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func TestSnapshotAndInstantiate(t *testing.T) {
	status := &Column{ID: model.NewId(), Name: "Status", Type: ColumnSelect, Options: ColumnOptions{Choices: []Choice{
		{ID: "todo", Name: "To do", Color: "gray"}, {ID: "done", Name: "Done", Color: "green"},
	}}}
	priority := &Column{ID: model.NewId(), Name: "Priority", Type: ColumnSelect, Options: ColumnOptions{Choices: []Choice{
		{ID: "low", Name: "Low", Color: "gray"}, {ID: "high", Name: "High", Color: "red"},
	}}}
	notes := &Column{ID: model.NewId(), Name: "Notes", Type: ColumnText}
	check := &Column{ID: model.NewId(), Name: "Checked", Type: ColumnCheckbox}
	who := &Column{ID: model.NewId(), Name: "Who", Type: ColumnPerson}
	due := &Column{ID: model.NewId(), Name: "Due", Type: ColumnDate}
	columns := []*Column{status, priority, notes, check, who, due}
	items := []*Item{{
		Title: "Order laptop",
		Values: map[string]json.RawMessage{
			status.ID: raw("done"), priority.ID: raw("high"), notes.ID: raw("Ask IT"),
			check.ID: raw(true), who.ID: raw([]string{model.NewId()}), due.ID: raw("2026-11-09"),
		},
	}, {Title: "Say hello"}}

	t.Run("columns only", func(t *testing.T) {
		content := Snapshot(columns, items, false)
		assert.Len(t, content.Columns, 6)
		assert.Empty(t, content.Items)
	})

	content := Snapshot(columns, items, true)
	require.Len(t, content.Items, 2)
	assert.Equal(t, map[string]json.RawMessage{
		status.ID: raw("todo"), priority.ID: raw("high"), notes.ID: raw("Ask IT"),
	}, content.Items[0].Values, "status resets; checkbox, person and date are dropped")
	assert.Nil(t, content.Items[1].Values)

	newCols, newItems := Instantiate(content, "list1", "user1", 42)
	require.Len(t, newCols, 6)
	require.Len(t, newItems, 2)
	for i, c := range newCols {
		assert.NotEqual(t, columns[i].ID, c.ID, "columns get new IDs")
		assert.Equal(t, "list1", c.ListID)
		assert.Equal(t, columns[i].Name, c.Name)
	}
	newStatus, newPriority, newNotes := newCols[0], newCols[1], newCols[2]
	assert.NotEqual(t, "todo", newStatus.Options.Choices[0].ID, "choices get new IDs")
	assert.Equal(t, "To do", newStatus.Options.Choices[0].Name)

	first := newItems[0]
	assert.Equal(t, "Order laptop", first.Title)
	assert.Equal(t, "user1", first.CreatorID)
	assert.JSONEq(t, `"`+newStatus.Options.Choices[0].ID+`"`, string(first.Values[newStatus.ID]))
	assert.JSONEq(t, `"`+newPriority.Options.Choices[1].ID+`"`, string(first.Values[newPriority.ID]))
	assert.JSONEq(t, `"Ask IT"`, string(first.Values[newNotes.ID]))
	assert.Len(t, first.Values, 3)
	assert.Less(t, first.SortOrder, newItems[1].SortOrder, "items keep their order")
}

func TestFindTemplateByName(t *testing.T) {
	assert.Equal(t, "checklist", FindTemplateByName(BuiltinTemplates, "  CHECKLIST ").ID)
	assert.Nil(t, FindTemplateByName(BuiltinTemplates, "the meeting"))
}
