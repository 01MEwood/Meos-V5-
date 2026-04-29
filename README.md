# MEOS 4.0 — Schreinerhelden Industrial OS

Backend API + bundled frontend for MEOS 4.0 production.

## Stack
- Node.js 20 (Alpine), Express, Prisma, MySQL 8
- Frontend: bundled React (in `public/`), no separate source in this snapshot
- Deployed via Docker (image: `mariomeosv40/meos:latest`) on Hostinger VPS

## Origin
Initial commit is a snapshot pulled directly from the running production container on `2026-04-29`.
At that point the live container already included the call-popup / Reventix / timezone / employee-match fixes (see CHANGELOG).

## Build & Push
```bash
docker build -t mariomeosv40/meos:latest .
docker push mariomeosv40/meos:latest

# On VPS:
cd /docker/meos-v5a
docker compose pull
docker compose up -d
```

## Local dev
```bash
npm install
cp .env.example .env  # fill in DB creds + JWT_SECRET
npm run db:push
npm run db:seed
npm run dev
```

## Endpoints
- `/api/health` — health check
- `/api/calls/incoming` (GET/POST) — Reventix Action URL for inbound calls
- `/api/calls/outgoing` (GET) — outbound calls
- `/api/calls/connect` / `/api/calls/ended` / `/api/calls/hold`
- `/api/calls/debug` — show raw URL params (for testing Reventix variable resolution)
- See `src/routes/` for full list

## Reventix Action URLs (production-tested)
```
http://meosapp.de:4000/api/calls/incoming?remoteparty=<$remote_party>&localparty=<$local_party>&callerName=<$remote_alias>&direction=<$call_direction>&callguid=<$call_guid>
http://meosapp.de:4000/api/calls/connect?remoteparty=<$remote_party>&connectedtime=<$call_connected_time>
http://meosapp.de:4000/api/calls/ended?remoteparty=<$remote_party>&callduration=<$call_duration_seconds>&disconnectedtime=<$call_disconnected_time>&connectedtime=<$call_connected_time>&createdtime=<$call_created_time>&callguid=<$call_guid>
http://meosapp.de:4000/api/calls/outgoing?remoteparty=<$remote_party>&localparty=<$local_party>&local_alias=<$local_alias>&remotedisplayname=<$remote_alias>&createdtime=<$call_created_time>&callguid=<$call_guid>
```
