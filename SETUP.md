# CrewBoard — Developer Setup Guide

## Prerequisites

- Node.js 18+
- Access to a Matrix homeserver and an Element client (Element Web is
  easiest for development) to host the widget
- A room to test in

There's no Python backend, no Electron, no native modules, and no
Java/signal-cli — the whole project is the `frontend/` Vite app.

---

## First-time setup

### 1. Install dependencies

```bash
cd frontend
npm install
```

### 2. Start the dev server

```bash
npm run dev
```

This starts Vite on `http://localhost:5173`. Opening that URL directly in a
browser tab shows a "Couldn't connect to Element" screen — that's expected.
CrewBoard only initializes once it's loaded inside Element as a registered
widget, because it has no session or room to read/write until then.

### 3. Register it as a widget

In Element Web, open the room you want to test in, then **Room settings →
Widgets → Add a widget → Custom Widget**, and point it at:

```
http://localhost:5173/?widgetId=$matrix_widget_id&roomId=$matrix_room_id&theme=$org.matrix.msc2873.client_theme
```

Element substitutes the `$matrix_widget_id` / `$matrix_room_id` placeholders
itself when it loads the widget. The `theme` placeholder is what lets
CrewBoard start in Element's actual current theme (light/dark) instead of
falling back to the OS-level `prefers-color-scheme` — without it, the widget
and Element can visibly disagree on light vs. dark (see `main.jsx`'s
`ThemeSync` component). An already-registered widget won't pick this up
retroactively — the registration URL is baked into room state at add-widget
time, so an existing CrewBoard instance needs its widget re-added (or its
URL edited) with this parameter included.

### 4. Accept the capability prompt

On first load, Element asks you to approve the capabilities CrewBoard
requests — reading/writing its `org.crewboard.*` state events, reading
`m.beacon` live locations, and sending/receiving room messages. Accept them;
without this the widget will load but every read/write will fail.

---

## How data flows

There is no database to inspect and no server log to tail — everything
CrewBoard does is a Matrix Widget API call:

- **Teams / Persons / Vehicles / Markers / Presets / Settings** — Matrix
  room state events (`org.crewboard.team`, `.person`, `.vehicle`, `.marker`,
  `.preset`, `.settings`), one state key per row. See `frontend/src/matrixStore.js`.
- **Messaging** — `m.room.message` events, plus custom `org.crewboard.contact`,
  `org.crewboard.vehicle-card`, and `org.crewboard.location` message events.
  See `api.matrix.*` in `frontend/src/api.js`.
- **Photos / screenshots** — uploaded to the homeserver's media repo over
  a short-lived OpenID token from the Widget API (`get_openid`), not stored
  by CrewBoard itself.

You can inspect all of this directly from Element's own developer tools
(**Settings → Help & About → Advanced → View source** and the room's state
event list) since CrewBoard doesn't hide anything behind a private API.

---

## Project structure

```
crewboard/
├── frontend/
│   └── src/
│       ├── widget.js         # Widget API handshake + capability requests
│       ├── matrixStore.js    # Room state/event data layer
│       ├── api.js            # Call surface used by the views
│       ├── views/
│       │   ├── MapBoard.jsx    # Leaflet map
│       │   ├── Teams.jsx
│       │   ├── Database.jsx    # Staff/vehicle management
│       │   ├── MatrixHub.jsx   # Room activity feed + compose
│       │   └── Settings.jsx
│       └── components/
│           └── Layout.jsx      # Nav, live state subscriptions, toasts
├── Dockerfile / nginx.conf     # Static hosting for the built widget
└── implementation_plan.md      # Full architecture & migration plan
```

---

## Known limitations to design around

- A widget only has capabilities for the single room it's added to — there
  is no cross-room inbox or room management inside CrewBoard; use Element's
  own room list/settings for that (see `MatrixHub.jsx`'s info banner).
- "Direct messages" and team broadcasts are posted to the shared room,
  tagged with the intended recipient — they are not private DMs, since a
  room widget can't act outside its own room.
- Device verification and E2EE key management are entirely Element's — 
  CrewBoard has no verification UI of its own.

---

## Troubleshooting

**"Couldn't connect to Element" on load**
The widget wasn't opened with a `widgetId` in the URL — it needs to be
loaded through Element's widget registration flow, not a bare browser tab.

**State reads/writes fail silently**
Check that you accepted the capability prompt when the widget first loaded.
Capabilities can also be reviewed/reset from Element's widget settings for
that room.

**Photos don't upload**
`getOpenIdToken()` in `widget.js` requires the `baseUrl` widget query
parameter (or an OIDC response that includes `matrix_server_name`) to know
which homeserver to upload to — confirm your widget registration URL
includes it, or that Element is passing it through.
