# Architecture plan: real DMs, team broadcasts, and cross-room live location

Status: proposed (2026-07-19). Nothing in this document is implemented yet.

## Goals

1. **Direct messages**: send a private message to one crew member that only
   they can read — not a tagged message in the shared ops room that everyone
   can see (the current `api.matrix.send()` behavior).
2. **Team broadcasts**: send a message to all members of one team, visible
   only to that team.
3. **Live location**: crew members share live location from Element X on
   their phones; every active beacon is plotted on CrewBoard's MapBoard,
   regardless of which room it was shared into.
4. **E2EE throughout**: message content and location coordinates should be
   end-to-end encrypted wherever the Matrix ecosystem allows it.

## The key enabler: MSC2762 `timeline:*` (verified in matrix-widget-api source)

The architecture to date assumed a widget can only act in the single room
it's embedded in (see `CLAUDE.md`'s "Single-room constraint"). That's the
default, but not the ceiling. Verified against the vendored
`matrix-widget-api` source (`frontend/node_modules/matrix-widget-api/src`):

- `WidgetApi.requestCapabilityForRoomTimeline(Symbols.AnyRoom)` requests
  `org.matrix.msc2762.timeline:*` — timeline access to **all rooms the
  user's Element client knows**, not just the widget's own room.
- `WidgetApi.sendRoomEvent(type, content, roomId)` takes an explicit target
  room; `ClientWidgetApi.handleSendEvent()` gates it only on
  `canUseRoomTimeline(room_id)` plus the normal per-event-type send
  capability. Same for reads (`readRoomEvents`/`readStateEvents` accept
  room ID lists) and for live pushes (`pushRoomState` iterates
  `getKnownRooms()` when the `*` capability is granted).

So with one capability change, CrewBoard can message into and read from any
room the dispatcher is joined to. What a widget still **cannot** do — there
is no such action in the Widget API — is *create* rooms, invite users, or
manage membership. Room setup stays a native-Element task, done once per
team/person.

This shapes the whole design: **CrewBoard maps entities to rooms; Element
owns the rooms.**

## Design

### Room model

Three kinds of rooms, all created natively in Element by the dispatcher/
admin, all with encryption enabled at creation:

| Room | Created how | Members | Used for |
|---|---|---|---|
| Ops room (exists today) | already exists | everyone + the widget | CrewBoard widget home, activity feed, all-crew broadcasts |
| One team room per team | Element "New room", E2EE on, invite team members | team members + dispatcher | team broadcasts, team beacon sharing |
| One DM room per person | Element "Start chat" with that user | dispatcher + that person | direct messages |

The Postgres schema gains two nullable columns, both stored encrypted like
the other sensitive fields (they reveal the org's room graph):

- `teams.room_id_enc` — the team's broadcast room
- `persons.dm_room_id_enc` — the dispatcher↔person DM room

`db.js` migration: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, consistent
with the existing idempotent-migration approach.

**Room-ID capture UX** (avoids asking anyone to paste `!abc123:server`
strings): a room picker in CrewBoard reads the room list the widget can see.
Implementation options, in preference order: (a) `readRoomAccountData`/
`m.direct` if the host exposes it, (b) a "detect" button that reads recent
`m.room.create`/`m.room.member` state via the `*` timeline capability and
lists candidate rooms by name, (c) manual paste as the fallback. This is
the least-certain part of the plan and is flagged for live verification —
worst case, manual paste always works.

### Direct messages

`DirectMessageModal` (Database view) changes from "post tagged message to
the ops room" to: if `person.dm_room_id` is set, `sendMessage(body)` with
`roomId = dm_room_id` — a genuine private, E2EE'd message, sent **as the
dispatcher** (not as a bot). If unset, the modal shows a one-time setup
hint: "Start a chat with @user in Element, then link it here" with the
room picker, plus an "Open in Element" button using the Widget API's
`navigate` action (MSC2931, also present in the vendored library) to jump
straight to Element's own DM composer as an escape hatch.

The existing tagged-ops-room path remains as the fallback when no DM room
is linked, so nothing regresses.

### Team broadcasts

`api.matrix.broadcast({team_id, ...})` changes from "tagged message in ops
room" to: send to `team.room_id` when linked, fall back to the current
tagged behavior when not. "Broadcast all" keeps using the ops room, which
is already exactly that. Sent as the dispatcher, E2EE'd by Element.

### Live location

Today `readBeacons()`/`subscribeState('m.beacon')` only see beacons shared
into the ops room. With `timeline:*` granted, the same calls (passing no
room filter, or all linked room IDs) surface beacons from every known room
— so crew share live location from Element X into *their team room* (or
the ops room, or their DM), and MapBoard plots all of them. Changes:

- `readBeacons()`: drop the single-room filter; aggregate across rooms;
  de-duplicate per sender keeping the freshest beacon (one person may
  share into several rooms).
- Beacon → person matching already works by `sender` ↔ `persons.matrix_id`
  and is unchanged.
- MapBoard optionally colors the beacon marker by the team of the room it
  arrived from (nice-to-have, not required).

### E2EE analysis (what's actually encrypted)

- **DM + broadcast message content**: E2EE end-to-end. The widget hands
  plaintext to Element over the widget postMessage transport (same-device,
  in-browser); Element encrypts with Megolm before anything touches the
  homeserver. Recipients' Element clients decrypt. The homeserver, and
  CrewBoard's backend, never see content. This is the same guarantee the
  ops-room chat already has.
- **Live location**: per MSC3672, the moving coordinates (`m.beacon`
  timeline events) are E2EE'd in encrypted rooms. Only `m.beacon_info`
  (the "user X is sharing until T" state event) is unencrypted — state
  events can never be E2EE'd (the same fact that drove the Postgres
  migration). Net: the homeserver can see *that* someone is sharing, but
  not *where* they are.
