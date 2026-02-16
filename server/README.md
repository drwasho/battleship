# Moving Battleships – Realtime Server

Socket.IO lobby + chat service (authoritative game wiring comes next).

## Local dev

```bash
cd server
npm install
npm run dev
```

Server:
- HTTP: `http://localhost:8080/health`
- Rooms list: `http://localhost:8080/rooms`
- Socket.IO: `ws://localhost:8080`

## Env

- `PORT` (default 8080)
- `CORS_ORIGIN` comma-separated list of allowed origins (e.g. Vercel URL). If unset, allows all.

## Fly.io deploy

```bash
cd server
fly launch   # creates fly.toml
fly deploy
```

After deploy, set `CORS_ORIGIN`:

```bash
fly secrets set CORS_ORIGIN="https://<your-vercel-app>.vercel.app"
```

Then redeploy if needed.
