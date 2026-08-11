# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Frontend and backend are separate projects now (see Architecture below for why).

```bash
cd frontend
npm install       # install dependencies
npm run dev       # Vite dev server on http://localhost:5173
npm run build     # production build to frontend/dist/
npm run preview   # preview the production build

cd backend
npm install       # install dependencies
npm start         # runs src/index.js against $DATABASE_URL — needs a real Postgres, no local-only mode
```

There are no lint or test scripts configured anywhere in this repo. There is no `npm run test` — don't invent one.

Note: opening `http://localhost:5173` directly in a browser tab is expected to fail with a "Couldn't connect to Element" screen. The app only initializes once it's loaded inside Element as a registered Custom Widget (see README.md for the registration URL and flow) — it has no session or room to talk to outside that context.

## Architecture

CrewBoard is a **Matrix Element Web Widget** (`frontend/`) — a React app that runs inside an `<iframe>` hosted by Element — **plus a small backend** (`backend/`, Express + Postgres) for the parts of the app that need real encryption at rest. This is a deliberate hybrid, not a full backend migration: messaging, identity/auth, and live location still come entirely from the Matrix room via the Widget API, with no separate login and no messaging service of CrewBoard's own. Only the "database" entities (teams/persons/vehicles/markers/presets/settings) live in Postgres now.

**Why not pure Matrix room state for everything** (this was the original architecture — see `implementation_plan.md` for the full history): Matrix room **state** events can never be end-to-end encrypted, even in a room with E2EE turned on — only room **message** events go through Megolm. Since CrewBoard's "database" was stored as state events, sensitive fields (phone numbers, Matrix IDs, license plates) were always in plaintext on the homeserver regardless of the room's encryption setting. `backend/` fixes this: sensitive columns are encrypted server-side with a key the frontend never has access to (see `backend/src/crypto.js`). Room state as a datastore also has real scalability ceilings (state resolution cost, ~65KB/event cap, no server-side indexing) that a real database doesn't.

**Auth has no separate login system.** The backend trusts the same Matrix OpenID token the widget already gets for free via `getOpenIdToken()` (originally added for media uploads) — see `backend/src/auth.js`. There's no password table, no CrewBoard-specific account system; if your homeserver vouches for the token, the backend trusts you.

### Frontend data/messaging stack (`frontend/src/`)

- **`widget.js`** — Owns the single `WidgetApi` connection to the Element host. `initWidget()` performs the handshake and requests every capability the app needs up front (state read/write for `m.beacon`, room message send/receive for the message-based types below). `getRoomId()` and `getOpenIdToken()` are used by the layers above.
- **`matrixStore.js`** — What's left of the old Matrix-only data layer: messaging helpers (`sendMessage`, `sendRoomEvent`, `readInbox`, `readBeacons`), live event subscription (`subscribeState`, still used for `m.beacon` and `m.room.message`), and media upload (`uploadMedia` — uploads straight to the homeserver's media repo using a short-lived OpenID token, not through the Widget API). No longer has a generic state-event CRUD layer — that moved to the backend.
- **`apiClient.js`** — Thin `fetch()` wrapper for `backend/`'s REST API, attaching the Matrix OpenID token (`Authorization: Bearer ...` + `X-Matrix-Server-Name`) to every request. Caches the token until it's close to expiry rather than requesting a fresh one per call.
- **`api.js`** — The interface views actually call (`api.teams.*`, `api.persons.*`, `api.vehicles.*`, `api.markers.*`, `api.matrix.*`, `api.settings.*`). `api.teams/persons/vehicles/markers/presets/settings` call the backend via `apiClient.js`, doing the same client-side joins the old SQL backend and the Matrix-state version both did (attaching `team_name`/`team_color`, resolving `linked_vehicle`/`linked_person` on markers). `api.matrix.*` is unchanged — still calls `matrixStore.js` directly, since messaging stayed on Matrix. When adding a feature, extend `api.js`'s surface rather than calling `apiClient.js`/`matrixStore.js` directly from views.

### Backend (`backend/src/`)

