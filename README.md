# OUT OF HAND — Vercel Build

This version is designed for Vercel. It replaces the old Socket.IO/in-memory server with:

- Vercel Function: `api/game.js`
- Upstash Redis for durable multiplayer lobby state
- Browser polling every ~1 second for synchronization
- Gemini for scenario generation and jury verdicts

## Deploy on Vercel

1. Upload/import this project into Vercel.
2. In the Vercel project, add an Upstash Redis integration from Marketplace/Storage and connect it to this project.
3. Confirm these environment variables exist:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
4. Add your Gemini environment variable:
   - `GEMINI_API_KEY`
5. Optional:
   - `GEMINI_MODEL=gemini-3.6-flash`
6. Redeploy after environment variables are added.

## Local testing

Create `.env.local` using `.env.example`, then run:

```bash
npx vercel dev
```

Use the local URL Vercel prints. Do not run the old `node server.js`; this build intentionally has no always-on server.

## Multiplayer behavior

- Host creates a lobby and receives a 6-character code.
- Players join with the code and a display name.
- A browser-local private token reconnects a refreshed tab to the same player.
- Host can participate like any other player.
- Everyone sees the same prompt.
- The ready counter updates while plans are submitted.
- Rejected players stay spectators until the entire run ends.
- When no active players remain, the host can start a completely new game.
- Lobbies expire after roughly 6 hours of inactivity.

## Security

Never place the Gemini key or Redis credentials in `app.js` or `index.html`. They belong only in Vercel Environment Variables.
