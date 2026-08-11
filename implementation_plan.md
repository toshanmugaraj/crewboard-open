# Architecture & Migration Plan: CrewBoard Element Web Widget

This plan outlines the architecture and migration strategy to transition CrewBoard from an Electron + local Node backend application (with a server-side Matrix bot client) into a **Matrix Element Web Widget**. As a widget, CrewBoard runs inside Element and uses Element's existing Synapse authentication, authorization, and end-to-end encryption (E2EE) directly — no bundled Matrix client, no local crypto store, no Signal dependency of any kind.

**Signal is fully removed from this plan.** The current codebase already migrated its messaging transport from `signal-cli` to Matrix (see `backend-node/matrixClient.js`); this migration finishes the job by (a) deleting the last leftover "Signal" branding/labels in the UI and any stale `api.signal.*` calls, and (b) moving messaging out of a self-hosted bot into the Widget API, so Element itself — not a Node process running matrix-js-sdk — owns the Matrix session, crypto, and key backup.

---

## Proposed Architecture

The client application runs inside an `<iframe>` hosted by Element. Communication between the widget and the Element host occurs over the standard Matrix Widget API.

```
┌────────────────────────────────────────────────────────┐
│                     Element Client                     │
│  ┌─────────────────┐             ┌──────────────────┐  │
│  │   Widget host   │◄───────────►│ Matrix Widget API│  │
│  │ (Iframe window) │ postMessage │  (Capabilities)  │  │
│  └────────┬────────┘             └────────┬─────────┘  │
└───────────┼───────────────────────────────┼────────────┘
            │                               │
            ▼ (Render Widget)               ▼ (Read/Write Events,
┌───────────────────────────────┐           │  Send Messages,
│     CrewBoard Widget App      │           │  OIDC Token Request)
│ (React + matrix-widget-toolkit)           │
│   - Leaflet Map                │          │
│   - Team & Staff DB Views      │          │
│   - Matrix Hub (chat/inbox)    │          │
└───────────────────────────────┘           │
                                            ▼
                              ┌───────────────────────────┐
                              │     Synapse Homeserver    │
                              │ - Room State (Data DB)    │
                              │ - Room Messages            │
                              │ - Media Repo (images)      │
                              └───────────────────────────┘
```

### 1. Authentication & Authorization
* **No local login, no bot account:** The widget utilizes Element's active session instead of the current `backend-node/matrixClient.js` bot login. It requests an **OpenID Connect (OIDC) token** via the Widget API (`get_openid` command) to verify the user's identity against the Synapse Homeserver for any request that needs it.
* **No server-side crypto store:** The Node backend's Olm/cross-signing persistence (`backend-node/idbPersistence.js`, `~/.crewboard/idb-state.json`) is eliminated entirely. E2EE is handled by Element's own crypto stack; the widget never touches key material.
* **Capabilities Request:** The widget declares its required Matrix capabilities (MSC2762) — reading/sending specific room state events and message events. Element prompts the user to grant these on first load.

### 2. Data Storage (Matrix as the Database)
Currently, CrewBoard's Node backend (`backend-node/database.js`, `backend-node/routers/*.js`) stores teams, persons, vehicles, and markers. As a widget:
* **Room State Events:** Data storage moves to Matrix custom room state events in the room the widget is added to:
  * `org.crewboard.team` (state keys: team IDs)
  * `org.crewboard.person` (state keys: person IDs)
  * `org.crewboard.vehicle` (state keys: vehicle IDs)
  * `org.crewboard.marker` (state keys: marker IDs)
  * `org.crewboard.preset` (state keys: preset IDs) — replaces the current `matrix.presets()` / `updatePresets()` backend endpoints
* **Real-time Synchronization:** Subscribing to state event updates via the Widget API means all widget instances in the room sync instantly on create/update/delete, eliminating the current SSE push loop in `backend-node/server.js`.

### 3. Messaging & Encryption
* **Native E2EE only:** All messaging — direct messages, team broadcasts, contact cards, vehicle cards, screenshots, and static locations — is sent as standard Matrix events (`m.room.message` / custom `org.crewboard.*` msgtypes) within the room. Element encrypts these automatically if the room is encrypted. There is no external messaging service, no `signal-cli`, and no phone-number-based recipient model — recipients are addressed by Matrix ID / room membership.
* **Location Sharing:** The Leaflet map renders live locations by reading Matrix location/beacon state events (`m.beacon`) sent by mobile Element clients, and static "send location" messages become a custom `org.crewboard.location` message event rendered as a map preview card in the timeline.

---

## User Review Required

