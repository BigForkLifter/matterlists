package store

import (
	"database/sql"

	"github.com/pkg/errors"
)

// migrationLockKey serializes migrations across cluster nodes activating the plugin at once.
const migrationLockKey = 7_301_947_112

// migrations run in order, once each. Every statement is idempotent as well, so a
// database whose ml_migrations table was truncated can safely replay them.
var migrations = []string{
	`CREATE TABLE IF NOT EXISTS ml_lists (
		id          VARCHAR(26) PRIMARY KEY,
		channel_id  VARCHAR(26) NOT NULL,
		title       VARCHAR(256) NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		creator_id  VARCHAR(26) NOT NULL,
		create_at   BIGINT NOT NULL,
		update_at   BIGINT NOT NULL,
		delete_at   BIGINT NOT NULL DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS idx_ml_lists_channel ON ml_lists (channel_id, delete_at);

	CREATE TABLE IF NOT EXISTS ml_columns (
		id         VARCHAR(26) PRIMARY KEY,
		list_id    VARCHAR(26) NOT NULL,
		name       VARCHAR(128) NOT NULL,
		type       VARCHAR(32) NOT NULL,
		options    JSONB NOT NULL DEFAULT '{}',
		sort_order DOUBLE PRECISION NOT NULL,
		create_at  BIGINT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_ml_columns_list ON ml_columns (list_id);

	CREATE TABLE IF NOT EXISTS ml_items (
		id             VARCHAR(26) PRIMARY KEY,
		list_id        VARCHAR(26) NOT NULL,
		title          TEXT NOT NULL,
		cell_values    JSONB NOT NULL DEFAULT '{}',
		sort_order     DOUBLE PRECISION NOT NULL,
		root_post_id   VARCHAR(26) NOT NULL DEFAULT '',
		source_post_id VARCHAR(26) NOT NULL DEFAULT '',
		creator_id     VARCHAR(26) NOT NULL,
		create_at      BIGINT NOT NULL,
		update_at      BIGINT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_ml_items_list ON ml_items (list_id, sort_order);`,

	// Photos are kept here rather than in Mattermost's file store, because the plugin
	// API can't delete files from the file store and removed photos must be deleted.
	`CREATE TABLE IF NOT EXISTS ml_photos (
		id         VARCHAR(26) PRIMARY KEY,
		list_id    VARCHAR(26) NOT NULL,
		item_id    VARCHAR(26) NOT NULL,
		column_id  VARCHAR(26) NOT NULL,
		creator_id VARCHAR(26) NOT NULL,
		create_at  BIGINT NOT NULL,
		width      INT NOT NULL,
		height     INT NOT NULL,
		size       INT NOT NULL,
		data       BYTEA NOT NULL,
		thumb      BYTEA NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_ml_photos_item ON ml_photos (item_id);
	CREATE INDEX IF NOT EXISTS idx_ml_photos_column ON ml_photos (column_id);`,

	// Saved list templates, shared with everyone in a team. content is a
	// TemplateContent snapshot, so later changes to the source list don't affect it.
	`CREATE TABLE IF NOT EXISTS ml_templates (
		id          VARCHAR(26) PRIMARY KEY,
		team_id     VARCHAR(26) NOT NULL,
		name        VARCHAR(256) NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		creator_id  VARCHAR(26) NOT NULL,
		create_at   BIGINT NOT NULL,
		update_at   BIGINT NOT NULL,
		content     JSONB NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_ml_templates_team ON ml_templates (team_id);`,
}

// Migrate brings the schema up to date.
func Migrate(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return errors.Wrap(err, "failed to begin migration transaction")
	}
	defer func() { _ = tx.Rollback() }()

	if _, err = tx.Exec(`SELECT pg_advisory_xact_lock($1)`, migrationLockKey); err != nil {
		return errors.Wrap(err, "failed to acquire migration lock")
	}
	if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS ml_migrations (version INT PRIMARY KEY, applied_at BIGINT NOT NULL)`); err != nil {
		return errors.Wrap(err, "failed to create migrations table")
	}

	var current int
	if err = tx.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM ml_migrations`).Scan(&current); err != nil {
		return errors.Wrap(err, "failed to read schema version")
	}

	for i := current; i < len(migrations); i++ {
		version := i + 1
		if _, err = tx.Exec(migrations[i]); err != nil {
			return errors.Wrapf(err, "failed to apply migration %d", version)
		}
		if _, err = tx.Exec(`INSERT INTO ml_migrations (version, applied_at) VALUES ($1, EXTRACT(EPOCH FROM NOW()) * 1000)`, version); err != nil {
			return errors.Wrapf(err, "failed to record migration %d", version)
		}
	}

	return errors.Wrap(tx.Commit(), "failed to commit migrations")
}