Express + `pg`, one router per entity under `routes/`, plus `routes/backup.js` (JSON export/import of a room's whole dataset — admin-only, since an export decrypts every protected field into a plaintext file). `db.js` runs idempotent `CREATE TABLE IF NOT EXISTS` migrations on startup — no separate migration tool/step — and backfills pre-scoping rows to `CREWBOARD_ROOM_ID`. `crypto.js` does AES-256-GCM field encryption (phone, matrix_id, license_plate, marker notes) with a **per-room key derived via HKDF-SHA256** from the `ENCRYPTION_KEY` env var, so one room's key never opens another's; values written this way carry a `v2:` prefix, and unprefixed legacy values still decrypt with the master key directly (no bulk re-encrypt needed).

**Sensitive fields are now client-encrypted with a room-member-only key (2026-07-22) — the backend's own AES is a fallback/legacy path.** `frontend/src/roomCrypto.js` generates a random AES-256 key K in-browser and publishes it as an `org.crewboard.keyring` room *message* event, which Element Megolm-encrypts — so only room members hold K; the homeserver and this backend cannot read it. The widget encrypts phone/matrix_id/dm_room_id/license_plate/marker note/team room_id client-side (`api.js`) and stores them as opaque `mx1:` blobs. `crypto.js` passes `mx1:` values through untouched in both directions, so client-encrypted rows and legacy backend-encrypted (`v2:`/unprefixed) rows coexist with no destructive migration.

**Encrypted set expanded (2026-07-27), destructive schema change.** Added `markers.lat`/`lng`/`label`, `teams.name`/`description`, `vehicles.make`/`model`/`type` to the client-encrypted set above (now `lat_enc`/`lng_enc`/`label_enc`, `name_enc`/`description_enc`, `make_enc`/`model_enc`/`type_enc` columns), plus `presets.items` and `settings.data` — the latter two as a single JSON-stringified-then-encrypted TEXT blob each (`items_enc`/`data_enc`) rather than per-field, since they're each one JSONB value, not a row of separate columns. `lat`/`lng` round-trip as strings through `decryptValue()` (it only ever returns a string, `mx1:` blob, or null) — `api.js`'s `markers.list()`/`backup.export()` `Number()`-ify them back after decrypting, since the backend can't (`routes/markers.js` may only ever see an undecryptable `mx1:` blob). `settings.patch()` lost its server-side field-level merge as a result — it can no longer read individual fields out of ciphertext — so `api.js`'s `settings.update()` does a client-side read-decrypt-merge-encrypt-write cycle instead and sends the whole already-merged blob; accepted trade-off is that two tabs updating settings at once can now race (last write wins) where the old merge was atomic per request. Unlike the earlier phone/matrix_id/etc. rollout, this was a **destructive** schema change — no `v2:`/unprefixed coexistence path for the renamed columns, since the column types/names themselves changed (e.g. `markers.lat` `DOUBLE PRECISION` → `lat_enc` `TEXT`) — a room's existing data must be wiped before upgrading rather than migrated in place. New joiners get K via `m.room.history_visibility: shared` plus republish-on-join; the app is encrypted-rooms-only (`main.jsx` refuses unencrypted rooms). Accepted tradeoff: if all members lose their Matrix keys, `mx1:` data is unrecoverable — the admin JSON export (which decrypts client-side) is the backup. This is the design that got around the "widgets can't do Matrix crypto" wall: don't encrypt *through* the Widget API (it has no crypto primitive — its `MatrixCapabilities` list has nothing for crypto, and `sendToDevice` is device signalling), encrypt the *key* by riding Element's own message E2EE, then do field crypto client-side. The backend AES below still exists for the fallback/legacy path and for anything not in the client-encrypted set — whatever value you set `ENCRYPTION_KEY` to, back it up; losing it makes all backend-encrypted data permanently unreadable. `auth.js` verifies the widget's Matrix OpenID token against the homeserver's federation `userinfo` endpoint, then (if `SYNAPSE_ADMIN_TOKEN`/`CREWBOARD_ROOM_ID` are configured) additionally checks the verified user against the CrewBoard room's live membership via Synapse's admin API, rejecting non-members with 403 — see `auth.js`'s own comments for why that admin token typically has to be minted out-of-band (e.g. via Matrix Authentication Service's `mas-cli` on an MAS-fronted homeserver) rather than through Synapse's normal registration path. Deletes are real (`DELETE FROM ...`) now, not tombstoned — Postgres doesn't have Matrix room state's append-only constraint.

### Data model

**Per-room scoping (2026-07-21).** Every row in `teams`/`persons`/`vehicles`/`markers` carries an `owner_room_id` — the Matrix room that owns it. A room's widget only ever sees its own rows: the frontend sends `X-Crewboard-Room-Id` (`apiClient.js`, from `getRoomId()`; the SSE route takes `?room_id=` since `EventSource` can't set headers) and every query in `backend/src/routes/*` filters on it. Writes additionally require **power level 50+** (moderator/admin) in that room — `requireRoomWriter()` in `auth.js`, applied to every POST/PUT/DELETE. Reads are open to any room member. `presets`/`settings` are keyed by room id instead of the old literal `'default'`; `settings` is deliberately *not* power-gated because it stores map view state that `MapBoard.jsx` writes on every pan/zoom.

