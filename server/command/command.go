package command

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/pluginapi"

	"github.com/BigForkLifter/matterlists/server/store"
)

// The /list command covers the basics for clients that can't load the plugin's webapp,
// such as the Mattermost mobile app.

type Command interface {
	Handle(args *model.CommandArgs) (*model.CommandResponse, error)
}

// NotifyFunc broadcasts that a list in a channel changed.
type NotifyFunc func(channelID, listID, actorID string)

// ItemCreatedFunc lets the plugin tell people mentioned in a new item.
type ItemCreatedFunc func(item *store.Item, actorID string)

type Handler struct {
	client      *pluginapi.Client
	store       store.Store
	notify      NotifyFunc
	itemCreated ItemCreatedFunc
}

const listCommandTrigger = "list"

const helpText = "**MatterLists** — lists in this channel\n" +
	"* `/list ls` — show the channel's lists\n" +
	"* `/list show <list #>` — show a list's items\n" +
	"* `/list new <title>` — create a list; add `from <template>` to start from a template (e.g. `from Checklist`)\n" +
	"* `/list add <list #> <item>` — add an item to a list\n\n" +
	"Open **Lists** from the channel header for the full view."

// Register all your slash commands in the NewCommandHandler function.
func NewCommandHandler(client *pluginapi.Client, s store.Store, notify NotifyFunc, itemCreated ItemCreatedFunc) Command {
	err := client.SlashCommand.Register(&model.Command{
		Trigger:          listCommandTrigger,
		AutoComplete:     true,
		AutoCompleteDesc: "Work with this channel's lists",
		AutoCompleteHint: "[ls|show|new|add|help]",
		AutocompleteData: autocompleteData(),
	})
	if err != nil {
		client.Log.Error("Failed to register command", "error", err)
	}
	return &Handler{client: client, store: s, notify: notify, itemCreated: itemCreated}
}

func autocompleteData() *model.AutocompleteData {
	root := model.NewAutocompleteData(listCommandTrigger, "[command]", "Work with this channel's lists")
	root.AddCommand(model.NewAutocompleteData("ls", "", "Show the channel's lists"))
	show := model.NewAutocompleteData("show", "<list #>", "Show a list's items")
	show.AddTextArgument("Number from /list ls", "<list #>", "")
	root.AddCommand(show)
	create := model.NewAutocompleteData("new", "<title> [from <template>]", "Create a list, optionally from a template")
	create.AddTextArgument("Title of the new list, optionally followed by: from <template>", "<title> [from <template>]", "")
	root.AddCommand(create)
	add := model.NewAutocompleteData("add", "<list #> <item>", "Add an item to a list")
	add.AddTextArgument("Number from /list ls, then the item", "<list #> <item>", "")
	root.AddCommand(add)
	root.AddCommand(model.NewAutocompleteData("help", "", "Show help"))
	return root
}

// ExecuteCommand hook calls this method to execute the commands that were registered in the NewCommandHandler function.
func (c *Handler) Handle(args *model.CommandArgs) (*model.CommandResponse, error) {
	fields := strings.Fields(args.Command)
	if len(fields) == 0 || strings.TrimPrefix(fields[0], "/") != listCommandTrigger {
		return reply(fmt.Sprintf("Unknown command: %s", args.Command)), nil
	}
	if len(fields) == 1 {
		return c.executeLs(args)
	}

	// Keep the text after the subcommand as typed, since item titles may contain spaces.
	_, afterTrigger, _ := strings.Cut(strings.TrimSpace(args.Command), " ")
	_, rest, _ := strings.Cut(strings.TrimSpace(afterTrigger), " ")
	rest = strings.TrimSpace(rest)

	switch fields[1] {
	case "ls":
		return c.executeLs(args)
	case "show":
		return c.executeShow(args, rest)
	case "new":
		return c.executeNew(args, rest)
	case "add":
		return c.executeAdd(args, rest)
	case "help":
		return reply(helpText), nil
	default:
		return reply("Unknown subcommand `" + fields[1] + "`.\n\n" + helpText), nil
	}
}

