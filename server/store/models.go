package store

import "encoding/json"

// ColumnType identifies how a column's cell values are shaped and edited.
type ColumnType string

const (
	ColumnText        ColumnType = "text"
	ColumnNumber      ColumnType = "number"
	ColumnSelect      ColumnType = "select"
	ColumnMultiSelect ColumnType = "multi_select"
	ColumnPerson      ColumnType = "person"
	ColumnDate        ColumnType = "date"
	ColumnCheckbox    ColumnType = "checkbox"
	ColumnURL         ColumnType = "url"

	// ColumnPhotos holds photo IDs (rows of ml_photos) in the order they were added.
	// Photos are added only by uploading one; a patch can remove or reorder them.
	ColumnPhotos ColumnType = "photos"

	// ColumnCreatedBy shows who created each item: the item's CreatorID, unless someone
	// set a different person, which is stored like a person value. Clearing it goes back
	// to the creator.
	ColumnCreatedBy ColumnType = "created_by"
)

// List is a set of items that belongs to one channel. Anyone who can post in
// the channel can edit it.
type List struct {
	ID          string `json:"id"`
	ChannelID   string `json:"channel_id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	CreatorID   string `json:"creator_id"`
	CreateAt    int64  `json:"create_at"`
	UpdateAt    int64  `json:"update_at"`
	DeleteAt    int64  `json:"delete_at"`

	// ItemCount is filled in only by GetListsForChannel.
	ItemCount int `json:"item_count"`
}

// Choice is one option of a select or multi-select column.
type Choice struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// ColumnOptions holds the type-specific settings of a column.
type ColumnOptions struct {
	Choices []Choice `json:"choices,omitempty"`
}

type Column struct {
	ID        string        `json:"id"`
	ListID    string        `json:"list_id"`
	Name      string        `json:"name"`
	Type      ColumnType    `json:"type"`
	Options   ColumnOptions `json:"options"`
	SortOrder float64       `json:"sort_order"`
	CreateAt  int64         `json:"create_at"`
}

// Item is one row of a list. Values holds each cell keyed by column ID; a
// column with no value has no key.
type Item struct {
	ID           string                     `json:"id"`
	ListID       string                     `json:"list_id"`
	Title        string                     `json:"title"`
	Values       map[string]json.RawMessage `json:"values"`
	SortOrder    float64                    `json:"sort_order"`
	RootPostID   string                     `json:"root_post_id"`
	SourcePostID string                     `json:"source_post_id"`
	CreatorID    string                     `json:"creator_id"`
	CreateAt     int64                      `json:"create_at"`
	UpdateAt     int64                      `json:"update_at"`
}

// Photo is an uploaded picture in a photos cell. Its JPEG bytes, full size and as a
// thumbnail, live in ml_photos too but are loaded only when served.
type Photo struct {
	ID        string `json:"id"`
	ListID    string `json:"list_id"`
	ItemID    string `json:"item_id"`
	ColumnID  string `json:"column_id"`
	CreatorID string `json:"creator_id"`
	CreateAt  int64  `json:"create_at"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Size      int    `json:"size"`
}

// Store is the persistence layer for lists, columns and items.
type Store interface {
	GetListsForChannel(channelID string) ([]*List, error)
	GetList(id string) (*List, error)
	// CreateList creates the list with its columns and any starting items.
	CreateList(list *List, columns []*Column, items []*Item) error
	UpdateList(list *List) error
	DeleteList(id string, deleteAt int64) error

	GetColumns(listID string) ([]*Column, error)
	GetColumn(id string) (*Column, error)
	CreateColumn(column *Column) error
	UpdateColumn(column *Column) error
	DeleteColumn(column *Column) error

	GetItems(listID string) ([]*Item, error)
	GetItem(id string) (*Item, error)
	CreateItem(item *Item) error
	UpdateItem(item *Item) error
	DeleteItem(id string) error
	// SetItemRootPost sets the item's thread to rootPostID if its current thread is
	// still expected, and returns the root post ID the item ends up with.
	SetItemRootPost(itemID, expected, rootPostID string) (string, error)

	// AddPhoto stores a photo and appends it to its item's cell in one transaction,
	// returning the updated item. It fails with ErrTooManyPhotos when the cell is full.
	AddPhoto(photo *Photo, full, thumb []byte) (*Item, error)
	// GetPhotoImage returns a photo's list ID and its JPEG bytes, full size or thumbnail.
	GetPhotoImage(id string, thumb bool) (listID string, data []byte, err error)
	// PrunePhotos deletes the item's photos that none of its cells refer to any more.
	PrunePhotos(itemID string) error

	// GetTemplates returns a team's saved templates, by name. Built-in ones aren't stored.
	GetTemplates(teamID string) ([]*Template, error)
	GetTemplate(id string) (*Template, error)
	CreateTemplate(t *Template) error
	UpdateTemplate(t *Template) error
	DeleteTemplate(id string) error
}
