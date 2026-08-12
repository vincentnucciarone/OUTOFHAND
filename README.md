# DM'D

AI-powered multiplayer party game.

## Environment variables

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `GEMINI_API_KEY`

The Upstash URL/token can be copied from your Upstash database's REST connection details.

## Deploy

```bat
git add -A
git commit -m "Initial DMD game"
git push
```

Vercel deploys from the repository.

## Game

- 7 rounds
- AI generates the sender, DM, and modifier
- Players submit exactly one reply
- AI returns raw scores only
- Round 1-5: 100 max
- Round 6: 125 max
- Round 7: 150 max
- Host can kick players from the lobby


## Gemini

The server uses the Google GenAI JavaScript SDK and Gemini 3.6 Flash through the Interactions API with structured JSON output. This avoids the retired `gemini-2.5-flash` model endpoint.