- **Room mappings in Postgres**: encrypted at rest via the existing
  `crypto.js` AES-256-GCM field encryption.
- CrewBoard itself never handles key material anywhere in this design.

## Rejected alternative: backend Matrix bot

A matrix-js-sdk bot account in `crewboard-backend` could create DM/team
rooms and fully automate setup — no "create the room in Element first"
step. Rejected because: messages would come from the bot's identity rather
than the dispatcher's; it reintroduces exactly the server-side E2EE
device/crypto-store burden whose failure modes filled CHANGES.md v1.0.x
(OTK conflicts, cross-signing resets, IDB persistence hacks) and that the
widget migration deliberately deleted; and it adds a credentialed
always-on component to operate. Revisit only if the one-time-native-room-
setup UX proves unacceptable in practice — the room-mapping schema above
would carry over unchanged to a bot that auto-creates rooms and fills in
the mappings itself.

## Implementation phases

1. **Capability + plumbing**: `widget.js` requests
   `org.matrix.msc2762.timeline:*` (replacing the single-room timeline
   capability) and `navigate`; `matrixStore.js` gains room-targeted
   `sendMessage`/`readBeacons` variants; `relay.js` RPC surface extended
   (per `.claude/skills/clientwidget/SKILL.md` — the four-layer pattern).
   Verify Element Web's capability prompt actually grants `*` to a custom
   widget (needs the remove/re-add step learned from the MSC3973 rollout).
2. **Schema + linking UX**: backend columns + routes; room picker /
   manual-paste linking UI on Team and Person edit modals.
3. **DM + broadcast switchover**: modal changes with fallback behavior.
4. **Cross-room beacons**: `readBeacons()` aggregation + MapBoard.
5. **Docs**: CLAUDE.md's single-room constraint section rewritten to
   describe the `timeline:*` model; PAINPOINTS/CHANGES entries.

Each phase is independently shippable; live verification (deploy → test in
real Element, per project convention) gates each before the next starts.

## Risks / open questions

- Element Web must actually grant `timeline:*` to a custom widget via its
  consent prompt — supported in the API and used by Element's own widgets,
  but needs a live click-test before building on it (phase 1 verifies this
  first, cheaply).
- Room-list discovery for the picker UX is the least-standardized piece;
  manual paste is the guaranteed fallback.
- Older `m.beacon` reads relied on the host pushing state for the widget's
  own room; cross-room beacon *push* behavior in Element Web (vs. explicit
  re-reads) needs live verification — worst case MapBoard polls
  `readBeacons()` on the existing 8s cadence it already uses for markers.
- The dispatcher must be a member of every team room to send into it —
  inherent to acting "as the dispatcher," and operationally fine since the
  dispatcher creates these rooms.
