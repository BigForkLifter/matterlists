package store

import (
	"database/sql"
	"encoding/json"

	"github.com/pkg/errors"
)

// ErrNotFound is returned when a list, column or item does not exist or was deleted.
var ErrNotFound = errors.New("not found")

// ErrTooManyPhotos is returned by AddPhoto when the cell already has MaxPhotosPerCell photos.
var ErrTooManyPhotos = errors.New("too many photos")

type SQLStore struct {
	db *sql.DB
}

func NewSQLStore(db *sql.DB) *SQLStore {
	return &SQLStore{db: db}
}

func (s *SQLStore) GetListsForChannel(channelID string) ([]*List, error) {
	rows, err := s.db.Query(`
		SELECT l.id, l.channel_id, l.title, l.description, l.creator_id, l.create_at, l.update_at, l.delete_at,
			(SELECT COUNT(*) FROM ml_items i WHERE i.list_id = l.id)
		FROM ml_lists l
		WHERE l.channel_id = $1 AND l.delete_at = 0
		ORDER BY l.create_at`, channelID)
	if err != nil {
		return nil, errors.Wrap(err, "failed to query lists")
	}
	defer func() { _ = rows.Close() }()

	lists := []*List{}
	for rows.Next() {
		l := &List{}
		if err := rows.Scan(&l.ID, &l.ChannelID, &l.Title, &l.Description, &l.CreatorID, &l.CreateAt, &l.UpdateAt, &l.DeleteAt, &l.ItemCount); err != nil {
			return nil, errors.Wrap(err, "failed to scan list")
		}
		lists = append(lists, l)
	}
	return lists, errors.Wrap(rows.Err(), "failed to iterate lists")
}

