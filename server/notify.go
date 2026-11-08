package main

import (
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/pluginapi"

	"github.com/BigForkLifter/matterlists/server/store"
)

// People hear about an item when someone else assigns them to it (adds them to a person
// column) or mentions them with @username in its title or a text field. The bot tells
// them in a DM, after a short wait so that a person picked by mistake and removed
// straight away isn't told. Pending DMs live in memory, so a restart drops them.

// noticeDelay is how long a change waits before its DM is sent.
var noticeDelay = 30 * time.Second

type noticeKey struct{ itemID, userID string }

// notice is a DM waiting to be sent. When it is due, each reason is checked again
// against the item as it is then.
type notice struct {
	actorID   string
	assigned  bool
	mentioned bool
}

type notifier struct {
	mu      sync.Mutex
	pending map[noticeKey]*notice
	timers  map[noticeKey]*time.Timer
	stopped bool
}

func newNotifier() *notifier {
	return &notifier{pending: map[noticeKey]*notice{}, timers: map[noticeKey]*time.Timer{}}
}

// add queues a notice, merging it into one already waiting for the same person and item.
func (n *notifier) add(key noticeKey, add notice, send func(noticeKey, notice)) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.stopped {
		return
	}
	if waiting, ok := n.pending[key]; ok {
		waiting.assigned = waiting.assigned || add.assigned
		waiting.mentioned = waiting.mentioned || add.mentioned
		return
	}
	n.pending[key] = &add
	n.timers[key] = time.AfterFunc(noticeDelay, func() {
		n.mu.Lock()
		due, ok := n.pending[key]
		delete(n.pending, key)
		delete(n.timers, key)
		n.mu.Unlock()
		if ok {
			send(key, *due)
		}
	})
}

func (n *notifier) stop() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.stopped = true
	for _, t := range n.timers {
		t.Stop()
	}
	clear(n.pending)
	clear(n.timers)
}

// mentionPattern finds @username. The character before the @ must not be part of a word,
// so email addresses aren't mentions. The webapp uses the same pattern in utils.ts.
var mentionPattern = regexp.MustCompile(`(?:^|[^\w@.\-])@([a-zA-Z0-9][a-zA-Z0-9._\-]*)`)

// mentionsIn returns the usernames mentioned in text, lowercased. A trailing period is
// taken as the end of a sentence. Group mentions aren't supported in lists.
func mentionsIn(text string) []string {
	var out []string
	for _, m := range mentionPattern.FindAllStringSubmatch(text, -1) {
		name := strings.ToLower(strings.TrimRight(m[1], "."))
		if name == "" || name == "all" || name == "channel" || name == "here" || slices.Contains(out, name) {
			continue
		}
		out = append(out, name)
	}
	return out
}

// mentionedUsernames collects the usernames mentioned in an item's title and text cells.
func mentionedUsernames(columns []*store.Column, item *store.Item) map[string]bool {
	out := map[string]bool{}
	if item == nil {
		return out
	}
	for _, text := range itemTexts(columns, item) {
		for _, name := range mentionsIn(text) {
			out[name] = true
		}
	}
	return out
}

// itemTexts is the title followed by each text cell, in column order.
func itemTexts(columns []*store.Column, item *store.Item) []string {
	texts := []string{item.Title}
	for _, c := range columns {
		if c.Type != store.ColumnText {
			continue
		}
		var s string
		if raw, ok := item.Values[c.ID]; ok && json.Unmarshal(raw, &s) == nil {
			texts = append(texts, s)
		}
	}
	return texts
}

// assignedUsers collects the people in an item's person columns. Created by doesn't
// count: it says who made the item, not who should act on it.
func assignedUsers(columns []*store.Column, item *store.Item) map[string]bool {
	out := map[string]bool{}
	if item == nil {
		return out
	}
	for _, c := range columns {
		if c.Type != store.ColumnPerson {
			continue
		}
		var ids []string
		if raw, ok := item.Values[c.ID]; ok && json.Unmarshal(raw, &ids) == nil {
			for _, id := range ids {
				out[id] = true
			}
		}
	}
	return out
}

// added returns the keys of after that aren't in before, sorted.
func added(before, after map[string]bool) []string {
	var out []string
	for k := range after {
		if !before[k] {
			out = append(out, k)
		}
	}
	slices.Sort(out)
	return out
}

// itemChanged queues DMs for the people newly assigned to or mentioned in an item.
// before is nil for a new item. columns may be nil when only the title can have changed.
func (p *Plugin) itemChanged(columns []*store.Column, before, after *store.Item, actorID string) {
	if p.notifier == nil {
		return
	}
	send := func(key noticeKey, n notice) { p.sendNotice(key, n) }
	for _, id := range added(assignedUsers(columns, before), assignedUsers(columns, after)) {
		if id != actorID {
			p.notifier.add(noticeKey{after.ID, id}, notice{actorID: actorID, assigned: true}, send)
		}
	}

	names := added(mentionedUsernames(columns, before), mentionedUsernames(columns, after))
	if len(names) == 0 {
		return
	}
	users, err := p.client.User.ListByUsernames(names)
	if err != nil {
		p.API.LogWarn("Failed to look up mentioned users", "err", err.Error())
		return
	}
	for _, u := range users {
		if u.Id != actorID && !u.IsBot && u.DeleteAt == 0 {
			p.notifier.add(noticeKey{after.ID, u.Id}, notice{actorID: actorID, mentioned: true}, send)
		}
	}
}

