# Location-tag handoff — Element iOS/Android

## Background

CrewBoard has a crew -> dispatcher location-tagging feature: a crew member
marks their shared location as "this is my car", "this is my motorcycle",
"this is me", or a general point of interest, and CrewBoard drops/moves the
corresponding pin on the map automatically.

The **old** way to do this (still working, not being removed yet) is a typed
chat command: send a plain text message like `\car 26.22,50.59` into the
room. It works everywhere (any client can send a text message) but has a
real gap — CrewBoard only watches for it on its own **live** message
subscription, so a command sent while nobody has CrewBoard open in that room
is simply missed forever (see `vehicleCommands.js` in the CrewBoard repo for
the full writeup of why, and why a history-replay fix was tried and then
deliberately reverted).

The **new** way (widget-side support already shipped, this document is the
other half) uses Element's own native "share location" feature instead of a
typed command, plus one small addition the client needs to make: after
sharing, also publish a tiny **room state event** pointing at the share.
State events (unlike the chat message itself) are always retrievable the
instant a widget reconnects — with no dependency on having been subscribed
live at the moment it was sent — which is what actually closes the "missed
while closed" gap. This is the whole reason CrewBoard asked for a state
event here rather than, say, a second timeline message: a second message
would have the exact same "must be online to see it" problem as the chat
command it's replacing.

**iOS has now shipped this (2026-08).** The two design questions below were
originally open and are resolved by the iOS implementation; Android should
follow the same answers unless something Android-specific forces a
divergence — see "Suggested UI" and "Visual feedback in the client" below
for the reasoning, not just the conclusions.

**This cannot be done with configuration alone.** Stock Element iOS/Android
has no hook, setting, or plugin point for "after the user shares a location,
also publish this other event." Implementing this side of the handoff
requires an actual code change in the Element client (or a
CrewBoard-specific companion feature inside it) — the same category of work
as the `element-web` fork CrewBoard already maintains for its
picture-in-picture patch. Budget for this as a client feature, not a config
toggle.

## What to send

### 1. The location share itself — unchanged

Keep using Element's existing native "share location" UI and whatever event
it already sends (a real `m.room.message` with `msgtype: 'm.location'`).
Nothing about that event needs to change. You'll need the resulting
`event_id` for step 2, so the location share must actually complete (get an
event ID back from the homeserver) before step 2 can run.

**iOS note on getting that `event_id` — read this before wiring up step 2.**
The original plan was to tag *at share time*, in the same sheet as "Share
selected location," sending the tag immediately after the share call
returned. That doesn't work cleanly: none of the client SDKs hand back an
`event_id` synchronously from a send call — what you get back locally is a
transaction ID for the local echo, and the real `event_id` only shows up
once the homeserver round-trip completes and the local echo is replaced by
the remote echo. Tagging at share time means either polling/waiting
(observed to take up to several seconds, worse on bad connections) for that
echo to resolve, or accepting a race where a fast second tag could point at
the wrong `event_id`. iOS tried the polling approach first and abandoned it
— see "Suggested UI" below for what shipped instead, which sidesteps the
problem entirely by only offering tagging once the message is already a
confirmed, real timeline item.

### 2. New: a state event pointing at it

**Event type:** `org.crewboard.location-tag`

**State key:** the sharer's own Matrix user ID (e.g.
`@jamie:crewboard.example.org`). One pending tag per user at a time — if the
same user shares another tagged location before the previous one has been
processed, just overwrite the same state key with the new pointer. (This
matches the existing `\car`/`\motorcycle` command's own dedupe model — see
"tag semantics" below — so keeping it to one state key per sender is
intentional, not a limitation to work around.)

**Content:**

```json
{
  "event_id": "$abc123...",
  "tag": "car",
  "ts": 1785900000000
}
```

- `event_id`: the event ID of the `m.location` message just sent in step 1.
- `tag`: one of `"car"`, `"motorcycle"`, `"person"`, or `"misc"` (see tag
  semantics below). Any other string is treated as `"misc"` on the
  CrewBoard side, so it's safe to add new tag strings later without
  coordinating a CrewBoard release first, as long as the fallback behavior
  (a one-off point-of-interest pin) is an acceptable default for whatever
  new tag you introduce.
- `ts`: client-side send time in epoch milliseconds. Not currently read by
  CrewBoard, but include it for future debugging/ordering.

**Do not include coordinates, labels, or any other descriptive field in this
event.** State events are never end-to-end encrypted, regardless of whether
the room itself is encrypted — CrewBoard deliberately keeps this content to
just an event-ID pointer and a short tag string so the only thing exposed
to the homeserver operator as plaintext is "a share tagged `car` happened,
pointing at message X," not the actual location. The real coordinates stay
protected by whatever encryption the room already applies to the `m.location`
message itself (Megolm, since CrewBoard requires encrypted rooms), and
separately again once CrewBoard writes them into its own database.

### Tag semantics (so you can pick sensible defaults/UI copy)

| Tag | What CrewBoard does with it |
|---|---|
| `car` / `motorcycle` | Moves/creates one pin for this sender, styled as a vehicle marker. A repeat share with the same tag from the same sender moves the existing pin rather than creating a new one. |
| `person`, sender recognized as a known CrewBoard person | Moves that person's own marker on the map — this is the "this is really me" case. |
| `person`, sender not a known CrewBoard person, or `misc`, or anything else | Creates a new one-off point-of-interest pin labeled with the sender's name (and the location message's text body, if any). Each share is treated as a distinct point, not a moving pin. |

## Permissions

