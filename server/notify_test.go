package main

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/BigForkLifter/matterlists/server/store"
)

func TestMentionsIn(t *testing.T) {
	for text, want := range map[string][]string{
		"":                           nil,
		"@sam fix the door":          {"sam"},
		"ask @Sam.Park, then @jo.":   {"sam.park", "jo"},
		"(@sam) and @sam again":      {"sam"},
		"mail sam@example.com":       nil,
		"@all @channel @here people": nil,
		"line one\n@jo_2 line two":   {"jo_2"},
		"@@sam and @-sam":            nil,
	} {
		assert.Equal(t, want, mentionsIn(text), text)
	}
}

func testItem(t *testing.T, title string, values map[string]any) *store.Item {
	t.Helper()
	item := &store.Item{ID: "item1", Title: title, Values: map[string]json.RawMessage{}}
	for k, v := range values {
		raw, err := json.Marshal(v)
		require.NoError(t, err)
		item.Values[k] = raw
	}
	return item
}

func TestWhoWasAddedOrMentioned(t *testing.T) {
	columns := []*store.Column{
		{ID: "assignee", Type: store.ColumnPerson},
		{ID: "creator", Type: store.ColumnCreatedBy},
		{ID: "notes", Type: store.ColumnText},
		{ID: "link", Type: store.ColumnURL},
	}
	before := testItem(t, "Fix door @sam", map[string]any{"assignee": []string{"u1"}, "notes": "ask @jo"})
	after := testItem(t, "Fix door @sam", map[string]any{
		"assignee": []string{"u1", "u2"},
		"creator":  []string{"u3"},
		"notes":    "ask @jo\nand @kim",
		"link":     "https://x.test/@lee",
	})

	assert.Equal(t, []string{"u2"}, added(assignedUsers(columns, before), assignedUsers(columns, after)))
	assert.Equal(t, []string{"kim"}, added(mentionedUsernames(columns, before), mentionedUsernames(columns, after)))
	assert.Equal(t, []string{"u1", "u2"}, added(assignedUsers(columns, nil), assignedUsers(columns, after)))

	assert.Equal(t, "and @kim", mentionLine(columns, after, "Kim"))
	assert.Empty(t, mentionLine(columns, after, "sam"), "a title mention needs no quote")
}

func TestNotifierMergesAndWaits(t *testing.T) {
	saved := noticeDelay
	noticeDelay = 20 * time.Millisecond
	t.Cleanup(func() { noticeDelay = saved })

	n := newNotifier()
	var mu sync.Mutex
	var sent []notice
	send := func(_ noticeKey, got notice) {
		mu.Lock()
		defer mu.Unlock()
		sent = append(sent, got)
	}
	key := noticeKey{"item1", "u1"}
	n.add(key, notice{actorID: "a", assigned: true}, send)
	n.add(key, notice{actorID: "b", mentioned: true}, send)
	n.add(noticeKey{"item1", "u2"}, notice{actorID: "a", assigned: true}, send)
	n.stop()
	n.add(key, notice{actorID: "a", assigned: true}, send)
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	assert.Empty(t, sent, "stopping drops pending notices")
	mu.Unlock()

	n = newNotifier()
	n.add(key, notice{actorID: "a", assigned: true}, send)
	n.add(key, notice{actorID: "b", mentioned: true}, send)
	assert.Eventually(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(sent) == 1
	}, time.Second, 5*time.Millisecond)
	mu.Lock()
	assert.Equal(t, notice{actorID: "a", assigned: true, mentioned: true}, sent[0])
	mu.Unlock()
}

func TestPostTitle(t *testing.T) {
	for in, want := range map[string]string{
		"Fix the door":       "Fix the door",
		"  Fix *the* door  ": `Fix \*the\* door`,
		"Sign in [here](https://evil.example)\nYour session expired": `Sign in \[here\](https://evil.example)`,
		"@channel look":      "@\u200bchannel look",
		"@ALL and @here":     "@\u200bALL and @\u200bhere",
		"@sam and @channels": "@sam and @channels",
	} {
		assert.Equal(t, want, postTitle(in), in)
	}
}
