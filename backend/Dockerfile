# CrewBoard backend: Express + pg, providing encrypted CRUD for
# teams/persons/vehicles/markers/presets/settings. Auth is Matrix OpenID
# token verification (see src/auth.js) — no separate login system, no
# password storage. Runs as a non-root user for the same reason the frontend
# image does (see ../Dockerfile / ../PAINPOINTS.md's CreateContainerConfigError
# note) — the Helm chart's securityContext requires runAsNonRoot: true.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/

RUN addgroup -g 1001 crewboard && adduser -D -u 1001 -G crewboard crewboard
USER 1001

EXPOSE 4000
CMD ["node", "src/index.js"]