// sendNotice sends a due notice if its reasons still hold and the person can still see
// the list.
func (p *Plugin) sendNotice(key noticeKey, n notice) {
	item, err := p.store.GetItem(key.itemID)
	if err != nil {
		return // deleted
	}
	list, err := p.store.GetList(item.ListID)
	if err != nil {
		return
	}
	columns, err := p.store.GetColumns(list.ID)
	if err != nil {
		p.API.LogWarn("Failed to load columns for a notice", "err", err.Error())
		return
	}
	user, err := p.client.User.Get(key.userID)
	if err != nil || user.DeleteAt != 0 {
		return
	}

	assigned := n.assigned && assignedUsers(columns, item)[user.Id]
	mentioned := n.mentioned && mentionedUsernames(columns, item)[strings.ToLower(user.Username)]
	if (!assigned && !mentioned) || !p.canRead(user.Id, list.ChannelID) {
		return
	}
	channel, err := p.client.Channel.Get(list.ChannelID)
	if err != nil {
		return
	}

	actor := "Someone"
	if a, aErr := p.client.User.Get(n.actorID); aErr == nil {
		actor = "@" + a.Username
	}
	verb := "mentioned you in"
	if assigned {
		verb = "assigned you to"
	}
	message := fmt.Sprintf("%s %s **%s** in %s.", actor, verb, postTitle(item.Title), channelReference(channel))
	if mentioned {
		if line := mentionLine(columns, item, user.Username); line != "" {
			message += "\n> " + escapeMarkdown(line)
		}
	}
	if link := p.itemLink(channel, list, item, user.Id); link != "" {
		message += fmt.Sprintf("\n[Open item](%s)", link)
	}

	if err = p.client.Post.DM(p.botID, user.Id, &model.Post{Message: message}); err != nil {
		p.API.LogWarn("Failed to send a notice", "err", err.Error())
	}
}

// mentionLine is the line of a text cell that mentions username, shortened. A mention
// in the title returns "", because the notice already shows the title.
func mentionLine(columns []*store.Column, item *store.Item, username string) string {
	username = strings.ToLower(username)
	texts := itemTexts(columns, item)
	if slices.Contains(mentionsIn(texts[0]), username) {
		return ""
	}
	for _, text := range texts[1:] {
		for line := range strings.SplitSeq(text, "\n") {
			if slices.Contains(mentionsIn(line), username) {
				return shorten(strings.TrimSpace(line), 300)
			}
		}
	}
	return ""
}

func shorten(s string, maxLen int) string {
	if utf8.RuneCountInString(s) <= maxLen {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:maxLen-1])) + "…"
}

// channelReference names a channel in a message: ~name links to it in-app.
func channelReference(channel *model.Channel) string {
	switch channel.Type {
	case model.ChannelTypeDirect:
		return "a direct message"
	case model.ChannelTypeGroup:
		return "a group message"
	}
	return "~" + channel.Name
}

// itemLink is the item on its list's full page. The page needs a team in its URL: the
// channel's, or for DMs and group messages one of the recipient's.
func (p *Plugin) itemLink(channel *model.Channel, list *store.List, item *store.Item, userID string) string {
	siteURL := ""
	if cfg := p.client.Configuration.GetConfig(); cfg != nil && cfg.ServiceSettings.SiteURL != nil {
		siteURL = strings.TrimRight(*cfg.ServiceSettings.SiteURL, "/")
	}
	if siteURL == "" {
		return ""
	}
	var team *model.Team
	if channel.TeamId != "" {
		team, _ = p.client.Team.Get(channel.TeamId)
	} else if teams, err := p.client.Team.List(pluginapi.FilterTeamsByUser(userID)); err == nil && len(teams) > 0 {
		team = teams[0]
	}
	if team == nil {
		return ""
	}
	return fmt.Sprintf("%s/%s/%s/list/%s?item=%s", siteURL, team.Name, manifest.Id, list.ID, item.ID)
}

var markdownEscaper = strings.NewReplacer(`\`, `\\`, "*", `\*`, "_", `\_`, "`", "\\`", "~", `\~`, "[", `\[`, "]", `\]`, "#", `\#`, "|", `\|`, ">", `\>`)

func escapeMarkdown(s string) string {
	return markdownEscaper.Replace(s)
}

// groupMention matches @all, @channel and @here, which notify everyone in a channel.
var groupMention = regexp.MustCompile(`(?i)@(all|channel|here)\b`)

// postTitle is a title made safe to put in a message the plugin posts: its first line
// only, with Markdown escaped and group mentions defused by a zero-width space after the
// @, so a title can't add links, formatting or channel-wide notifications to a bot post.
func postTitle(s string) string {
	first, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	first = escapeMarkdown(strings.TrimSpace(first))
	return groupMention.ReplaceAllString(first, "@\u200b$1")
}

// copyItem snapshots an item before a change, for itemChanged to compare against.
func copyItem(item *store.Item) *store.Item {
	c := *item
	c.Values = maps.Clone(item.Values)
	return &c
}
