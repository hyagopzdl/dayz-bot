CREATE TABLE IF NOT EXISTS dayz_items (
  class_name TEXT PRIMARY KEY,
  popular_name TEXT NOT NULL,
  image_url TEXT,
  spawn_event_name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dayz_items_enabled_idx
ON dayz_items (enabled);

CREATE INDEX IF NOT EXISTS dayz_items_popular_name_idx
ON dayz_items (popular_name);