func (c *Handler) executeLs(args *model.CommandArgs) (*model.CommandResponse, error) {
	if !c.client.User.HasPermissionToChannel(args.UserId, args.ChannelId, model.PermissionReadChannel) {
		return reply("You don't have access to this channel."), nil
	}
	lists, err := c.store.GetListsForChannel(args.ChannelId)
	if err != nil {
		return nil, err
	}
	if len(lists) == 0 {
		return reply("This channel has no lists yet. Create one with `/list new <title>`."), nil
	}
	var b strings.Builder
	b.WriteString("**Lists in this channel**\n")
	for i, l := range lists {
		fmt.Fprintf(&b, "%d. %s — %d %s\n", i+1, escape(l.Title), l.ItemCount, plural(l.ItemCount, "item", "items"))
	}
	b.WriteString("\nShow one with `/list show <list #>`.")
	return reply(b.String()), nil
}

func (c *Handler) executeShow(args *model.CommandArgs, rest string) (*model.CommandResponse, error) {
	list, errText, err := c.listByNumber(args, strings.TrimSpace(rest), false)
	if err != nil || errText != "" {
		return reply(errText), err
	}
	columns, err := c.store.GetColumns(list.ID)
	if err != nil {
		return nil, err
	}
	items, err := c.store.GetItems(list.ID)
	if err != nil {
		return nil, err
	}

	var b strings.Builder
	fmt.Fprintf(&b, "**%s**\n", escape(list.Title))
	if len(items) == 0 {
		b.WriteString("_No items yet._ Add one with `/list add <list #> <item>`.")
		return reply(b.String()), nil
	}
	usernames := map[string]string{}
	for i, it := range items {
		fmt.Fprintf(&b, "%d. %s", i+1, escape(it.Title))
		for _, col := range columns {
			raw := it.Values[col.ID]
			if col.Type == store.ColumnCreatedBy && raw == nil {
				raw, _ = json.Marshal([]string{it.CreatorID})
			}
			if v := c.formatValue(col, raw, usernames); v != "" {
				fmt.Fprintf(&b, " · %s", v)
			}
		}
		b.WriteString("\n")
	}
	return reply(b.String()), nil
}

func (c *Handler) executeNew(args *model.CommandArgs, rest string) (*model.CommandResponse, error) {
	if !c.canWrite(args) {
		return reply("You can't add lists to this channel."), nil
	}
	title, template, err := c.titleAndTemplate(args, rest)
	if err != nil {
		return nil, err
	}
	if title, err = store.ValidateTitle(title, store.MaxTitleLength); err != nil {
		return reply("Give the list a title: `/list new <title>`, or `/list new <title> from <template>`."), nil
	}
	now := model.GetMillis()
	list := &store.List{ID: model.NewId(), ChannelID: args.ChannelId, Title: title, CreatorID: args.UserId, CreateAt: now, UpdateAt: now}
	columns, items := store.Instantiate(template.Content, list.ID, args.UserId, now)
	if err = c.store.CreateList(list, columns, items); err != nil {
		return nil, err
	}
	c.notify(args.ChannelId, list.ID, args.UserId)
	return reply(fmt.Sprintf("Created the list **%s** from the template **%s**. Add items with `/list add <list #> <item>`.", escape(title), escape(template.Name))), nil
}

// titleAndTemplate splits "<title> from <template>". The last " from " counts only if
// what follows names a template, so titles like "Notes from the meeting" still work.
// Without one, the list uses the default template.
func (c *Handler) titleAndTemplate(args *model.CommandArgs, rest string) (string, *store.Template, error) {
	rest = strings.TrimSpace(rest)
	i := strings.LastIndex(strings.ToLower(rest), " from ")
	if i >= 0 {
		templates := store.BuiltinTemplates
		if args.TeamId != "" {
			saved, err := c.store.GetTemplates(args.TeamId)
			if err != nil {
				return "", nil, err
			}
			templates = append(append([]*store.Template{}, templates...), saved...)
		}
		if t := store.FindTemplateByName(templates, rest[i+len(" from "):]); t != nil {
			return rest[:i], t, nil
		}
	}
	return rest, store.BuiltinTemplate(store.DefaultTemplateID), nil
}

