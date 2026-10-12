from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from constants import (
    DISCONNECT_GRACE_SECONDS,
    MAX_CHAT_MESSAGE_CHARS,
    MAX_CHAT_RATE_PER_SECOND,
    MAX_NAME_CHARS,
    MAX_POINTS_PER_STROKE,
    MAX_STROKE_PAYLOAD_BYTES,
    MAX_STROKE_RATE_PER_SECOND,
    MIN_PLAYERS_TO_START,
    TURN_END_PAUSE_SECONDS,
)
from game_manager import GameManager
from words import normalize_word

app = FastAPI(title="Sapien Pictionary")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = GameManager()

# player_id -> {socket, room_id}
connections: dict[str, dict[str, Any]] = {}
# player_id -> {stroke: [timestamps], chat: [timestamps]}
rate_tracker: dict[str, dict[str, list[float]]] = {}


def _serialize(data: dict) -> str:
    return json.dumps(data, separators=(",", ":"))


async def send_to(player_id: str, data: dict) -> None:
    channel = connections.get(player_id)
    if not channel:
        return
    try:
        await channel["socket"].send_text(_serialize(data))
    except Exception:
        pass


async def send_broadcast(room_id: str, data: dict, skip_id: str | None = None) -> None:
    serialized = _serialize(data)
    for pid, channel in list(connections.items()):
        if channel["room_id"] == room_id and pid != skip_id:
            try:
                await channel["socket"].send_text(serialized)
            except Exception:
                pass


async def broadcast_scores(room_id: str) -> None:
    room = manager.rooms.get(room_id)
    if not room:
        return
    await send_broadcast(
        room_id,
        {"type": "room_updated", "payload": list(room["players"].values())},
    )


async def cancel_room_tasks(room: dict) -> None:
    for key in ("timer_task", "turn_end_task", "auto_pick_task"):
        task = room.get(key)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        room[key] = None


async def start_turn(room_id: str) -> None:
    room = manager.rooms.get(room_id)
    if not room:
        return
    await cancel_room_tasks(room)

    result = manager.setup_new_turn(room_id)
    if not result:
        return

    if result.get("ended"):
        await finish_game(room_id)
        return

    drawer_id = result["drawerId"]
    # Only the drawer receives the 3 word choices (anti-cheat)
    await send_to(
        drawer_id,
        {
            "type": "turn_choosing",
            "payload": {
                "drawerId": drawer_id,
                "choices": result["choices"],
                "round": result["round"],
                "totalRounds": result["totalRounds"],
            },
        },
    )
    await send_broadcast(
        room_id,
        {
            "type": "turn_choosing",
            "payload": {
                "drawerId": drawer_id,
                "choices": [],
                "round": result["round"],
                "totalRounds": result["totalRounds"],
            },
        },
        skip_id=drawer_id,
    )

    async def _auto_pick() -> None:
        try:
            await asyncio.sleep(25)
            live = manager.rooms.get(room_id)
            if (
                not live
                or live["game_status"] != "choosing"
                or live.get("current_drawer_id") != drawer_id
            ):
                return
            choices = live.get("word_choices") or []
            if not choices:
                return
            if not manager.begin_drawing(room_id, drawer_id, choices[0]):
                return
            await send_broadcast(
                room_id,
                {
                    "type": "drawing_started",
                    "payload": {
                        "timer": live["draw_time"],
                        "drawerId": live["current_drawer_id"],
                        "round": live["current_round"],
                        "totalRounds": live["total_rounds"],
                    },
                },
            )
            await send_to(
                drawer_id,
                {
                    "type": "timer_tick",
                    "payload": {
                        "timer": live["timer"],
                        "hint": live["current_word"],
                        "round": live["current_round"],
                        "totalRounds": live["total_rounds"],
                    },
                },
            )
            live["timer_task"] = asyncio.create_task(countdown_timer(room_id))
        except asyncio.CancelledError:
            pass

    room["auto_pick_task"] = asyncio.create_task(_auto_pick())


