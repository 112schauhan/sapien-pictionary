# Sapien Draw

Real-time multiplayer pictionary in the browser (Skribbl-style): create a room, share a link, draw, guess, score.

## Run (one command)

```bash
npm run setup   # first time only — installs Node deps + Python venv
npm start       # starts API on :8000 and Vite on :5173
```

Open **http://127.0.0.1:5173**, enter a name, share the room link, and play with 2+ browsers (or profiles).

Health check: `http://127.0.0.1:8000/health`

## Screen recording

Record ~2 minutes with at least 3 players (three browser windows / profiles):

1. Host creates a room, copies **Share**, sets rounds/time.
2. Two other players join via the link.
3. Start game → drawer picks a word → others guess → show points, hints, and end-of-game stroke replay.

Save the file as `docs/demo.mp4` (or attach it beside this README).

## Architecture notes

### How canvas sync / stroke data works

- The drawer’s client emits **streaming stroke packets** (`phase: begin | move | end`) with a `strokeId`, color, size, tool, and point batches (~every 8 points or 32ms).
- The server validates the drawer role + game status, rate-limits strokes, caps payload size, assigns a monotonic `seq`, stores strokes in `history` (for mid-join sync) and `replay_store` (final strokes for end-of-game replay), then **broadcasts** each packet to everyone else.
- Tools: pen, eraser, fill, undo, clear. Undo/clear are server-applied to history so late joiners see a consistent canvas.
- Mid-round joiners receive `sync_state` with the full stroke history and immediately redraw.

### Latency and ordering

- Points are streamed while the pointer moves (not only on mouse-up), so remote canvases track the line with minimal lag.
- Ordering is **server sequence** (`seq`) over a single WebSocket per player; TCP preserves per-connection order.
- Remote clients draw `move` segments immediately; `end` seals the stroke. Undo/clear trigger a full redraw from the authoritative history stack.
- Guesses, timer ticks, and scores are server-pushed — the client never trusts local scoring or the secret word.

### Server restart

- Room state lives **in memory only**. A process restart drops all rooms, scores, and canvas history.
- Clients see a disconnect; after refresh they create/join a **new** empty lobby (same room code is a new room).
- For production HA you’d add Redis/DB persistence and sticky WebSocket sessions — out of scope for this single-instance build.

### Capacity (rough)

One uvicorn process on a laptop comfortably handles on the order of **~100–200 concurrent players** (~25–50 active rooms at 4 players), dominated by WebSocket fan-out of stroke messages and 1Hz timer ticks — not CPU drawing.

How this was estimated:

- Stroke bursts capped at **40 msg/s/drawer**; chat at **4 msg/s/player**.
- Timer fan-out is `players_in_room` messages/second while drawing.
- `/health` exposes live `rooms` and `connections` for spot checks under load.
- A quick local soak (multiple browser tabs + scripted joins) stayed healthy below ~150 sockets on a single machine; beyond that, move to multiple workers behind a shared room store.

## Anti-cheat / abuse

- Secret word never appears in public `sync_state`; only the drawer gets the real word / choices.
- Word choice must be one of the server-issued options.
- Guesses scored only on the server; correct guessers cannot chat the answer.
- Near-misses get a private **Close!**; wrong guesses go to public chat.
- Rate limits + max chat length + max stroke payload size.

## Stack

- **Client:** React + TypeScript + Vite + Canvas 2D
- **Server:** FastAPI WebSockets + asyncio timers
