package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/pluginapi/testhelper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/BigForkLifter/matterlists/server/store"
)

// call sends a JSON request to the plugin API as the given client's user and decodes
// the response into out when it is non-nil.
func call(t *testing.T, th *testhelper.TestHelper, client *model.Client4, method, path string, body any, out any) int {
	t.Helper()

	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, th.ServerURL+"/plugins/"+testhelper.PluginID()+"/api/v1"+path, reader)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+client.AuthToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	data, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	if out != nil && resp.StatusCode < 300 {
		require.NoError(t, json.Unmarshal(data, out), string(data))
	}
	return resp.StatusCode
}

// callRaw sends a raw body to the plugin API and returns the status and response body.
// With cookie set, it authenticates the way an <img> tag does: the session cookie only.
func callRaw(t *testing.T, th *testhelper.TestHelper, client *model.Client4, method, path, contentType string, body []byte, cookie bool) (int, http.Header, []byte) {
	t.Helper()

	req, err := http.NewRequest(method, th.ServerURL+"/plugins/"+testhelper.PluginID()+"/api/v1"+path, bytes.NewReader(body))
	require.NoError(t, err)
	if cookie {
		req.AddCookie(&http.Cookie{Name: model.SessionCookieToken, Value: client.AuthToken})
	} else {
		req.Header.Set("Authorization", "Bearer "+client.AuthToken)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp.StatusCode, resp.Header, data
}

func testPNG(t *testing.T) []byte {
	img := image.NewRGBA(image.Rect(0, 0, 640, 480))
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

// TestListLifecycle exercises the API end to end against a real server and database.
// It's one test because each Setup restarts the server.
func TestListLifecycle(t *testing.T) {
	th := testhelper.Setup(t)
	ctx := t.Context()
	ch := th.Channel.Id

	// Create a list; it starts with the default columns.
	var created listDetail
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/channels/"+ch+"/lists", map[string]any{"title": "Launch"}, &created))
	listID := created.List.ID
	require.Len(t, created.Columns, 3)
	status, assignee := created.Columns[0], created.Columns[1]
	assert.Equal(t, store.ColumnSelect, status.Type)
	inProgress := status.Options.Choices[1].ID

	var lists []*store.List
	require.Equal(t, http.StatusOK, call(t, th, th.Client, http.MethodGet, "/channels/"+ch+"/lists", nil, &lists))
	require.Len(t, lists, 1)
	assert.Equal(t, "Launch", lists[0].Title)

	// Items validate their values.
	var item store.Item
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/lists/"+listID+"/items", map[string]any{
		"title":  "Book venue",
		"values": map[string]any{status.ID: inProgress, assignee.ID: []string{th.User.Id}},
	}, &item))
	assert.JSONEq(t, `"`+inProgress+`"`, string(item.Values[status.ID]))

	assert.Equal(t, http.StatusBadRequest, call(t, th, th.Client, http.MethodPatch, "/items/"+item.ID, map[string]any{
		"values": map[string]any{status.ID: "no-such-choice"},
	}, nil))

	var second store.Item
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/lists/"+listID+"/items", map[string]any{"title": "Order food"}, &second))
	assert.Greater(t, second.SortOrder, item.SortOrder, "new items go to the end")

	// A Created by column shows each item's creator until someone sets another person.
	var createdBy store.Column
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/lists/"+listID+"/columns", map[string]any{"name": "Assigner", "type": "created_by"}, &createdBy))
	assert.Equal(t, th.User.Id, item.CreatorID)
	resp, _, err := th.Client.ExecuteCommand(ctx, ch, "/list show 1")
	require.NoError(t, err)
	assert.Contains(t, resp.Text, "1. Book venue · In progress · @"+th.User.Username+" · @"+th.User.Username)

	var reassigned store.Item
	require.Equal(t, http.StatusOK, call(t, th, th.Client, http.MethodPatch, "/items/"+item.ID, map[string]any{
		"values": map[string]any{createdBy.ID: []string{th.AdminUser.Id}},
	}, &reassigned))
	assert.JSONEq(t, `["`+th.AdminUser.Id+`"]`, string(reassigned.Values[createdBy.ID]))
	assert.Equal(t, th.User.Id, reassigned.CreatorID, "the real creator is kept")
	resp, _, err = th.Client.ExecuteCommand(ctx, ch, "/list show 1")
	require.NoError(t, err)
	assert.Contains(t, resp.Text, " · @"+th.AdminUser.Username)

	var reset store.Item
	require.Equal(t, http.StatusOK, call(t, th, th.Client, http.MethodPatch, "/items/"+item.ID, map[string]any{
		"values": map[string]any{createdBy.ID: nil},
	}, &reset))
	assert.NotContains(t, reset.Values, createdBy.ID, "clearing goes back to the creator")
	require.Equal(t, http.StatusNoContent, call(t, th, th.Client, http.MethodDelete, "/columns/"+createdBy.ID, nil, nil))

	// Starting a thread is idempotent.
	var thread, again map[string]string
	require.Equal(t, http.StatusOK, call(t, th, th.Client, http.MethodPost, "/items/"+item.ID+"/thread", nil, &thread))
	require.NotEmpty(t, thread["root_post_id"])
	require.Equal(t, http.StatusOK, call(t, th, th.Client, http.MethodPost, "/items/"+item.ID+"/thread", nil, &again))
	assert.Equal(t, thread["root_post_id"], again["root_post_id"])
	post, _, err := th.AdminClient.GetPost(ctx, thread["root_post_id"], "")
	require.NoError(t, err)
	assert.Equal(t, ch, post.ChannelId)
	assert.Contains(t, post.Message, "Book venue")

	// Photos are uploaded to a cell, served to channel members, and deleted when removed.
	var photos store.Column
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/lists/"+listID+"/columns", map[string]any{"name": "Photos", "type": "photos"}, &photos))
	upload := func(itemID string, body []byte) (int, store.Item) {
		code, _, data := callRaw(t, th, th.Client, http.MethodPost, "/items/"+itemID+"/columns/"+photos.ID+"/photos", "image/png", body, false)
		var updated store.Item
		if code == http.StatusCreated {
			require.NoError(t, json.Unmarshal(data, &updated))
		}
		return code, updated
	}
	photoIDs := func(it store.Item) []string {
		var ids []string
		_ = json.Unmarshal(it.Values[photos.ID], &ids)
		return ids
	}
	pic := testPNG(t)
	code, withPhoto := upload(item.ID, pic)
	require.Equal(t, http.StatusCreated, code)
	require.Len(t, photoIDs(withPhoto), 1)
	code, withPhoto = upload(item.ID, pic)
	require.Equal(t, http.StatusCreated, code)
	ids := photoIDs(withPhoto)
	require.Len(t, ids, 2)

	code, _ = upload(item.ID, []byte("not an image"))
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, http.StatusBadRequest, call(t, th, th.Client, http.MethodPatch, "/items/"+second.ID, map[string]any{
		"values": map[string]any{photos.ID: ids},
	}, nil), "photos can't be copied to another item by ID")

	code, header, data := callRaw(t, th, th.Client, http.MethodGet, "/photos/"+ids[0]+"?size=thumb", "", nil, true)
	require.Equal(t, http.StatusOK, code, "served with the session cookie alone, as for <img>")
	assert.Equal(t, "image/jpeg", header.Get("Content-Type"))
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	require.NoError(t, err)
	assert.Equal(t, "jpeg", format)
	assert.Equal(t, thumbMaxSide, cfg.Width)

	resp, _, err = th.Client.ExecuteCommand(ctx, ch, "/list show 1")
	require.NoError(t, err)
	assert.Contains(t, resp.Text, "📷 2 photos")

	stranger := th.CreateUser()
	strangerClient := model.NewAPIv4Client(th.ServerURL)
	_, _, err = strangerClient.Login(ctx, stranger.Username, "Password1!")
	require.NoError(t, err)
	code, _, _ = callRaw(t, th, strangerClient, http.MethodGet, "/photos/"+ids[0], "", nil, false)
	assert.Equal(t, http.StatusNotFound, code, "someone outside the channel can't see photos")
	code, _, _ = callRaw(t, th, strangerClient, http.MethodPost, "/items/"+item.ID+"/columns/"+photos.ID+"/photos", "image/png", pic, false)
	assert.Equal(t, http.StatusNotFound, code)

	var removed store.Item
	require.Equal(t, http.StatusOK, call(t, th, th.Client, http.MethodPatch, "/items/"+item.ID, map[string]any{
		"values": map[string]any{photos.ID: ids[1:]},
	}, &removed))
	code, _, _ = callRaw(t, th, th.Client, http.MethodGet, "/photos/"+ids[0], "", nil, false)
	assert.Equal(t, http.StatusNotFound, code, "a removed photo is deleted")
	code, _, _ = callRaw(t, th, th.Client, http.MethodGet, "/photos/"+ids[1], "", nil, false)
	assert.Equal(t, http.StatusOK, code)

	var temp store.Item
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/lists/"+listID+"/items", map[string]any{"title": "Temporary"}, &temp))
	code, temp = upload(temp.ID, pic)
	require.Equal(t, http.StatusCreated, code)
	require.Equal(t, http.StatusNoContent, call(t, th, th.Client, http.MethodDelete, "/items/"+temp.ID, nil, nil))
	code, _, _ = callRaw(t, th, th.Client, http.MethodGet, "/photos/"+photoIDs(temp)[0], "", nil, false)
	assert.Equal(t, http.StatusNotFound, code, "deleting an item deletes its photos")

	require.Equal(t, http.StatusNoContent, call(t, th, th.Client, http.MethodDelete, "/columns/"+photos.ID, nil, nil))
	code, _, _ = callRaw(t, th, th.Client, http.MethodGet, "/photos/"+ids[1], "", nil, false)
	assert.Equal(t, http.StatusNotFound, code, "deleting the column deletes its photos")

	// Deleting a column clears its values.
	require.Equal(t, http.StatusNoContent, call(t, th, th.Client, http.MethodDelete, "/columns/"+status.ID, nil, nil))
	var detail listDetail
	require.Equal(t, http.StatusOK, call(t, th, th.Client, http.MethodGet, "/lists/"+listID, nil, &detail))
	require.Len(t, detail.Columns, 2)
	require.Len(t, detail.Items, 2)
	assert.NotContains(t, detail.Items[0].Values, status.ID)
	assert.Contains(t, detail.Items[0].Values, assignee.ID)

	// The slash command sees the same data.
	resp, _, err = th.Client.ExecuteCommand(ctx, ch, "/list ls")
	require.NoError(t, err)
	assert.Contains(t, resp.Text, "1. Launch — 2 items")

	// Someone outside the channel can't see or change its lists.
	outsider := th.CreateUser()
	outsiderClient := model.NewAPIv4Client(th.ServerURL)
	_, _, err = outsiderClient.Login(ctx, outsider.Username, "Password1!")
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, call(t, th, outsiderClient, http.MethodGet, "/channels/"+ch+"/lists", nil, nil))
	assert.Equal(t, http.StatusNotFound, call(t, th, outsiderClient, http.MethodGet, "/lists/"+listID, nil, nil))
	assert.Equal(t, http.StatusNotFound, call(t, th, outsiderClient, http.MethodPatch, "/items/"+item.ID, map[string]any{"title": "x"}, nil))
	assert.Equal(t, http.StatusForbidden, call(t, th, outsiderClient, http.MethodPost, "/channels/"+ch+"/lists", map[string]any{"title": "x"}, nil))

	// Templates: built-in ones, and lists saved as templates for the team.
	team := th.Team.Id
	var templates []templateSummary
	require.Equal(t, http.StatusOK, call(t, th, th.Client, http.MethodGet, "/teams/"+team+"/templates", nil, &templates))
	require.Len(t, templates, len(store.BuiltinTemplates))
	assert.Equal(t, "Tasks", templates[0].Name)

	var fromChecklist listDetail
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/channels/"+ch+"/lists", map[string]any{"title": "Packing", "template_id": "checklist"}, &fromChecklist))
	require.Len(t, fromChecklist.Columns, 2)
	assert.Equal(t, store.ColumnCheckbox, fromChecklist.Columns[0].Type)
	assert.Equal(t, http.StatusBadRequest, call(t, th, th.Client, http.MethodPost, "/channels/"+ch+"/lists", map[string]any{"title": "x", "template_id": "nope"}, nil))

	// Save a list with a done item; the copy starts it again.
	var onboarding listDetail
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/channels/"+ch+"/lists", map[string]any{"title": "Onboarding"}, &onboarding))
	obStatus := onboarding.Columns[0]
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/lists/"+onboarding.List.ID+"/items", map[string]any{
		"title": "Create account", "values": map[string]any{obStatus.ID: obStatus.Options.Choices[2].ID, onboarding.Columns[1].ID: []string{th.User.Id}},
	}, nil))
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/lists/"+onboarding.List.ID+"/items", map[string]any{"title": "Order laptop"}, nil))

	var saved templateSummary
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/lists/"+onboarding.List.ID+"/templates", map[string]any{
		"team_id": team, "name": "New hire", "include_items": true,
	}, &saved))
	assert.Equal(t, 2, saved.ItemCount)
	assert.True(t, saved.CanEdit)
	assert.Equal(t, http.StatusBadRequest, call(t, th, th.Client, http.MethodPost, "/lists/"+onboarding.List.ID+"/templates", map[string]any{
		"team_id": team, "name": "new HIRE",
	}, nil), "names are unique in a team")

	var fromSaved listDetail
	require.Equal(t, http.StatusCreated, call(t, th, th.Client, http.MethodPost, "/channels/"+ch+"/lists", map[string]any{"title": "Sam starts", "template_id": saved.ID}, &fromSaved))
	require.Len(t, fromSaved.Items, 2)
	first := fromSaved.Items[0]
	assert.Equal(t, "Create account", first.Title)
	assert.JSONEq(t, `"`+fromSaved.Columns[0].Options.Choices[0].ID+`"`, string(first.Values[fromSaved.Columns[0].ID]), "status starts again")
	assert.NotContains(t, first.Values, fromSaved.Columns[1].ID, "people are left empty")
	assert.NotEqual(t, obStatus.ID, fromSaved.Columns[0].ID)

	resp, _, err = th.Client.ExecuteCommand(ctx, ch, "/list new Alex starts from new hire")
	require.NoError(t, err)
	assert.Contains(t, resp.Text, "from the template **New hire**")

	// Someone else in the team sees the template but can't change it; outsiders don't see it.
	teammate := th.CreateUser() // CreateUser adds them to the team
	teammateClient := model.NewAPIv4Client(th.ServerURL)
	_, _, err = teammateClient.Login(ctx, teammate.Username, "Password1!")
	require.NoError(t, err)
	var theirs []templateSummary
	require.Equal(t, http.StatusOK, call(t, th, teammateClient, http.MethodGet, "/teams/"+team+"/templates", nil, &theirs))
	require.Len(t, theirs, len(store.BuiltinTemplates)+1)
	assert.False(t, theirs[len(theirs)-1].CanEdit)
	assert.Equal(t, http.StatusForbidden, call(t, th, teammateClient, http.MethodDelete, "/templates/"+saved.ID, nil, nil))

	loner := th.CreateUser()
	_, err = th.AdminClient.RemoveTeamMember(ctx, team, loner.Id)
	require.NoError(t, err)
	lonerClient := model.NewAPIv4Client(th.ServerURL)
	_, _, err = lonerClient.Login(ctx, loner.Username, "Password1!")
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, call(t, th, lonerClient, http.MethodGet, "/teams/"+team+"/templates", nil, nil))
	assert.Equal(t, http.StatusNotFound, call(t, th, lonerClient, http.MethodPatch, "/templates/"+saved.ID, map[string]any{"name": "x"}, nil))

	var renamed templateSummary
	require.Equal(t, http.StatusOK, call(t, th, th.Client, http.MethodPatch, "/templates/"+saved.ID, map[string]any{"name": "Onboarding steps"}, &renamed))
	assert.Equal(t, "Onboarding steps", renamed.Name)
	require.Equal(t, http.StatusNoContent, call(t, th, th.Client, http.MethodDelete, "/templates/"+saved.ID, nil, nil))
	assert.Equal(t, http.StatusBadRequest, call(t, th, th.Client, http.MethodPost, "/channels/"+ch+"/lists", map[string]any{"title": "x", "template_id": saved.ID}, nil))

	// Deleting the list hides it.
	require.Equal(t, http.StatusNoContent, call(t, th, th.Client, http.MethodDelete, "/lists/"+listID, nil, nil))
	assert.Equal(t, http.StatusNotFound, call(t, th, th.Client, http.MethodGet, "/lists/"+listID, nil, nil))
	require.Equal(t, http.StatusOK, call(t, th, th.Client, http.MethodGet, "/channels/"+ch+"/lists", nil, &lists))
	for _, l := range lists {
		assert.NotEqual(t, listID, l.ID)
	}
}