func (s *SQLStore) GetList(id string) (*List, error) {
	l := &List{}
	err := s.db.QueryRow(`
		SELECT id, channel_id, title, description, creator_id, create_at, update_at, delete_at
		FROM ml_lists WHERE id = $1 AND delete_at = 0`, id).
		Scan(&l.ID, &l.ChannelID, &l.Title, &l.Description, &l.CreatorID, &l.CreateAt, &l.UpdateAt, &l.DeleteAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return l, errors.Wrap(err, "failed to get list")
}

func (s *SQLStore) CreateList(list *List, columns []*Column, items []*Item) error {
	tx, err := s.db.Begin()
	if err != nil {
		return errors.Wrap(err, "failed to begin transaction")
	}
	defer func() { _ = tx.Rollback() }()

	if _, err = tx.Exec(`
		INSERT INTO ml_lists (id, channel_id, title, description, creator_id, create_at, update_at, delete_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
		list.ID, list.ChannelID, list.Title, list.Description, list.CreatorID, list.CreateAt, list.UpdateAt); err != nil {
		return errors.Wrap(err, "failed to insert list")
	}
	for _, c := range columns {
		if err = insertColumn(tx, c); err != nil {
			return err
		}
	}
	for _, it := range items {
		if err = insertItem(tx, it); err != nil {
			return err
		}
	}
	return errors.Wrap(tx.Commit(), "failed to commit list")
}

func (s *SQLStore) UpdateList(list *List) error {
	res, err := s.db.Exec(`
		UPDATE ml_lists SET title = $2, description = $3, update_at = $4
		WHERE id = $1 AND delete_at = 0`,
		list.ID, list.Title, list.Description, list.UpdateAt)
	return checkAffected(res, err, "failed to update list")
}

// DeleteList soft-deletes a list so it can be restored by hand if deleted by mistake.
func (s *SQLStore) DeleteList(id string, deleteAt int64) error {
	res, err := s.db.Exec(`UPDATE ml_lists SET delete_at = $2 WHERE id = $1 AND delete_at = 0`, id, deleteAt)
	return checkAffected(res, err, "failed to delete list")
}

func (s *SQLStore) GetColumns(listID string) ([]*Column, error) {
	rows, err := s.db.Query(`
		SELECT id, list_id, name, type, options, sort_order, create_at
		FROM ml_columns WHERE list_id = $1
		ORDER BY sort_order, create_at`, listID)
	if err != nil {
		return nil, errors.Wrap(err, "failed to query columns")
	}
	defer func() { _ = rows.Close() }()

	columns := []*Column{}
	for rows.Next() {
		c, err := scanColumn(rows)
		if err != nil {
			return nil, err
		}
		columns = append(columns, c)
	}
	return columns, errors.Wrap(rows.Err(), "failed to iterate columns")
}

func (s *SQLStore) GetColumn(id string) (*Column, error) {
	row := s.db.QueryRow(`
		SELECT id, list_id, name, type, options, sort_order, create_at
		FROM ml_columns WHERE id = $1`, id)
	c, err := scanColumn(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return c, err
}

func (s *SQLStore) CreateColumn(column *Column) error {
	if column.SortOrder == 0 {
		if err := s.db.QueryRow(`SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ml_columns WHERE list_id = $1`, column.ListID).Scan(&column.SortOrder); err != nil {
			return errors.Wrap(err, "failed to compute column order")
		}
	}
	return insertColumn(s.db, column)
}

func (s *SQLStore) UpdateColumn(column *Column) error {
	options, err := json.Marshal(column.Options)
	if err != nil {
		return errors.Wrap(err, "failed to encode column options")
	}
	res, err := s.db.Exec(`
		UPDATE ml_columns SET name = $2, options = $3, sort_order = $4 WHERE id = $1`,
		column.ID, column.Name, options, column.SortOrder)
	return checkAffected(res, err, "failed to update column")
}

// DeleteColumn removes the column and its value from every item of the list.
func (s *SQLStore) DeleteColumn(column *Column) error {
	tx, err := s.db.Begin()
	if err != nil {
		return errors.Wrap(err, "failed to begin transaction")
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(`DELETE FROM ml_columns WHERE id = $1`, column.ID)
	if err = checkAffected(res, err, "failed to delete column"); err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE ml_items SET cell_values = cell_values - $2::text WHERE list_id = $1 AND cell_values ? $2::text`, column.ListID, column.ID); err != nil {
		return errors.Wrap(err, "failed to clear column values")
	}
	if _, err = tx.Exec(`DELETE FROM ml_photos WHERE column_id = $1`, column.ID); err != nil {
		return errors.Wrap(err, "failed to delete column photos")
	}
	return errors.Wrap(tx.Commit(), "failed to commit column delete")
}

func (s *SQLStore) GetItems(listID string) ([]*Item, error) {
	rows, err := s.db.Query(`
		SELECT id, list_id, title, cell_values, sort_order, root_post_id, source_post_id, creator_id, create_at, update_at
		FROM ml_items WHERE list_id = $1
		ORDER BY sort_order, create_at`, listID)
	if err != nil {
		return nil, errors.Wrap(err, "failed to query items")
	}
	defer func() { _ = rows.Close() }()

	items := []*Item{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	return items, errors.Wrap(rows.Err(), "failed to iterate items")
}

func (s *SQLStore) GetItem(id string) (*Item, error) {
	row := s.db.QueryRow(`
		SELECT id, list_id, title, cell_values, sort_order, root_post_id, source_post_id, creator_id, create_at, update_at
		FROM ml_items WHERE id = $1`, id)
	it, err := scanItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return it, err
}

// CreateItem appends the item to the end of its list unless it already has a sort order.
func (s *SQLStore) CreateItem(item *Item) error {
	if item.SortOrder == 0 {
		if err := s.db.QueryRow(`SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ml_items WHERE list_id = $1`, item.ListID).Scan(&item.SortOrder); err != nil {
			return errors.Wrap(err, "failed to compute item order")
		}
	}
	return insertItem(s.db, item)
}

func insertItem(db execer, item *Item) error {
	values, err := encodeValues(item.Values)
	if err != nil {
		return err
	}
	_, err = db.Exec(`
		INSERT INTO ml_items (id, list_id, title, cell_values, sort_order, root_post_id, source_post_id, creator_id, create_at, update_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		item.ID, item.ListID, item.Title, values, item.SortOrder, item.RootPostID, item.SourcePostID, item.CreatorID, item.CreateAt, item.UpdateAt)
	return errors.Wrap(err, "failed to insert item")
}

func (s *SQLStore) UpdateItem(item *Item) error {
	values, err := encodeValues(item.Values)
	if err != nil {
		return err
	}
	res, err := s.db.Exec(`
		UPDATE ml_items SET title = $2, cell_values = $3, sort_order = $4, update_at = $5 WHERE id = $1`,
		item.ID, item.Title, values, item.SortOrder, item.UpdateAt)
	return checkAffected(res, err, "failed to update item")
}

// DeleteItem deletes the item and its photos.
func (s *SQLStore) DeleteItem(id string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return errors.Wrap(err, "failed to begin transaction")
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(`DELETE FROM ml_items WHERE id = $1`, id)
	if err = checkAffected(res, err, "failed to delete item"); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM ml_photos WHERE item_id = $1`, id); err != nil {
		return errors.Wrap(err, "failed to delete item photos")
	}
	return errors.Wrap(tx.Commit(), "failed to commit item delete")
}

func (s *SQLStore) SetItemRootPost(itemID, expected, rootPostID string) (string, error) {
	if _, err := s.db.Exec(`UPDATE ml_items SET root_post_id = $3 WHERE id = $1 AND root_post_id = $2`, itemID, expected, rootPostID); err != nil {
		return "", errors.Wrap(err, "failed to set item thread")
	}
	var current string
	err := s.db.QueryRow(`SELECT root_post_id FROM ml_items WHERE id = $1`, itemID).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return current, errors.Wrap(err, "failed to read item thread")
}

func (s *SQLStore) AddPhoto(photo *Photo, full, thumb []byte) (*Item, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, errors.Wrap(err, "failed to begin transaction")
	}
	defer func() { _ = tx.Rollback() }()

	// Locking the item keeps two uploads to the same cell from losing one another.
	var values []byte
	err = tx.QueryRow(`SELECT cell_values FROM ml_items WHERE id = $1 FOR UPDATE`, photo.ItemID).Scan(&values)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, errors.Wrap(err, "failed to lock item")
	}
	cells := map[string]json.RawMessage{}
	if err = json.Unmarshal(values, &cells); err != nil {
		return nil, errors.Wrap(err, "failed to decode item values")
	}
	var ids []string
	if raw, ok := cells[photo.ColumnID]; ok {
		if err = json.Unmarshal(raw, &ids); err != nil {
			return nil, errors.Wrap(err, "failed to decode photos cell")
		}
	}
	if len(ids) >= MaxPhotosPerCell {
		return nil, ErrTooManyPhotos
	}
	cell, err := json.Marshal(append(ids, photo.ID))
	if err != nil {
		return nil, errors.Wrap(err, "failed to encode photos cell")
	}

	if _, err = tx.Exec(`
		INSERT INTO ml_photos (id, list_id, item_id, column_id, creator_id, create_at, width, height, size, data, thumb)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		photo.ID, photo.ListID, photo.ItemID, photo.ColumnID, photo.CreatorID, photo.CreateAt,
		photo.Width, photo.Height, photo.Size, full, thumb); err != nil {
		return nil, errors.Wrap(err, "failed to insert photo")
	}
	if _, err = tx.Exec(`
		UPDATE ml_items SET cell_values = jsonb_set(cell_values, ARRAY[$2::text], $3::jsonb), update_at = $4
		WHERE id = $1`, photo.ItemID, photo.ColumnID, cell, photo.CreateAt); err != nil {
		return nil, errors.Wrap(err, "failed to add photo to item")
	}
	item, err := scanItem(tx.QueryRow(`
		SELECT id, list_id, title, cell_values, sort_order, root_post_id, source_post_id, creator_id, create_at, update_at
		FROM ml_items WHERE id = $1`, photo.ItemID))
	if err != nil {
		return nil, err
	}
	return item, errors.Wrap(tx.Commit(), "failed to commit photo")
}

func (s *SQLStore) GetPhotoImage(id string, thumb bool) (string, []byte, error) {
	var listID string
	var data []byte
	err := s.db.QueryRow(`SELECT list_id, CASE WHEN $2 THEN thumb ELSE data END FROM ml_photos WHERE id = $1`, id, thumb).Scan(&listID, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	return listID, data, errors.Wrap(err, "failed to get photo")
}

// PrunePhotos checks references against the item as it is in the database now, not as a
// caller last saw it, so a photo another request just added is never deleted.
func (s *SQLStore) PrunePhotos(itemID string) error {
	_, err := s.db.Exec(`
		DELETE FROM ml_photos p WHERE p.item_id = $1 AND NOT EXISTS (
			SELECT 1 FROM ml_items i WHERE i.id = p.item_id AND i.cell_values -> p.column_id ? p.id)`, itemID)
	return errors.Wrap(err, "failed to delete removed photos")
}

func (s *SQLStore) GetTemplates(teamID string) ([]*Template, error) {
	rows, err := s.db.Query(`
		SELECT id, team_id, name, description, creator_id, create_at, update_at, content
		FROM ml_templates WHERE team_id = $1 ORDER BY LOWER(name), create_at`, teamID)
	if err != nil {
		return nil, errors.Wrap(err, "failed to query templates")
	}
	defer func() { _ = rows.Close() }()

	templates := []*Template{}
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		templates = append(templates, t)
	}
	return templates, errors.Wrap(rows.Err(), "failed to iterate templates")
}

func (s *SQLStore) GetTemplate(id string) (*Template, error) {
	t, err := scanTemplate(s.db.QueryRow(`
		SELECT id, team_id, name, description, creator_id, create_at, update_at, content
		FROM ml_templates WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return t, err
}

func (s *SQLStore) CreateTemplate(t *Template) error {
	content, err := json.Marshal(t.Content)
	if err != nil {
		return errors.Wrap(err, "failed to encode template")
	}
	_, err = s.db.Exec(`
		INSERT INTO ml_templates (id, team_id, name, description, creator_id, create_at, update_at, content)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		t.ID, t.TeamID, t.Name, t.Description, t.CreatorID, t.CreateAt, t.UpdateAt, content)
	return errors.Wrap(err, "failed to insert template")
}

func (s *SQLStore) UpdateTemplate(t *Template) error {
	res, err := s.db.Exec(`UPDATE ml_templates SET name = $2, description = $3, update_at = $4 WHERE id = $1`,
		t.ID, t.Name, t.Description, t.UpdateAt)
	return checkAffected(res, err, "failed to update template")
}

func (s *SQLStore) DeleteTemplate(id string) error {
	res, err := s.db.Exec(`DELETE FROM ml_templates WHERE id = $1`, id)
	return checkAffected(res, err, "failed to delete template")
}

func scanTemplate(row scanner) (*Template, error) {
	t := &Template{}
	var content []byte
	if err := row.Scan(&t.ID, &t.TeamID, &t.Name, &t.Description, &t.CreatorID, &t.CreateAt, &t.UpdateAt, &content); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		return nil, errors.Wrap(err, "failed to scan template")
	}
	if err := json.Unmarshal(content, &t.Content); err != nil {
		return nil, errors.Wrap(err, "failed to decode template")
	}
	return t, nil
}

type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

type scanner interface {
	Scan(dest ...any) error
}

func insertColumn(db execer, c *Column) error {
	options, err := json.Marshal(c.Options)
	if err != nil {
		return errors.Wrap(err, "failed to encode column options")
	}
	_, err = db.Exec(`
		INSERT INTO ml_columns (id, list_id, name, type, options, sort_order, create_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		c.ID, c.ListID, c.Name, c.Type, options, c.SortOrder, c.CreateAt)
	return errors.Wrap(err, "failed to insert column")
}

func scanColumn(row scanner) (*Column, error) {
	c := &Column{}
	var options []byte
	if err := row.Scan(&c.ID, &c.ListID, &c.Name, &c.Type, &options, &c.SortOrder, &c.CreateAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		return nil, errors.Wrap(err, "failed to scan column")
	}
	if err := json.Unmarshal(options, &c.Options); err != nil {
		return nil, errors.Wrap(err, "failed to decode column options")
	}
	return c, nil
}

func scanItem(row scanner) (*Item, error) {
	it := &Item{}
	var values []byte
	if err := row.Scan(&it.ID, &it.ListID, &it.Title, &values, &it.SortOrder, &it.RootPostID, &it.SourcePostID, &it.CreatorID, &it.CreateAt, &it.UpdateAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		return nil, errors.Wrap(err, "failed to scan item")
	}
	if err := json.Unmarshal(values, &it.Values); err != nil {
		return nil, errors.Wrap(err, "failed to decode item values")
	}
	if it.Values == nil {
		it.Values = map[string]json.RawMessage{}
	}
	return it, nil
}

func encodeValues(values map[string]json.RawMessage) ([]byte, error) {
	if values == nil {
		return []byte("{}"), nil
	}
	b, err := json.Marshal(values)
	return b, errors.Wrap(err, "failed to encode item values")
}

func checkAffected(res sql.Result, err error, msg string) error {
	if err != nil {
		return errors.Wrap(err, msg)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return errors.Wrap(err, msg)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
