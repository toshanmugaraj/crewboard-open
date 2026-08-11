import pg from 'pg'

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

// Idempotent — safe to run on every startup. IDs are TEXT to keep the same
// "cb-<timestamp>-<counter>" style string IDs the frontend already generates
// elsewhere in this app (see matrixStore.js's newId()), just generated
// server-side now (see ids.js) so two clients can never collide.
// ── Encrypted columns (2026-07-27) ─────────────────────────────────────────
// name/description (teams), make/model/type (vehicles), and lat/lng/label
// (markers) moved from plaintext columns to _enc TEXT columns, same
// treatment as phone_enc/license_plate_enc/note_enc/room_id_enc below —
// client-encrypted (roomCrypto.js, mx1: blobs this backend can't read) with
// this backend's own AES as a fallback/legacy path (crypto.js). presets and
// settings moved from JSONB (items/data) to a single encrypted TEXT blob
// each (items_enc/data_enc) — the whole array/object is JSON-stringified
// then encrypted as one field client-side, so the backend never sees the
// map view state or message-preset templates in the clear either. This is a
// destructive schema change (no ALTER-based migration from the old plaintext
// columns) — the room's existing data must be wiped first, not upgraded in
// place.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name_enc TEXT NOT NULL,
  description_enc TEXT,
  color TEXT,
  created_at BIGINT,
  updated_at BIGINT
);

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_enc TEXT,
  matrix_id_enc TEXT,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  image_mxc TEXT,
  created_at BIGINT,
  updated_at BIGINT
);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  make_enc TEXT NOT NULL,
  model_enc TEXT NOT NULL,
  type_enc TEXT,
  license_plate_enc TEXT,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  person_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
  image_mxc TEXT,
  created_at BIGINT,
  updated_at BIGINT
);

CREATE TABLE IF NOT EXISTS markers (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  lat_enc TEXT NOT NULL,
  lng_enc TEXT NOT NULL,
  locked BOOLEAN DEFAULT false,
  label_enc TEXT,
  note_enc TEXT,
  color TEXT,
  created_at BIGINT,
  updated_at BIGINT
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY DEFAULT 'default',
  items_enc TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  data_enc TEXT
);