async def finish_game(room_id: str) -> None:
    room = manager.rooms.get(room_id)
    if not room:
        return
    await cancel_room_tasks(room)
    room["game_status"] = "game_over"
    ranking = sorted(room["players"].values(), key=lambda p: p["score"], reverse=True)
    await send_broadcast(
        room_id,
        {
            "type": "game_over",
            "payload": {
                "word": room.get("current_word"),
                "replay": room.get("replay_store", []),
                "ranking": ranking,
            },
        },
    )


async def end_turn(room_id: str, reason: str = "timeout") -> None:
    room = manager.rooms.get(room_id)
    if not room or room["game_status"] not in ("drawing", "choosing"):
        return

    await cancel_room_tasks(room)
    word = room.get("current_word")
    room["game_status"] = "turn_ended"
    await send_broadcast(
        room_id,
        {
            "type": "turn_ended",
            "payload": {"word": word, "reason": reason},
        },
    )
    await broadcast_scores(room_id)

    async def _advance() -> None:
        try:
            await asyncio.sleep(TURN_END_PAUSE_SECONDS)
            if room_id not in manager.rooms:
                return
            # If we already finished last round's last drawer, setup_new_turn ends game
            await start_turn(room_id)
        except asyncio.CancelledError:
            pass

    room["turn_end_task"] = asyncio.create_task(_advance())


async def countdown_timer(room_id: str) -> None:
    room = manager.rooms.get(room_id)
    if not room:
        return

    try:
        while room["timer"] > 0 and room["game_status"] == "drawing":
            await asyncio.sleep(1)
            if room_id not in manager.rooms:
                return
            room["timer"] -= 1
            elapsed_pct = ((room["draw_time"] - room["timer"]) / room["draw_time"]) * 100
            masked = manager.make_obfuscated_hint(room["current_word"], elapsed_pct)

            for pid, channel in list(connections.items()):
                if channel["room_id"] != room_id:
                    continue
                is_drawer = room["current_drawer_id"] == pid
                await send_to(
                    pid,
                    {
                        "type": "timer_tick",
                        "payload": {
                            "timer": room["timer"],
                            "hint": room["current_word"] if is_drawer else masked,
                            "round": room["current_round"],
                            "totalRounds": room["total_rounds"],
                        },
                    },
                )

            if manager.everyone_guessed(room):
                await end_turn(room_id, reason="all_guessed")
                return

        if room["game_status"] == "drawing":
            await end_turn(room_id, reason="timeout")
    except asyncio.CancelledError:
        pass


async def delayed_player_cleanup(room_id: str, player_id: str) -> None:
    try:
        await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
        recovery_key = f"{room_id}_{player_id}"
        manager.disconnected_players.pop(recovery_key, None)

        room = manager.rooms.get(room_id)
        if not room or player_id not in room["players"]:
            return

        was_drawer = room.get("current_drawer_id") == player_id
        in_progress = room["game_status"] in ("drawing", "choosing")
        name = room["players"][player_id]["name"]

        room = manager.remove_player(room_id, player_id)
        if not room:
            return

        await send_broadcast(
            room_id,
            {
                "type": "system_message",
                "payload": {"text": f"{name} left the room."},
            },
        )
        await broadcast_scores(room_id)

        if was_drawer and in_progress:
            await send_broadcast(
                room_id,
                {
                    "type": "system_message",
                    "payload": {"text": "Drawer left — skipping to the next turn."},
                },
            )
            await end_turn(room_id, reason="drawer_left")
        elif len(room["players"]) < MIN_PLAYERS_TO_START and room["game_status"] not in (
            "lobby",
            "game_over",
        ):
            await cancel_room_tasks(room)
            room["game_status"] = "lobby"
            room["current_word"] = None
            await send_broadcast(
                room_id,
                {
                    "type": "system_message",
                    "payload": {"text": "Not enough players — returning to lobby."},
                },
            )
            for pid in list(connections.keys()):
                if connections[pid]["room_id"] == room_id:
                    await send_to(
                        pid,
                        {
                            "type": "sync_state",
                            "payload": {
                                "roomState": manager.public_room_state(room, pid),
                                "history": room["history"],
                            },
                        },
                    )
    except asyncio.CancelledError:
        pass


