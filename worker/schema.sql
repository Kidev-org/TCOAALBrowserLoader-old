-- Install counter for the Mods menu (see worker/src/index.js).
--
-- One row per mod, created on that mod's first install. Ids are validated
-- against the live mods.json before any write, so this table only ever holds
-- real mods (~34 rows today) and stays far inside D1's free storage.
--
-- Apply with:
--   wrangler d1 execute tcoaal-installs --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS installs (
  mod_id     TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
