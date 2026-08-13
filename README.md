# CrewBoard

Field crew management and dispatch tool. Manage promotional staff and vehicles on a live map, communicate over Matrix, and maintain a full crew database — all as a **Matrix Element Web Widget** running inside Element.

---

## Screenshots

| Live location | Team & vehicle roster |
|---|---|
| ![Live location sharing](screenshots/livelocation.png) | ![Persons and vehicles roster](screenshots/team.jpg) |

---

## Stack

- **React + Vite** — Frontend UI, built as a static bundle
- **matrix-widget-api** — Talks to the Element host over the standard Matrix Widget API (MSC2762)
- **Express + Postgres** (`backend/`) — Encrypted-at-rest storage for teams/persons/vehicles/markers/presets/settings; sensitive fields are additionally end-to-end encrypted client-side with a key shared over Matrix's own E2EE (see `CLAUDE.md`)
- **Matrix room messages** — Chat, contact cards, vehicle cards, and location shares are room message events, E2EE'd by Element like any other message
- **Leaflet + OpenStreetMap** — Map (free, no API key required, though see `frontend/src/views/MapBoard.jsx` for tile-server notes)
- **Nginx / any static host** — Serves the built widget over HTTPS (required by Element)

There is no separate login system and no messaging service of CrewBoard's own — auth reuses the widget's Matrix OpenID token, and messaging/live location stay entirely on Matrix. Only the "database" entities live in Postgres. See `CLAUDE.md` for the full architecture writeup.

---

## Prerequisites

- Node.js 18+ and npm
- A Postgres database for the backend
- A Matrix homeserver and an Element client (Element Web, Element X, or Element Desktop) to host the widget
- A room to add the widget to (must have encryption enabled — see `CLAUDE.md`)

There is **no Signal / signal-cli dependency of any kind**. All messaging is native Matrix.

---

## Setup

### 1. Install dependencies

```bash
cd frontend && npm install
cd ../backend && npm install
```

### 2. Run in development

```bash
# backend — needs a real Postgres, no local-only mode
cd backend
DATABASE_URL=postgres://user:pass@localhost:5432/crewboard \
ENCRYPTION_KEY=some-long-random-secret \
npm start

# frontend, in another terminal
cd frontend
npm run dev
```

This starts the Vite dev server on `http://localhost:5173` and the backend on `http://localhost:4000` (see `backend/src/index.js` for the full list of env vars, including the optional `SYNAPSE_ADMIN_TOKEN`/`CREWBOARD_ROOM_ID` room-membership enforcement).

### 3. Add it as a widget in Element

CrewBoard only works when loaded as a registered Matrix Widget inside a room — opening it directly in a browser tab will show a "Couldn't connect to Element" screen, since it has no session or room to talk to.

1. Open the room you want CrewBoard in, in Element Web/Desktop.
2. Go to **Room settings → Widgets → Add a widget → Custom Widget** (or use `/addwidget <url>` in the room, where supported).
3. Point it at your dev server or deployed build, e.g.:
   `http://localhost:5173/?widgetId=$matrix_widget_id&roomId=$matrix_room_id&theme=$org.matrix.msc2873.client_theme`

   The `theme` placeholder lets Element pass its actual current theme (light/dark) to the widget on load instead of CrewBoard guessing from the OS-level color-scheme preference — see `main.jsx`'s `ThemeSync` comment.
4. Accept the capability prompts Element shows — CrewBoard needs to send/read room messages and (for `m.beacon`) read state events.

### 4. Build for deployment

```bash
cd frontend && npm run build
cd ../backend  # no build step — runs directly with `npm start`
```

Output: `frontend/dist/` — serve this as static files over HTTPS (see `Dockerfile` for an Nginx-based example, and `docker-compose/` for a full frontend+backend+Postgres example behind Traefik). Register the deployed URL as a widget the same way as step 3.

---

## Project Structure

```
crewboard/
├── frontend/
│   ├── src/
│   │   ├── widget.js         # Widget API bootstrap + capability requests
│   │   ├── matrixStore.js    # Matrix messaging/live-event layer (chat, beacons, media)
│   │   ├── apiClient.js      # fetch() wrapper for the backend REST API
│   │   ├── api.js            # Call surface the views use (backend + Matrix combined)
│   │   ├── views/            # MapBoard, Teams, Database, MatrixHub, Settings
│   │   ├── components/       # Layout, modals, hooks
│   │   └── index.css         # Element Web-styled theme
│   └── index.html
├── backend/
│   ├── src/
│   │   ├── auth.js           # Matrix OpenID token verification + room-membership checks
│   │   ├── crypto.js         # Server-side AES-256-GCM field encryption (fallback/legacy path)
│   │   ├── db.js             # Idempotent CREATE TABLE IF NOT EXISTS migrations
│   │   ├── notify.js         # Postgres LISTEN/NOTIFY -> Server-Sent Events fan-out
│   │   └── routes/           # One router per entity + backup.js (JSON export/import)
│   └── Dockerfile
├── Dockerfile                 # Static Nginx host for the built widget
├── nginx.conf
├── docker-compose/            # Reference docker-compose deployment (frontend+backend+Postgres, Traefik-routed)
└── implementation_plan.md     # Full architecture & migration plan
```

---

## Data model

See `CLAUDE.md` for the full breakdown. Summary:

| Entity | Where it lives |
|---|---|
| Teams, Persons, Vehicles, Markers, Presets, Settings | Postgres (`backend/`), sensitive fields encrypted at rest |
| Chat / broadcasts | Matrix room message (`m.room.message`) |
| Shared contact/vehicle cards, location shares | Matrix room message (`org.crewboard.contact`, `org.crewboard.vehicle-card`, `org.crewboard.location`) |
| Live location beacons | Matrix state (`m.beacon`), written by mobile Element clients |

Messages and location shares are E2EE'd automatically if the room is encrypted (required — see `CLAUDE.md`'s "encrypted-rooms-only" note).

---

## Security

- Auth reuses the widget's Matrix OpenID token — no separate login, no password table.
- Sensitive fields (phone, Matrix ID, license plate, marker notes, etc.) are end-to-end encrypted client-side with a key shared only with other room members over Matrix's own E2EE; the backend's own AES-256-GCM encryption is a fallback/legacy path for anything not covered by that.
- Staff/vehicle photos and screenshots are uploaded to the homeserver's media repository using a short-lived OpenID token (MSC2255 `get_openid`), not stored by the backend.
- E2EE, device verification, and account/session management are all handled natively by Element — CrewBoard doesn't reimplement any of it.

---

## Messaging

Recipients are addressed by Matrix ID, and everything — direct-style messages, team broadcasts, contact cards, vehicle cards, screenshots, and location shares — is posted as an event in a Matrix room (either the widget's own room, or a team/person's linked broadcast/DM room). See **Matrix Hub** in the app for the shared room's activity feed.

---

## Further reading

See `implementation_plan.md` and `messaging_architecture_plan.md` for the architecture and migration history, and `CLAUDE.md` for the current, detailed picture of how the frontend/backend/Matrix pieces fit together.

---

## License

This project is licensed under the Apache License 2.0. See the [LICENSE](file:///Users/demo/Documents/Live/crewboard-open/LICENSE) file for details.

