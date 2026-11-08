package store

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/pkg/errors"
)

const (
	MaxTitleLength      = 256
	MaxColumnNameLength = 128
	MaxChoiceNameLength = 64
	MaxTextValueLength  = 4000
	MaxColumnsPerList   = 30
	MaxChoicesPerColumn = 50
	MaxPhotosPerCell    = 20
)

// ChoiceColors are the color names the webapp knows how to render.
var ChoiceColors = []string{"gray", "blue", "green", "yellow", "orange", "red", "purple", "pink"}

func IsValidColumnType(t ColumnType) bool {
	switch t {
	case ColumnText, ColumnNumber, ColumnSelect, ColumnMultiSelect, ColumnPerson, ColumnDate, ColumnCheckbox, ColumnURL, ColumnCreatedBy, ColumnPhotos:
		return true
	}
	return false
}

func ValidateTitle(title string, maxLen int) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return "", errors.New("must not be empty")
	}
	if utf8.RuneCountInString(title) > maxLen {
		return "", errors.Errorf("must be at most %d characters", maxLen)
	}
	return title, nil
}

// NormalizeOptions checks a column's options for its type, assigning IDs and colors to new choices.
func NormalizeOptions(t ColumnType, opts ColumnOptions) (ColumnOptions, error) {
	if t != ColumnSelect && t != ColumnMultiSelect {
		return ColumnOptions{}, nil
	}
	if len(opts.Choices) > MaxChoicesPerColumn {
		return opts, errors.Errorf("at most %d choices are allowed", MaxChoicesPerColumn)
	}
	seen := map[string]bool{}
	out := make([]Choice, 0, len(opts.Choices))
	for i, c := range opts.Choices {
		name, err := ValidateTitle(c.Name, MaxChoiceNameLength)
		if err != nil {
			return opts, errors.Wrapf(err, "choice %d name", i+1)
		}
		id := c.ID
		if id == "" {
			id = model.NewId()
		}
		if seen[id] {
			return opts, errors.Errorf("duplicate choice id %q", id)
		}
		seen[id] = true
		color := c.Color
		if !isChoiceColor(color) {
			color = ChoiceColors[i%len(ChoiceColors)]
		}
		out = append(out, Choice{ID: id, Name: name, Color: color})
	}
	return ColumnOptions{Choices: out}, nil
}

func isChoiceColor(color string) bool {
	return slices.Contains(ChoiceColors, color)
}

// NormalizeValue validates a cell value for a column and returns it in canonical form.
// It returns nil when the value clears the cell (JSON null, "", false, or an empty array).
func NormalizeValue(col *Column, raw json.RawMessage) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}

	switch col.Type {
	case ColumnText:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, errors.New("expected a string")
		}
		s = strings.TrimSpace(s)
		if utf8.RuneCountInString(s) > MaxTextValueLength {
			return nil, errors.Errorf("must be at most %d characters", MaxTextValueLength)
		}
		return marshalOrClear(s, s == "")

	case ColumnURL:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, errors.New("expected a string")
		}
		s = strings.TrimSpace(s)
		if s == "" {
			return nil, nil
		}
		if !strings.Contains(s, "://") {
			s = "https://" + s
		}
		u, err := url.Parse(s)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, errors.New("expected an http or https link")
		}
		return json.Marshal(s)

	case ColumnNumber:
		var f float64
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, errors.New("expected a number")
		}
		return json.Marshal(f)

	case ColumnCheckbox:
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, errors.New("expected true or false")
		}
		return marshalOrClear(b, !b)

	case ColumnDate:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, errors.New("expected a date string")
		}
		if s == "" {
			return nil, nil
		}
		if _, err := time.Parse(time.DateOnly, s); err != nil {
			return nil, errors.New("expected a date as YYYY-MM-DD")
		}
		return json.Marshal(s)

	case ColumnSelect:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, errors.New("expected a choice id")
		}
		if s == "" {
			return nil, nil
		}
		if !hasChoice(col, s) {
			return nil, errors.Errorf("unknown choice %q", s)
		}
		return json.Marshal(s)

	case ColumnMultiSelect:
		ids, err := uniqueStrings(raw)
		if err != nil {
			return nil, errors.New("expected a list of choice ids")
		}
		for _, id := range ids {
			if !hasChoice(col, id) {
				return nil, errors.Errorf("unknown choice %q", id)
			}
		}
		return marshalOrClear(ids, len(ids) == 0)

	case ColumnPerson, ColumnCreatedBy:
		ids, err := uniqueStrings(raw)
		if err != nil {
			return nil, errors.New("expected a list of user ids")
		}
		if col.Type == ColumnCreatedBy && len(ids) > 1 {
			return nil, errors.New("can be only one person")
		}
		for _, id := range ids {
			if !model.IsValidId(id) {
				return nil, errors.Errorf("invalid user id %q", id)
			}
		}
		return marshalOrClear(ids, len(ids) == 0)

	case ColumnPhotos:
		ids, err := uniqueStrings(raw)
		if err != nil {
			return nil, errors.New("expected a list of photo ids")
		}
		if len(ids) > MaxPhotosPerCell {
			return nil, errors.Errorf("can have at most %d photos", MaxPhotosPerCell)
		}
		for _, id := range ids {
			if !model.IsValidId(id) {
				return nil, errors.Errorf("invalid photo id %q", id)
			}
		}
		return marshalOrClear(ids, len(ids) == 0)
	}

	return nil, errors.Errorf("unknown column type %q", col.Type)
}

// ApplyValues validates a patch of cell values keyed by column ID and merges it into
// existing. A nil value in the patch clears that cell.
func ApplyValues(columns []*Column, existing, patch map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	byID := make(map[string]*Column, len(columns))
	for _, c := range columns {
		byID[c.ID] = c
	}

	out := make(map[string]json.RawMessage, len(existing)+len(patch))
	maps.Copy(out, existing)
	for colID, raw := range patch {
		col, ok := byID[colID]
		if !ok {
			return nil, errors.Errorf("unknown column %q", colID)
		}
		v, err := NormalizeValue(col, raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", col.Name, err)
		}
		if col.Type == ColumnPhotos && !isSubset(v, existing[colID]) {
			// Photos are added by uploading them, so a patch may only remove or reorder.
			return nil, fmt.Errorf("%s: photos can only be added by uploading them", col.Name)
		}
		if v == nil {
			delete(out, colID)
		} else {
			out[colID] = v
		}
	}
	return out, nil
}

// isSubset reports whether every ID in the array next is also in the array prev.
func isSubset(next, prev json.RawMessage) bool {
	if next == nil {
		return true
	}
	var nextIDs, prevIDs []string
	if json.Unmarshal(next, &nextIDs) != nil {
		return false
	}
	if prev != nil && json.Unmarshal(prev, &prevIDs) != nil {
		return false
	}
	for _, id := range nextIDs {
		if !slices.Contains(prevIDs, id) {
			return false
		}
	}
	return true
}

func hasChoice(col *Column, id string) bool {
	for _, c := range col.Options.Choices {
		if c.ID == id {
			return true
		}
	}
	return false
}

func uniqueStrings(raw json.RawMessage) ([]string, error) {
	var in []string
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out, nil
}

func marshalOrClear(v any, clear bool) (json.RawMessage, error) {
	if clear {
		return nil, nil
	}
	return json.Marshal(v)
}