Don't confuse `owner_room_id` (plaintext, the partition key — it has to be indexable) with the pre-existing and unrelated `teams.room_id_enc` (a team's linked broadcast room) and `persons.dm_room_id_enc` (a dispatcher↔person DM room), which are encrypted.

| Entity | Where it lives | Notes |
|---|---|---|
| Teams | Postgres (`teams` table) | `name`/`description` encrypted at rest (2026-07-27); `color` in the clear; scoped by `owner_room_id` |
| Persons | Postgres (`persons` table) | `phone`/`matrix_id` encrypted at rest; scoped by `owner_room_id` |
| Vehicles | Postgres (`vehicles` table) | `make`/`model`/`type`/`license_plate` encrypted at rest (make/model/type added 2026-07-27); scoped by `owner_room_id` |
| Markers | Postgres (`markers` table) | `note`/`lat`/`lng`/`label` encrypted at rest (lat/lng/label added 2026-07-27, now `TEXT` columns — no longer native `DOUBLE PRECISION`; the app `Number()`s them back after decrypting, see above); scoped by `owner_room_id` |
| Presets | Postgres (`presets` table) | single row; the whole array is one encrypted TEXT blob (`items_enc`, 2026-07-27, was JSONB) |
| Settings | Postgres (`settings` table) | single row; the whole object is one encrypted TEXT blob (`data_enc`, 2026-07-27, was JSONB) |
| Chat / broadcasts | Matrix room message (`m.room.message`) | E2EE'd by Element if the room is encrypted |
| Shared contact/vehicle cards, location shares | Matrix room message (`org.crewboard.contact`, `org.crewboard.vehicle-card`, `org.crewboard.location`) | same — E2EE'd by Element |
| Live location beacons | Matrix state (`m.beacon`) | written by mobile Element clients, not CrewBoard — read-only from this app's side |

