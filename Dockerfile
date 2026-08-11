# Builds the CrewBoard widget frontend and serves it as static files over
# Nginx. Element requires widget URLs to be served over HTTPS in production —
# put a TLS-terminating reverse proxy (Caddy, Traefik, your platform's LB)
# in front of this container.

FROM node:20-alpine AS build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# nginx-unprivileged: runs as a non-root user (uid 101) out of the box and
# listens on 8080 instead of 80, since the Helm chart's securityContext
# requires runAsNonRoot: true and the cluster won't let a container claim to
# be non-root while its image defaults to root (that's what broke the plain
# nginx:1.27-alpine image with CreateContainerConfigError).
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Runtime config injection (2026-08-06) — templates env.js (window.
# __CREWBOARD_ENV__, currently just PLAUSIBLE_API_HOST/PLAUSIBLE_DOMAIN) from
# container env vars at startup, so docker-compose's .env file can configure
# Plausible analytics without an image rebuild. See the script's own header
# comment and analytics.js for the full design. The base image already runs
# every script under /docker-entrypoint.d/ before exec-ing nginx.
COPY docker-entrypoint.d/40-generate-env-js.sh /docker-entrypoint.d/40-generate-env-js.sh
USER root
# COPY defaults to root:root ownership regardless of the base image's own
# USER directive (--chown wasn't used above) — so /usr/share/nginx/html was
# owned by root even though the container ultimately runs as the
# non-root `nginx` user (101), which is exactly why the entrypoint script
# above failed with "Permission denied" trying to write env.js into it
# (confirmed live under docker-compose, 2026-08-06). chown it to that same
# uid/gid so the script can actually write there at container startup.
RUN chmod +x /docker-entrypoint.d/40-generate-env-js.sh \
    && chown -R 101:101 /usr/share/nginx/html
USER 101
EXPOSE 8080