Sending a custom state event of a type nobody's locked down needs only the
room's default `state_default` power level (usually 0 — any member).
CrewBoard's own write gate (power level 50+, required for CrewBoard's
Postgres-backed writes) does **not** apply here at all — this is a plain
Matrix state event, gated purely by whatever the room's own
`m.room.power_levels` says for `state_default`/`events`. Worth a quick check
per-room if a specific deployment has locked that down further than the
Matrix default.

## What NOT to worry about

- **Clearing/consuming the tag.** That's entirely CrewBoard's job — once it
  turns a pending tag into a marker, it overwrites the state event's content
  to `{}` itself. The client never needs to clean up after itself; always
  just publish a fresh pointer with the real `event_id`/`tag` for the
  current share.
- **Race conditions with multiple CrewBoard instances.** CrewBoard's own
  processing is idempotent and safe to run redundantly (dedupe is handled
  server-side against existing markers). Not something the client needs to
  coordinate around.
- **Retrying a failed send.** If the state event send fails, just retry it
  the normal way your client already retries a failed Matrix API call —
  there's no CrewBoard-specific retry protocol.

## Suggested UI (as shipped on iOS — follow this on Android too)

**Don't put tagging in the share sheet.** Leave "Share selected location" /
"Share live location" exactly as stock Element has them — no upfront tag
picker, no "Share as Car" style combined action. This was tried on iOS first
and reverted once the `event_id`-availability problem above became clear.

**Instead, add tagging to the long-press / context menu on an
already-shared location message in the timeline** — the same menu that
already has Reply, Forward, Copy link to message, Pin, View source, Remove
message, etc. Add four new actions there: **Tag as Car**, **Tag as
Motorcycle**, **Tag as Me**, **Tag as Other**, sending the `person`/`car`/
`motorcycle`/`misc` tag values from the table above respectively.

This is strictly better than tagging at share time, not just a workaround:

- **The event ID problem disappears.** A message already sitting in the
  timeline necessarily has a real, confirmed `event_id` — there's nothing to
  wait for or poll.
- **Gate the menu entry on it anyway, defensively.** Only show the four tag
  actions when the item (a) is a location message, (b) was sent by the
  current user (the state event is keyed by the sharer's own user ID — a
  user shouldn't be able to publish a tag claiming to be someone else's
  share), and (c) has a resolved event ID, not a pending local echo. In
  practice condition (c) is rarely reachable through this menu at all since
  most clients don't offer a long-press menu on a message that's still
  sending, but check for it explicitly rather than assuming.
- **Retagging is natural.** The same four actions stay available after the
  first tag — tapping a different one just re-publishes the state event
  with the new tag (per "one pending tag per user at a time" above, this is
  a plain overwrite, nothing special needed).

## Visual feedback in the client (new — not in the original plan)

The original version of this document didn't address what the *sending*
client itself shows after tagging. On iOS this turned out to matter:
publishing the state event alone gives the user **zero visible confirmation**
that tagging worked, because state events aren't rendered as timeline
content by any of the client SDKs' normal message-list APIs — you'd have to
build a bespoke "read this custom state event back and overlay a badge on
the map bubble" path, and **the underlying SDK (MatrixRustSDK, and very
possibly your platform's SDK too — check before assuming otherwise) has no
API to read an arbitrary custom state event back at all**, only to send one.
There's no live-subscription hook for it either. This isn't a CrewBoard-side
gap — it's a client SDK gap, and it's very likely the same wall Android will
hit if its SDK follows the same pattern (no generic "read/subscribe to
custom state event type X" call, only typed accessors for event types the
SDK already knows about).

**What iOS does instead:** alongside the state event, it also sends a
regular `m.reaction` on the same location message, using the tag as the
reaction key:

| Tag | Reaction key |
|---|---|
| `car` | `🚗 Car` |
| `motorcycle` | `🏍️ Motorcycle` |
| `person` | `📍 Me` |
| `misc` | `❓ Other` |

Reactions are ordinary, already-supported Matrix content — every client SDK
sends, syncs, and renders them under the message bubble with no new
plumbing, and unlike the state event they're visible to every member's
client in real time. This makes the reaction the thing users actually see
and rely on as "yes, this got tagged," while the state event stays the
single source of truth CrewBoard's own tag-processing logic reads from — the
reaction is purely a same-client, human-facing echo of that state, not a
second protocol CrewBoard needs to understand or consume.

When the user retags an already-tagged location (e.g. switches from Car to
Motorcycle), the client should remove its own previous tag reaction (if any
of the four keys above is present and was added by the current user) before
adding the new one, so at most one of these four reactions is showing at a
time per tagging user. Tapping the same tag a message is already tagged with
again is fine to treat as a toggle-off (untag) if that falls out naturally
from how your reaction-sending call works — iOS's does, since its
`toggleReaction` primitive is inherently a toggle, not an unconditional add.
This has no effect on CrewBoard's own processing either way; it's UI-only.
If your platform's SDK *does* turn out to expose a way to read the state
event back later, this whole reaction layer is safe to keep anyway (or drop)
— it doesn't conflict with the state event in any way.

Skipping tagging entirely (never invoking any of the four menu actions) is
completely fine — the location still shares normally, it just won't
automatically become a CrewBoard marker.

## Rollout note

Because this is additive (a new state event alongside the unchanged
location share), it can ship independently on iOS and Android without
needing to land at the same time, and without breaking anything for users
on either platform who haven't updated yet — the `\car`/`\motorcycle` text
command keeps working the whole time as a fallback until this is verified
in the field on both platforms.