def _rate_ok(player_id: str, kind: str, limit: int) -> bool:
    now = time.time()
    bucket = rate_tracker.setdefault(player_id, {"stroke": [], "chat": []})
    ticks = [t for t in bucket.get(kind, []) if now - t < 1.0]
    if len(ticks) >= limit:
        bucket[kind] = ticks
        return False
    ticks.append(now)
    bucket[kind] = ticks
    return True


def _stroke_payload_ok(body: dict) -> bool:
    raw = json.dumps(body, separators=(",", ":"))
    if len(raw) > MAX_STROKE_PAYLOAD_BYTES:
        return False
    points = body.get("points")
    if points is not None:
        if not isinstance(points, list) or len(points) > MAX_POINTS_PER_STROKE:
            return False
    tool = body.get("tool")
    if tool not in ("pen", "eraser", "undo", "clear", "fill"):
        return False
    return True


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "rooms": len(manager.rooms), "connections": len(connections)}


@app.get("/rooms/{room_id}")
async def get_room_info(room_id: str) -> dict:
    """Public room probe for the join screen (no secret word)."""
    if not room_id or len(room_id) > 64:
        return {"exists": False}

    room = manager.rooms.get(room_id)
    if not room:
        return {"exists": False}

    return {
        "exists": True,
        "totalRounds": room["total_rounds"],
        "drawTime": room["draw_time"],
        "wordListSize": len(room.get("word_list") or []),
        "playerCount": len(room["players"]),
        "gameStatus": room["game_status"],
    }