func (c *Handler) executeAdd(args *model.CommandArgs, rest string) (*model.CommandResponse, error) {
	number, itemTitle, _ := strings.Cut(strings.TrimSpace(rest), " ")
	list, errText, err := c.listByNumber(args, number, true)
	if err != nil || errText != "" {
		return reply(errText), err
	}
	title, err := store.ValidateTitle(itemTitle, store.MaxTextValueLength)
	if err != nil {
		return reply("Say what to add: `/list add <list #> <item>`."), nil
	}
	now := model.GetMillis()
	item := &store.Item{ID: model.NewId(), ListID: list.ID, Title: title, CreatorID: args.UserId, CreateAt: now, UpdateAt: now}
	if err = c.store.CreateItem(item); err != nil {
		return nil, err
	}
	c.notify(list.ChannelID, list.ID, args.UserId)
	c.itemCreated(item, args.UserId)
	return reply(fmt.Sprintf("Added **%s** to **%s**.", escape(title), escape(list.Title))), nil
}

// listByNumber resolves a 1-based position from /list ls. A non-empty errText is a
// message for the user rather than a failure.
func (c *Handler) listByNumber(args *model.CommandArgs, number string, write bool) (*store.List, string, error) {
	if write && !c.canWrite(args) {
		return nil, "You can't edit lists in this channel.", nil
	}
	if !write && !c.client.User.HasPermissionToChannel(args.UserId, args.ChannelId, model.PermissionReadChannel) {
		return nil, "You don't have access to this channel.", nil
	}
	n, err := strconv.Atoi(number)
	if err != nil || n < 1 {
		return nil, "Give the list's number from `/list ls`.", nil
	}
	lists, err := c.store.GetListsForChannel(args.ChannelId)
	if err != nil {
		return nil, "", err
	}
	if n > len(lists) {
		return nil, fmt.Sprintf("There's no list %d here. See `/list ls`.", n), nil
	}
	return lists[n-1], "", nil
}

func (c *Handler) canWrite(args *model.CommandArgs) bool {
	return c.client.User.HasPermissionToChannel(args.UserId, args.ChannelId, model.PermissionCreatePost)
}

func (c *Handler) formatValue(col *store.Column, raw json.RawMessage, usernames map[string]string) string {
	if raw == nil {
		return ""
	}
	switch col.Type {
	case store.ColumnSelect:
		var id string
		_ = json.Unmarshal(raw, &id)
		return choiceName(col, id)
	case store.ColumnMultiSelect:
		var ids []string
		_ = json.Unmarshal(raw, &ids)
		names := []string{}
		for _, id := range ids {
			if n := choiceName(col, id); n != "" {
				names = append(names, n)
			}
		}
		return strings.Join(names, ", ")
	case store.ColumnPerson, store.ColumnCreatedBy:
		var ids []string
		_ = json.Unmarshal(raw, &ids)
		names := []string{}
		for _, id := range ids {
			if _, ok := usernames[id]; !ok {
				usernames[id] = ""
				if u, err := c.client.User.Get(id); err == nil {
					usernames[id] = "@" + u.Username
				}
			}
			if usernames[id] != "" {
				names = append(names, usernames[id])
			}
		}
		return strings.Join(names, ", ")
	case store.ColumnPhotos:
		var ids []string
		_ = json.Unmarshal(raw, &ids)
		if len(ids) == 1 {
			return "📷 1 photo"
		}
		return fmt.Sprintf("📷 %d photos", len(ids))
	case store.ColumnCheckbox:
		return "✓ " + escape(col.Name)
	case store.ColumnDate:
		var s string
		_ = json.Unmarshal(raw, &s)
		return escape(col.Name) + " " + s
	default:
		var v any
		_ = json.Unmarshal(raw, &v)
		return escape(fmt.Sprint(v))
	}
}

func choiceName(col *store.Column, id string) string {
	for _, ch := range col.Options.Choices {
		if ch.ID == id {
			return escape(ch.Name)
		}
	}
	return ""
}

// escape keeps user text from being read as Markdown in command replies.
func escape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, "*", `\*`, "_", `\_`, "`", "\\`", "~", `\~`, "[", `\[`, "]", `\]`, "#", `\#`, "|", `\|`, ">", `\>`)
	return r.Replace(s)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func reply(text string) *model.CommandResponse {
	return &model.CommandResponse{ResponseType: model.CommandResponseTypeEphemeral, Text: text}
}
