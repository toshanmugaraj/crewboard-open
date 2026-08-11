# CrewBoard — Build & Deploy Instructions

CrewBoard builds to a static frontend bundle that's hosted over HTTPS and
registered as a Matrix Widget inside an Element room. There's no installer,
no Electron packaging step, no Python backend, and no Java/signal-cli
dependency — the entire toolchain is Node.js + Vite.

## Prerequisites

- **Node.js 18+** — https://nodejs.org

## Build the static bundle

```bash
cd frontend
npm install
npm run build
```

Output: `frontend/dist/` — a static site containing `index.html` and the
bundled JS/CSS.

## Deploy

Serve `frontend/dist/` over **HTTPS** (Element requires HTTPS for widget URLs,
except for `localhost` during development). The included `Dockerfile` builds
the frontend and serves it with Nginx:

```bash
docker build -t crewboard-widget .
docker run -p 8080:80 crewboard-widget
```

Put a reverse proxy with TLS in front of it (Caddy, Traefik, Nginx + certbot,
or your platform's managed HTTPS) for production.

## Register the widget in Element

Once deployed, add it to a room as a Custom Widget pointing at:

```
https://your-widget-host.example.com/?widgetId=$matrix_widget_id&roomId=$matrix_room_id&theme=$org.matrix.msc2873.client_theme
```

Element substitutes `$matrix_widget_id` and `$matrix_room_id` automatically
when the widget loads. The `theme` placeholder lets Element pass its actual
current theme through instead of CrewBoard falling back to an OS-level
guess — see `main.jsx`'s `ThemeSync` component. See `README.md` for the full
setup walkthrough.

## Notes

- All persistent data (teams, persons, vehicles, markers, presets, settings)
  lives in Matrix room state — there is nothing to back up on the widget
  host itself. The room's own history/backup covers CrewBoard's data too.
- Staff/vehicle photos and screenshots are uploaded straight to the
  homeserver's media repository; the widget host never stores files.