@app.websocket("/ws")
async def ws_router(websocket: WebSocket) -> None:
    await websocket.accept()
    current_player: str | None = None
    current_room: str | None = None

    try:
        while True:
            payload_raw = await websocket.receive_text()
            if len(payload_raw) > MAX_STROKE_PAYLOAD_BYTES + 2048:
                await websocket.send_text(
                    _serialize(
                        {
                            "type": "system_message",
                            "payload": {"text": "Message too large."},
                        }
                    )
                )
                continue

            try:
                packet = json.loads(payload_raw)
            except json.JSONDecodeError:
                continue

            action = packet.get("type")
            r_id = packet.get("roomId")
            p_id = packet.get("playerId")
            user_name = (packet.get("name") or "Player")[:MAX_NAME_CHARS]
            body = packet.get("payload") or {}

            if not p_id or not r_id or not isinstance(p_id, str) or not isinstance(r_id, str):
                continue
            if len(r_id) > 64 or len(p_id) > 64:
                continue

            current_player, current_room = p_id, r_id

            if action == "join_room":
                # Replace any existing socket for this player (refresh / reconnect)
                old = connections.get(p_id)
                if old and old["socket"] is not websocket:
                    try:
                        await old["socket"].close()
                    except Exception:
                        pass

                connections[p_id] = {"socket": websocket, "room_id": r_id}
                host_config = body.get("hostSettings") or {}
                room_data = manager.get_or_create_room(r_id, p_id, user_name, host_config)

                await send_to(
                    p_id,
                    {
                        "type": "sync_state",
                        "payload": {
                            "roomState": manager.public_room_state(room_data, p_id),
                            "history": room_data["history"],
                        },
                    },
                )
                await broadcast_scores(r_id)
                await send_broadcast(
                    r_id,
                    {
                        "type": "system_message",
                        "payload": {"text": f"{user_name} joined the room."},
                    },
                    skip_id=p_id,
                )
                continue

            # Must be connected to the room for other actions
            if p_id not in connections or connections[p_id]["room_id"] != r_id:
                connections[p_id] = {"socket": websocket, "room_id": r_id}

            room = manager.rooms.get(r_id)
            if not room or p_id not in room["players"]:
                continue

            if action == "start_game":
                if room["host_id"] != p_id:
                    continue
                if room["game_status"] not in ("lobby", "game_over"):
                    continue
                if len(room["players"]) < MIN_PLAYERS_TO_START:
                    await send_to(
                        p_id,
                        {
                            "type": "system_message",
                            "payload": {
                                "text": f"Need at least {MIN_PLAYERS_TO_START} players to start."
                            },
                        },
                    )
                    continue
                room["current_round"] = 1
                room["current_drawer_id"] = None
                room["replay_store"] = []
                await start_turn(r_id)

            elif action == "word_chosen":
                if not manager.begin_drawing(r_id, p_id, body.get("word", "")):
                    continue
                await send_broadcast(
                    r_id,
                    {
                        "type": "drawing_started",
                        "payload": {
                            "timer": room["draw_time"],
                            "drawerId": room["current_drawer_id"],
                            "round": room["current_round"],
                            "totalRounds": room["total_rounds"],
                        },
                    },
                )
                # Seed drawer with full word immediately
                await send_to(
                    p_id,
                    {
                        "type": "timer_tick",
                        "payload": {
                            "timer": room["timer"],
                            "hint": room["current_word"],
                            "round": room["current_round"],
                            "totalRounds": room["total_rounds"],
                        },
                    },
                )
                await cancel_room_tasks(room)
                room["timer_task"] = asyncio.create_task(countdown_timer(r_id))

            elif action == "stroke":
                if room["current_drawer_id"] != p_id or room["game_status"] != "drawing":
                    continue
                if not _rate_ok(p_id, "stroke", MAX_STROKE_RATE_PER_SECOND):
                    continue
                if not isinstance(body, dict) or not _stroke_payload_ok(body):
                    continue
                stroke = manager.append_stroke(room, body)
                await send_broadcast(
                    r_id, {"type": "stroke", "payload": stroke}, skip_id=p_id
                )

            elif action == "guess":
                if not _rate_ok(p_id, "chat", MAX_CHAT_RATE_PER_SECOND):
                    await send_to(
                        p_id,
                        {
                            "type": "system_message",
                            "payload": {"text": "Slow down! Chat rate limit hit."},
                        },
                    )
                    continue

                text = body.get("text", "")
                if not isinstance(text, str):
                    continue
                text = text.strip()[:MAX_CHAT_MESSAGE_CHARS]
                if not text:
                    continue

                user = room["players"].get(p_id)
                if not user:
                    continue

                # Lobby / non-drawing chat is fine (no secret to leak)
                if room["game_status"] != "drawing":
                    await send_broadcast(
                        r_id,
                        {
                            "type": "chat_message",
                            "payload": {"sender": user["name"], "text": text},
                        },
                    )
                    continue

                if room["current_drawer_id"] == p_id:
                    await send_to(
                        p_id,
                        {
                            "type": "system_message",
                            "payload": {"text": "You are drawing — no chatting!"},
                        },
                    )
                    continue

                secret = room.get("current_word") or ""
                attempt = normalize_word(text)

                # Correct guessers must not reveal the word
                if user["is_correct"]:
                    if manager.contains_secret_word(text, secret):
                        await send_to(
                            p_id,
                            {
                                "type": "system_message",
                                "payload": {
                                    "text": "Nice try — you can't reveal the word!"
                                },
                            },
                        )
                    else:
                        await send_broadcast(
                            r_id,
                            {
                                "type": "chat_message",
                                "payload": {"sender": user["name"], "text": text},
                            },
                        )
                    continue

                if attempt == normalize_word(secret):
                    points = manager.score_correct_guess(room, p_id)
                    await send_broadcast(
                        r_id,
                        {
                            "type": "system_message",
                            "payload": {
                                "text": f"{user['name']} guessed the word! (+{points})"
                            },
                        },
                    )
                    await broadcast_scores(r_id)
                    if manager.everyone_guessed(room):
                        await end_turn(r_id, reason="all_guessed")
                    continue

                if manager.check_near_miss(attempt, secret):
                    # Private feedback only to the guesser
                    await send_to(
                        p_id,
                        {
                            "type": "close_guess",
                            "payload": {"text": "Close!"},
                        },
                    )
                    # Still show their guess to others (it isn't the word)
                    await send_broadcast(
                        r_id,
                        {
                            "type": "chat_message",
                            "payload": {"sender": user["name"], "text": text},
                        },
                    )
                    continue

                await send_broadcast(
                    r_id,
                    {
                        "type": "chat_message",
                        "payload": {"sender": user["name"], "text": text},
                    },
                )

            elif action == "reset_game":
                if room["host_id"] != p_id:
                    continue
                await cancel_room_tasks(room)
                updated = manager.reset_room_state(r_id)
                if not updated:
                    continue
                for pid in list(connections.keys()):
                    if connections[pid]["room_id"] == r_id:
                        await send_to(
                            pid,
                            {
                                "type": "sync_state",
                                "payload": {
                                    "roomState": manager.public_room_state(updated, pid),
                                    "history": [],
                                },
                            },
                        )
                await send_broadcast(
                    r_id,
                    {
                        "type": "system_message",
                        "payload": {"text": "Host reset the lobby. Ready for another round!"},
                    },
                )

            elif action == "update_settings":
                if room["host_id"] != p_id or room["game_status"] != "lobby":
                    continue
                from constants import (
                    DEFAULT_DRAW_TIME,
                    DEFAULT_ROUNDS,
                    MAX_DRAW_TIME,
                    MAX_ROUNDS,
                    MAX_WORD_LIST_SIZE,
                    MIN_DRAW_TIME,
                    MIN_ROUNDS,
                )
                from words import sanitize_word_list

                if "rounds" in body:
                    room["total_rounds"] = manager._clamp_int(
                        body["rounds"], MIN_ROUNDS, MAX_ROUNDS, DEFAULT_ROUNDS
                    )
                if "drawTime" in body:
                    room["draw_time"] = manager._clamp_int(
                        body["drawTime"], MIN_DRAW_TIME, MAX_DRAW_TIME, DEFAULT_DRAW_TIME
                    )
                if "wordList" in body:
                    words = sanitize_word_list(body["wordList"])
                    room["word_list"] = words[:MAX_WORD_LIST_SIZE]

                for pid in list(connections.keys()):
                    if connections[pid]["room_id"] == r_id:
                        await send_to(
                            pid,
                            {
                                "type": "sync_state",
                                "payload": {
                                    "roomState": manager.public_room_state(room, pid),
                                    "history": room["history"],
                                },
                            },
                        )

    except WebSocketDisconnect:
        pass
    finally:
        if current_player and connections.get(current_player, {}).get("socket") is websocket:
            connections.pop(current_player, None)
            room = manager.rooms.get(current_room) if current_room else None
            if room and current_player in room["players"]:
                player_profile = room["players"][current_player]
                recovery_key = f"{current_room}_{current_player}"

                # Cancel any prior cleanup for this key
                prior = manager.disconnected_players.get(recovery_key)
                if prior and prior.get("cancel_task"):
                    prior["cancel_task"].cancel()

                cleanup_task = asyncio.create_task(
                    delayed_player_cleanup(current_room, current_player)
                )
                manager.disconnected_players[recovery_key] = {
                    "player_profile": dict(player_profile),
                    "cancel_task": cleanup_task,
                }
                await send_broadcast(
                    current_room,
                    {
                        "type": "system_message",
                        "payload": {
                            "text": (
                                f"{player_profile['name']} disconnected. "
                                f"Score kept for {DISCONNECT_GRACE_SECONDS}s..."
                            )
                        },
                    },
                )

                # If drawer drops, recover after a short wait only if they don't reconnect
                # (don't skip immediately — they have 30s; but game would stall.
                # Skip turn after a shorter grace if still drawing.)
                if (
                    room.get("current_drawer_id") == current_player
                    and room["game_status"] in ("drawing", "choosing")
                ):

                    async def drawer_abandon_watch() -> None:
                        try:
                            await asyncio.sleep(8)
                            if current_player in connections:
                                return
                            live = manager.rooms.get(current_room)
                            if (
                                live
                                and live.get("current_drawer_id") == current_player
                                and live["game_status"] in ("drawing", "choosing")
                            ):
                                await send_broadcast(
                                    current_room,
                                    {
                                        "type": "system_message",
                                        "payload": {
                                            "text": "Drawer abandoned the turn — moving on."
                                        },
                                    },
                                )
                                await end_turn(current_room, reason="drawer_left")
                        except asyncio.CancelledError:
                            pass

                    asyncio.create_task(drawer_abandon_watch())