**Live updates**: markers/teams/persons/vehicles no longer get pushed live from Element (they're not state events anymore), but they are still pushed live — via Postgres `LISTEN`/`NOTIFY` instead. Every table has an `AFTER INSERT OR UPDATE OR DELETE` trigger (`db.js`) that calls `pg_notify('crewboard_changes', ...)`; `backend/src/notify.js` holds one dedicated (non-pooled) connection subscribed to that channel and fans notifications out over Server-Sent Events (`backend/src/routes/events.js`); `frontend/src/realtime.js` consumes that stream and re-dispatches the same `crewboard:*-updated` `window` `CustomEvent`s views listen for (`crewboard:markers-updated`, `crewboard:rooms-updated`, `crewboard:persons-updated`, `crewboard:vehicles-updated`). `m.beacon` and `m.room.message` are still genuinely pushed by Element in real time, unaffected by the backend move.

### Cross-room messaging (real DMs, team broadcasts, cross-room beacons)

Superseded the old "single-room constraint" below — see `messaging_architecture_plan.md` for the full design. `widget.js` requests `org.matrix.msc2762.timeline:*` (`Symbols.AnyRoom`) instead of a single-room timeline capability, which — per `ClientWidgetApi.canUseRoomTimeline()` — grants `sendRoomEvent`/`readRoomEvents`/`readStateEvents` access to **every room the dispatcher's Element client is joined to**, not just the widget's own room. `matrixStore.js`'s `sendMessage`/`sendRoomEvent` take an optional `roomId` to target a specific room; `readBeacons()` reads `m.beacon` across `Symbols.AnyRoom` and de-duplicates per sender.

CrewBoard maps entities to rooms, not the other way around: `teams.room_id` (a team's dedicated broadcast room) and `persons.dm_room_id` (a dispatcher↔person DM room) are optional, encrypted-at-rest Postgres columns, linked via a manual room-ID paste in the Team/Person edit modals (`Teams.jsx`, `Database.jsx`) — there's an "Open in Element" escape hatch (`widget.js`'s `navigateTo()`/`roomMatrixToUri()`/`userMatrixToUri()`, MSC2931) for jumping to Element to create/find the room. `api.matrix.send()`/`broadcast()` use the linked room when present (private, genuinely E2EE'd by Element) and fall back to the original tagged-message-in-the-ops-room behavior when not linked, so nothing regresses for unlinked people/teams.

What a widget still **cannot** do — there's no such action anywhere in `matrix-widget-api` — is create rooms, invite users, or manage room membership; that stays a native-Element, one-time setup step per team/person. `MatrixHub.jsx` remains a single-room activity feed for the shared ops room specifically, not a general room list.

**Team roster is fully decoupled from `team.room_id` (2026-08-10).** `persons.team_id` is a plain manual assignment — set from a Team `<Select>` in `Database.jsx`'s `PersonModal` — and is never written by anything else. `team.room_id` survives purely as an optional broadcast target for `api.matrix.broadcast()`; creating/saving a team no longer requires a room, and linking one no longer imports or syncs anyone. This replaced an earlier design (`api.teams.syncMembersFromRooms()`, `api.persons.importFromRoom()`/`syncFromRoom()`, plus a live `autoTeam` derivation in `Database.jsx`) that treated a linked room's Matrix membership as the roster's source of truth, both adding and removing people's `team_id` to match who was currently in the room. That caused two real bugs: a DM room is only ever 2 people by definition, so linking one as a team's room shrank the roster to ~1 person on every sync; and a person who was a member of more than one relevant room (or simply hadn't left an old one) could get silently unassigned, since "not currently in this room" was being treated as "left the team." The Team modal's room-coverage alert (`Teams.jsx`) is now purely informational — "N of this team's members are actually in the picked broadcast room" — and never mutates anyone's `team_id`.

MapBoard's live-location beacon dots (`MapBoard.jsx`'s `makeBeaconIcon`) are plotted from `matrixStore.js`'s `readBeacons()`, which implements the confirmed MSC3672 protocol: `m.beacon_info` is a state event per sender announcing a live-sharing session (`content.live`/`content.timeout`, no coordinates); `m.beacon` is a separate *timeline* (room) event carrying the actual moving coordinates in `content['m.location'].uri` (a `geo:lat,lon;u=accuracy` URI), linked back to its `m.beacon_info` via `content['m.relates_to'].event_id`. `readBeacons()` reads both event types across every known room (`Symbols.AnyRoom`), joins `m.beacon` events to their still-live `m.beacon_info`, and de-dupes per sender keeping the freshest coordinate. Still worth a live re-check against a real Element X share before fully trusting it in the field.

### Views and routing

`main.jsx` waits on `initWidget()` before mounting the `HashRouter` (no login screen — the widget inherits Element's already-authenticated session). Routes map 1:1 to `frontend/src/views/`: `MapBoard` (Leaflet map + markers), `Teams`, `Database` (persons/vehicles + photo upload via media repo), `MatrixHub` (room activity feed + compose), `Settings`. `Layout.jsx` renders the nav/toast/online-status chrome and dispatches the `window` `CustomEvent`s (`crewboard:markers-updated`, `crewboard:rooms-updated`) that views listen for to refresh — on an 8s poll now for markers/teams (see "Live updates" above), still via `subscribeState()` from `matrixStore.js` for `m.beacon` and `m.room.message`.

### Styling

`index.css` uses an Element Web/Compound-inspired palette (CSS custom properties like `--accent`, `--surface`, `--radius`) — keep new UI consistent with these variables rather than hardcoding colors.

## Repository conventions

- Keep a running changelog (e.g. `CHANGES.md`, newest first) of notable fixes/migrations as the project grows — future contributors (and future Claude Code sessions) should be able to check it before assuming why something is implemented a certain way.
- `implementation_plan.md` documents the full migration from the original Electron + local-backend/Signal-messaging architecture to this Matrix Widget architecture, including the functional-parity checklist and open questions (e.g. whether a stateless backend is ever needed for things the Widget API can't do, like PDF generation).