> [!IMPORTANT]
> **Data Security and Visibility**
> In a Matrix room, state events (where teams, persons, and markers are stored) are readable by **all room members** with access to the room. State events are not E2EE (only message events are), so sensitive personal details (phone numbers, staff/vehicle records) will be visible in plaintext to the Synapse homeserver administrators. If this is a concern, we'll need to store that data as encrypted message events instead of state events, or run a stateless encrypting proxy.

---

## UI Redesign — Element Web Style

Since CrewBoard now lives inside Element as a widget, its UI should look and feel native to Element Web rather than like a standalone dark-themed Electron app. Concretely:

* **Design tokens:** Replace the current ad-hoc palette in `frontend/src/index.css` (`--accent: #4e7fff`, `--bg: #0f1117`, etc.) with Element Web's Compound Design tokens — `--cpd-color-bg-canvas-default`, `--cpd-color-bg-subtle-secondary`, `--cpd-color-text-primary`, `--cpd-color-icon-accent-tertiary`, and Element's signature accent green (`#0DBD8B`) / interactive blue (`#368BD6`), in both light and dark variants, following Element's theme switch instead of a single hardcoded dark theme.
* **Typography & spacing:** Keep Inter (already used), but adopt Element's type scale and 8px spacing/radius rhythm (Element uses larger corner radii on cards/dialogs than the current `--radius: 6px`).
* **Layout:** Rework `Layout.jsx`'s left nav (`Map Board`, `Teams`, `Database`, `Matrix Hub`) to resemble Element's left panel treatment — icon rail with labels, active-item pill highlight, consistent with how Element's own room list / space panel look — rather than the current custom sidebar.
* **Components:** Restyle modals (`AddMarkerModal`, `SendLocationModal`, `ScreenshotModal`, contact/vehicle-share dialogs in `Database.jsx`) to match Element's dialog component (rounded surface, header/body/footer split, primary/secondary button pairing) and restyle the toast/notification system (`useToast.jsx`, `Layout.jsx`'s chime) to match Element's toast/notification styling.
* **Messaging surfaces:** `MatrixHub.jsx`'s inbox and any in-widget message previews should mirror Element's timeline conventions — avatar + sender + timestamp, read receipts style, event bubbles — since users will be flipping between the widget and Element's own timeline in the same room.
* **Iconography:** Continue using the existing Tabler icon set (`ti-*`) where there's no direct Element equivalent, but align icon sizing/weight with Element's icon system for visual consistency.
* **Branding cleanup:** Remove every remaining "Signal" string from the UI — button labels ("Send via Signal" → "Send"), modal titles ("Send location via Signal" → "Send location"), toasts ("sent via Signal" → "sent"), and the stale code comment in `Layout.jsx` ("same base64 WAV as signal version"). Nothing in the shipped UI should reference Signal.

---

## Functional Parity Checklist

Every feature currently in the app must survive the migration. This maps each existing feature to its widget-era equivalent so nothing is dropped:

| Area | Current implementation | Widget equivalent |
|---|---|---|
| Team CRUD | `frontend/src/views/Teams.jsx` + `backend-node/routers/teams.js` | `org.crewboard.team` state events |
| Person CRUD + photo | `Database.jsx` + `routers/persons.js` (`/persons/:id/image`) | `org.crewboard.person` state events; photo uploaded to Matrix media repo, stored as MXC URI |
| Vehicle CRUD + photo | `Database.jsx` + `routers/vehicles.js` | `org.crewboard.vehicle` state events; photo via MXC URI |
| Map markers (add/edit/delete/clear) | `MapBoard.jsx`, `AddMarkerModal.jsx`, `MarkerPopup.jsx` + `routers/markers.js` | `org.crewboard.marker` state events, live-synced via Widget API subscriptions |
| Send static location | `SendLocationModal.jsx` → `api.matrix.sendLocation` | Custom `org.crewboard.location` message event, rendered as a map-preview card |
| Live location beacons | Read from `matrix.locations(roomId)` cache | Read directly from `m.beacon` state events via Widget API |
| Send map screenshot | `ScreenshotModal.jsx` → `api.matrix.sendScreenshot` | Screenshot uploaded to media repo, sent as `m.image` message event |
| Team broadcast | `Teams.jsx` → `api.matrix.broadcast` | `m.room.message` sent to the team's room (or fanned out to member DMs) |
| Direct message to a person | `Database.jsx` → `api.matrix.sendMessage` | `m.room.message` to that person's DM room |
| Send contact card | `Database.jsx` → `api.matrix.sendContact` | Custom `org.crewboard.contact` message event, rendered as a contact card |
| Send vehicle card | `Database.jsx` → `api.matrix.sendVehicle` | Custom `org.crewboard.vehicle-card` message event |
| Message presets | `Teams.jsx` / `Database.jsx` / `MapBoard.jsx` → `api.matrix.presets` | `org.crewboard.preset` state events |
| Matrix Hub (rooms, inbox, verification, crypto status) | `MatrixHub.jsx` + `routers/matrix_hub.js` | Rooms/members/invites via Widget API; per-user E2EE verification and crypto status are now handled natively by Element (no custom verification flow needed) |
| Setup wizard / login | `SetupWizard.jsx` → `api.matrix.setupLogin` | Removed — the widget inherits Element's existing logged-in session; no login screen needed |
| Settings (passphrase, message clearing) | `Settings.jsx` + `routers/settings.js` | Passphrase/local-encryption settings are no longer needed (no local DB to protect); "clear messages" becomes "leave/clear widget data" scoped to room state |
| Real-time sync | SSE push from `backend-node/server.js` | Native Widget API state/event subscriptions |
| Online/offline indicator, toasts, notification chime | `Layout.jsx`, `useToast.jsx` | Unchanged in behavior, restyled to Element Web look |

