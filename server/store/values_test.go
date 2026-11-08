package store

import (
	"encoding/json"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeValue(t *testing.T) {
	selectCol := &Column{Name: "Status", Type: ColumnSelect, Options: ColumnOptions{Choices: []Choice{{ID: "a", Name: "A"}, {ID: "b", Name: "B"}}}}
	multiCol := &Column{Name: "Tags", Type: ColumnMultiSelect, Options: selectCol.Options}
	userID := model.NewId()

	tests := []struct {
		name    string
		col     *Column
		in      string
		want    string // "" means the cell is cleared
		wantErr bool
	}{
		{"text trims", &Column{Type: ColumnText}, `"  hi  "`, `"hi"`, false},
		{"empty text clears", &Column{Type: ColumnText}, `"   "`, "", false},
		{"null clears", &Column{Type: ColumnText}, `null`, "", false},
		{"text rejects number", &Column{Type: ColumnText}, `3`, "", true},
		{"number", &Column{Type: ColumnNumber}, `3.5`, `3.5`, false},
		{"number rejects string", &Column{Type: ColumnNumber}, `"3"`, "", true},
		{"checkbox true", &Column{Type: ColumnCheckbox}, `true`, `true`, false},
		{"checkbox false clears", &Column{Type: ColumnCheckbox}, `false`, "", false},
		{"date", &Column{Type: ColumnDate}, `"2026-10-18"`, `"2026-10-18"`, false},
		{"bad date", &Column{Type: ColumnDate}, `"18/10/2026"`, "", true},
		{"url adds scheme", &Column{Type: ColumnURL}, `"example.com/x"`, `"https://example.com/x"`, false},
		{"url rejects javascript", &Column{Type: ColumnURL}, `"javascript:alert(1)"`, "", true},
		{"select known", selectCol, `"a"`, `"a"`, false},
		{"select unknown", selectCol, `"z"`, "", true},
		{"multi dedupes", multiCol, `["a","b","a"]`, `["a","b"]`, false},
		{"multi empty clears", multiCol, `[]`, "", false},
		{"multi unknown", multiCol, `["a","z"]`, "", true},
		{"person", &Column{Type: ColumnPerson}, `["` + userID + `"]`, `["` + userID + `"]`, false},
		{"person invalid id", &Column{Type: ColumnPerson}, `["nope"]`, "", true},
		{"created by can be set", &Column{Type: ColumnCreatedBy}, `["` + userID + `"]`, `["` + userID + `"]`, false},
		{"created by is one person", &Column{Type: ColumnCreatedBy}, `["` + userID + `","` + model.NewId() + `"]`, "", true},
		{"created by clears back to the creator", &Column{Type: ColumnCreatedBy}, `null`, "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeValue(tc.col, json.RawMessage(tc.in))
			if tc.wantErr {
				assert.Error(t, err)
				return
			}
			require.NoError(t, err)
			if tc.want == "" {
				assert.Nil(t, got)
			} else {
				assert.JSONEq(t, tc.want, string(got))
			}
		})
	}
}

func TestApplyValues(t *testing.T) {
	cols := []*Column{{ID: "t", Name: "Notes", Type: ColumnText}, {ID: "n", Name: "Points", Type: ColumnNumber}}
	existing := map[string]json.RawMessage{"t": json.RawMessage(`"old"`), "n": json.RawMessage(`1`)}

	out, err := ApplyValues(cols, existing, map[string]json.RawMessage{"t": json.RawMessage(`null`), "n": json.RawMessage(`2`)})
	require.NoError(t, err)
	assert.Equal(t, map[string]json.RawMessage{"n": json.RawMessage(`2`)}, out)
	assert.Equal(t, json.RawMessage(`"old"`), existing["t"], "existing must not be mutated")

	_, err = ApplyValues(cols, existing, map[string]json.RawMessage{"missing": json.RawMessage(`1`)})
	assert.Error(t, err)

	_, err = ApplyValues(cols, existing, map[string]json.RawMessage{"n": json.RawMessage(`"x"`)})
	assert.ErrorContains(t, err, "Points")
}

func TestNormalizeOptions(t *testing.T) {
	opts, err := NormalizeOptions(ColumnSelect, ColumnOptions{Choices: []Choice{{Name: " Todo "}, {ID: "x", Name: "Done", Color: "green"}}})
	require.NoError(t, err)
	require.Len(t, opts.Choices, 2)
	assert.NotEmpty(t, opts.Choices[0].ID)
	assert.Equal(t, "Todo", opts.Choices[0].Name)
	assert.Equal(t, "gray", opts.Choices[0].Color)
	assert.Equal(t, Choice{ID: "x", Name: "Done", Color: "green"}, opts.Choices[1])

	_, err = NormalizeOptions(ColumnSelect, ColumnOptions{Choices: []Choice{{ID: "x", Name: "A"}, {ID: "x", Name: "B"}}})
	assert.Error(t, err)

	opts, err = NormalizeOptions(ColumnText, ColumnOptions{Choices: []Choice{{Name: "ignored"}}})
	require.NoError(t, err)
	assert.Empty(t, opts.Choices)
}

func TestApplyValuesPhotos(t *testing.T) {
	col := &Column{ID: model.NewId(), Name: "Photos", Type: ColumnPhotos}
	a, b, c := model.NewId(), model.NewId(), model.NewId()
	existing := map[string]json.RawMessage{col.ID: json.RawMessage(`["` + a + `","` + b + `"]`)}
	patch := func(v string) map[string]json.RawMessage {
		return map[string]json.RawMessage{col.ID: json.RawMessage(v)}
	}

	out, err := ApplyValues([]*Column{col}, existing, patch(`["`+b+`","`+a+`"]`))
	require.NoError(t, err, "reordering is allowed")
	assert.JSONEq(t, `["`+b+`","`+a+`"]`, string(out[col.ID]))

	out, err = ApplyValues([]*Column{col}, existing, patch(`["`+a+`"]`))
	require.NoError(t, err, "removing is allowed")
	assert.JSONEq(t, `["`+a+`"]`, string(out[col.ID]))

	out, err = ApplyValues([]*Column{col}, existing, patch(`null`))
	require.NoError(t, err, "clearing is allowed")
	assert.NotContains(t, out, col.ID)

	_, err = ApplyValues([]*Column{col}, existing, patch(`["`+a+`","`+c+`"]`))
	assert.Error(t, err, "adding by patch is not allowed")

	_, err = ApplyValues([]*Column{col}, nil, patch(`["`+a+`"]`))
	assert.Error(t, err, "a new item can't start with photos")

	_, err = ApplyValues([]*Column{col}, existing, patch(`["not-an-id"]`))
	assert.Error(t, err)
}