-- ── Room mappings (messaging_architecture_plan.md) ─────────────────────────
-- Nullable, encrypted-at-rest like phone/matrix_id/license_plate/note above
-- (a room ID reveals the org's room graph, so it gets the same treatment).
-- CREATE TABLE IF NOT EXISTS above doesn't add columns to a table that
-- already exists from a prior deploy, hence the separate ADD COLUMN IF NOT
-- EXISTS here, consistent with this file's idempotent-migration approach.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS room_id_enc TEXT;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS dm_room_id_enc TEXT;

-- ── Per-room scoping (2026-07-21) ──────────────────────────────────────────
-- Every row now belongs to exactly one Matrix room: a room's widget only
-- ever sees its own rows, and only users with power level >= 50 in that room
-- can write them (see auth.js). Deliberately named owner_room_id, NOT
-- room_id, to avoid confusion with the pre-existing and completely different
-- teams.room_id_enc (a team's linked broadcast room) and
-- persons.dm_room_id_enc (a dispatcher<->person DM room) above.
--
-- Stored in PLAINTEXT, unlike those two. Those are encrypted because they're
-- incidental payload; this one is the partition key for every query in the
-- app and has to be indexable/filterable, which an AES-GCM column (random IV
-- per write, so the same room encrypts differently every time) fundamentally
-- can't be. Same trade-off already made for the name and coordinate columns. Note the
-- backend necessarily knows which room it's serving on every request anyway.
ALTER TABLE teams    ADD COLUMN IF NOT EXISTS owner_room_id TEXT;
ALTER TABLE persons  ADD COLUMN IF NOT EXISTS owner_room_id TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS owner_room_id TEXT;
ALTER TABLE markers  ADD COLUMN IF NOT EXISTS owner_room_id TEXT;

-- ── Ad hoc vehicle tagging on misc markers (2026-07-26) ────────────────────
-- The \car/\motorcycle text command (frontend/src/vehicleCommands.js) turns
-- a plain chat message into a marker WITHOUT a linked vehicles row — the
-- field crew member never created one, they just sent "\car <lat>,<lon>".
-- entity_type stays 'misc' for these (no entity_id to point at a real DB
-- row), but the map still needs to know which glyph to
-- draw. Distinct from the pre-existing vehicle_type derivation in api.js
-- (marker.vehicle_type from a JOINed vehicles.type) — that path stays for
-- markers actually linked to a database vehicle; this column is the
-- fallback for ones that aren't.
ALTER TABLE markers  ADD COLUMN IF NOT EXISTS vehicle_type TEXT;

CREATE INDEX IF NOT EXISTS idx_persons_team_id ON persons(team_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_team_id ON vehicles(team_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_person_id ON vehicles(person_id);
CREATE INDEX IF NOT EXISTS idx_markers_entity ON markers(entity_type, entity_id);

-- Every list query filters on owner_room_id, so index all four.
CREATE INDEX IF NOT EXISTS idx_teams_owner_room ON teams(owner_room_id);
CREATE INDEX IF NOT EXISTS idx_persons_owner_room ON persons(owner_room_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_owner_room ON vehicles(owner_room_id);
CREATE INDEX IF NOT EXISTS idx_markers_owner_room ON markers(owner_room_id);

-- ── Live updates: LISTEN/NOTIFY instead of the frontend polling ────────────
-- Replaces the 8s poll in Layout.jsx (see PAINPOINTS.md's "live updates
-- regressed" note from when teams/markers/etc. moved off Matrix state
-- events, which used to push live). A trigger on every table fires
-- pg_notify() with a small {table, op, id} payload on any INSERT/UPDATE/
-- DELETE; notify.js holds one dedicated LISTEN connection and fans the
-- notifications out over SSE to every connected browser tab — see
-- routes/events.js. Payload is intentionally tiny (Postgres caps NOTIFY
-- payloads at 8000 bytes) — clients re-fetch the actual data themselves via
-- the normal REST routes rather than trusting stale row content pushed
-- through the channel.
CREATE OR REPLACE FUNCTION crewboard_notify_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('crewboard_changes', json_build_object(
    'table', TG_TABLE_NAME,
    'op', TG_OP,
    'id', COALESCE(NEW.id, OLD.id)
  )::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_teams_notify ON teams;
CREATE TRIGGER trg_teams_notify AFTER INSERT OR UPDATE OR DELETE ON teams
  FOR EACH ROW EXECUTE FUNCTION crewboard_notify_change();

DROP TRIGGER IF EXISTS trg_persons_notify ON persons;
CREATE TRIGGER trg_persons_notify AFTER INSERT OR UPDATE OR DELETE ON persons
  FOR EACH ROW EXECUTE FUNCTION crewboard_notify_change();

DROP TRIGGER IF EXISTS trg_vehicles_notify ON vehicles;
CREATE TRIGGER trg_vehicles_notify AFTER INSERT OR UPDATE OR DELETE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION crewboard_notify_change();

DROP TRIGGER IF EXISTS trg_markers_notify ON markers;
CREATE TRIGGER trg_markers_notify AFTER INSERT OR UPDATE OR DELETE ON markers
  FOR EACH ROW EXECUTE FUNCTION crewboard_notify_change();

DROP TRIGGER IF EXISTS trg_presets_notify ON presets;
CREATE TRIGGER trg_presets_notify AFTER INSERT OR UPDATE OR DELETE ON presets
  FOR EACH ROW EXECUTE FUNCTION crewboard_notify_change();

DROP TRIGGER IF EXISTS trg_settings_notify ON settings;
CREATE TRIGGER trg_settings_notify AFTER INSERT OR UPDATE OR DELETE ON settings
  FOR EACH ROW EXECUTE FUNCTION crewboard_notify_change();
`

// Rows that predate per-room scoping have owner_room_id = NULL, which would
// make them invisible to every room's widget (all queries filter on it) —
// effectively an unannounced data loss on upgrade. Adopt them into
// CREWBOARD_ROOM_ID, which is the room this deployment was already
// hardcoded to serve before scoping existed (see auth.js), so existing data
// keeps showing up exactly where it always did.
//
// Their encrypted fields are deliberately left alone: they stay in the
// legacy unprefixed format and keep decrypting with the master key (see
// crypto.js's decryptField). Re-encrypting them under the room-derived key
// would be a destructive rewrite of every row, and the format tag exists
// precisely so both can coexist indefinitely.
const BACKFILL_TABLES = ['teams', 'persons', 'vehicles', 'markers']

async function backfillOwnerRoom() {
  const roomId = process.env.CREWBOARD_ROOM_ID
  if (!roomId) {
    console.warn(
      'CREWBOARD_ROOM_ID is not set — skipping owner_room_id backfill. Any rows ' +
      'created before per-room scoping will be invisible to every room until ' +
      'their owner_room_id is set manually.'
    )
    return
  }
  for (const table of BACKFILL_TABLES) {
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET owner_room_id = $1 WHERE owner_room_id IS NULL`,
      [roomId]
    )
    if (rowCount > 0) {
      console.log(`Backfilled ${rowCount} pre-scoping ${table} row(s) to room ${roomId}`)
    }
  }

  // presets/settings are single-row tables that used the literal id
  // 'default'; they're keyed by room id now (see routes/presets.js,
  // routes/settings.js). Rename rather than copy, and only if the room
  // doesn't already have its own row, so this stays idempotent across
  // restarts and can't clobber post-migration data.
  for (const table of ['presets', 'settings']) {
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET id = $1
        WHERE id = 'default'
          AND NOT EXISTS (SELECT 1 FROM ${table} WHERE id = $1)`,
      [roomId]
    )
    if (rowCount > 0) {
      console.log(`Migrated pre-scoping ${table} row from 'default' to room ${roomId}`)
    }
  }
}

export async function runMigrations() {
  await pool.query(SCHEMA)
  await backfillOwnerRoom()
}