---

### 🛠️ Frontend Component

#### [MODIFY] [package.json](file:///Users/demo/Documents/Live/crewboard/frontend/package.json)
* Add `@matrix-org/matrix-widget-api` and `@nordeck/matrix-widget-toolkit`.
* Remove unused Electron-specific code and dependencies.

#### [NEW] [widget-setup](file:///Users/demo/Documents/Live/crewboard/frontend/src/widget.js)
* Initialize `WidgetApi` and request the following capabilities:
  * `org.matrix.msc2762.receive.state_event:org.crewboard.team`
  * `org.matrix.msc2762.send.state_event:org.crewboard.team`
  * `org.matrix.msc2762.receive.state_event:org.crewboard.person`
  * `org.matrix.msc2762.send.state_event:org.crewboard.person`
  * `org.matrix.msc2762.receive.state_event:org.crewboard.vehicle`
  * `org.matrix.msc2762.send.state_event:org.crewboard.vehicle`
  * `org.matrix.msc2762.receive.state_event:org.crewboard.marker`
  * `org.matrix.msc2762.send.state_event:org.crewboard.marker`
  * `org.matrix.msc2762.receive.state_event:org.crewboard.preset`
  * `org.matrix.msc2762.send.state_event:org.crewboard.preset`
  * `org.matrix.msc2762.receive.state_event:m.beacon`
  * `org.matrix.msc2762.send.event:m.room.message`
  * `org.matrix.msc2762.send.event:org.crewboard.location`
  * `org.matrix.msc2762.send.event:org.crewboard.contact`
  * `org.matrix.msc2762.send.event:org.crewboard.vehicle-card`

#### [MODIFY] [api.js](file:///Users/demo/Documents/Live/crewboard/frontend/src/api.js)
* Remove all `fetch('http://127.0.0.1:8765/api/...')` calls and the `matrix` namespace's REST wrapper; replace with Widget API state/event reads and writes.
* Delete any remaining `api.signal.*` call sites in `SendLocationModal.jsx`, `ScreenshotModal.jsx`, `Teams.jsx`, `MapBoard.jsx`, and `Database.jsx` — these currently reference a `signal` namespace that no longer exists in `api.js` and must be pointed at the new Widget API equivalents instead.
* Implement state-event updates for database operations:
  ```js
  // Example for creating a team
  widgetApi.sendStateEvent('org.crewboard.team', teamId, teamData);
  ```

#### [MODIFY] [index.css](file:///Users/demo/Documents/Live/crewboard/frontend/src/index.css)
* Replace the custom dark palette with Element Web's Compound design tokens (light + dark theme support).
* Update `--radius`, spacing, and component styles to match Element's dialogs, buttons, and toasts (see UI Redesign section above).

#### [MODIFY] UI text/branding
* `Layout.jsx`, `SendLocationModal.jsx`, `ScreenshotModal.jsx`, `Teams.jsx`, `MapBoard.jsx`, `Database.jsx`: remove all "Signal" strings (button labels, modal titles, toast text, code comments).
* `README.md`, `BUILD_INSTRUCTIONS.md`: remove `signal-cli` prerequisites, install steps, and API endpoint table entries; document the Widget API architecture instead.

### 🛠️ Backend / Infra

#### [REMOVE] `backend-node/` (pending Open Question #1)
* `matrixClient.js`, `idbPersistence.js`, and all `routers/*.js` are retired if going fully serverless; their responsibilities move to the Widget API as described above.
