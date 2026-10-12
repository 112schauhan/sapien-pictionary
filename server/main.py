import json
import asyncio
import time
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from game_manager import GameManager
from constants import TURN_DURATION_SECONDS, MAX_BURST_RATE_PER_SECOND, MAX_STROKE_PAYLOAD_BYTES

app = FastAPI()

# Enable cross-origin compatibility layers for local development matching
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = GameManager()

# Global mesh connection trackers
# Structure: { player_id: {"socket": WebSocket, "room_id": str} }
connections = {}
rate_tracker = {}


async def send_broadcast(room_id: str, data: dict, skip_id: str = None):
    """Utility helper to serialize and broadcast a message frame to all players in a room."""
    serialized = json.dumps(data)
    for p_id, channel in list(connections.items()):
        if channel["room_id"] == room_id and p_id != skip_id:
            try:
                await channel["socket"].send_text(serialized)
            except Exception:
                pass


async def countdown_timer_thread(room_id: str):
    """Server-authoritative game clock loop. Tracks round intervals and hints execution loops."""
    room = manager.rooms.get(room_id)
    if not room:
        return

    # Read duration configurations dynamically from custom host settings variables
    room["timer"] = room["draw_time"]
    while room["timer"] > 0 and room["game_status"] == "drawing":
        await asyncio.sleep(1)
        room["timer"] -= 1

        # Enforce server authority: evaluate dynamic hint visibility increments over time
        pct = ((room["draw_time"] - room["timer"]) / room["draw_time"]) * 100
        masked = manager.make_obfuscated_hint(room["current_word"], pct)

        # Route custom payloads depending on player role authorization to prevent cheating
        for p_id, channel in list(connections.items()):
            if channel["room_id"] == room_id:
                is_drawer = (room["current_drawer_id"] == p_id)
                await channel["socket"].send_text(json.dumps({
                    "type": "timer_tick",
                    "payload": {
                        "timer": room["timer"],
                        "hint": room["current_word"] if is_drawer else masked
                    }
                }))

        # Early termination condition if everyone has successfully guessed the word
        if room["has_guessed_count"] >= max(1, len(room["players"]) - 1):
            break

    # Check if this was the last round/turn transition to trigger game overview
    # Safeguarded dictionary index logic pattern to avoid KeyError crashes
    is_last_round = room["current_round"] >= room["total_rounds"]
    player_keys = list(room["players"].keys())
    is_last_drawer = len(
        player_keys) > 0 and player_keys[-1] == room["current_drawer_id"]

    if is_last_round and is_last_drawer:
        room["game_status"] = "ended"
        await send_broadcast(room_id, {
            "type": "game_over",
            "payload": {
                "word": room["current_word"],
                "replay": room.get("replay_store", [])
            }
        })
    else:
        room["game_status"] = "ended"
        await send_broadcast(room_id, {
            "type": "turn_ended",
            "payload": {"word": room["current_word"]}
        })


async def delayed_player_cleanup(room_id: str, player_id: str):
    """Asynchronously wait 30 seconds before executing a hard purge of a disconnected player's score."""
    try:
        # Hold state parameters for exactly 30 seconds window
        await asyncio.sleep(30.0)
        recovery_key = f"{room_id}_{player_id}"
        manager.disconnected_players.pop(recovery_key, None)

        if room_id in manager.rooms:
            room = manager.rooms[room_id]
            room["players"].pop(player_id, None)

            # Clean recovery path if drawer leaves mid-turn unexpectedly
            if room["current_drawer_id"] == player_id:
                room["game_status"] = "ended"
                await send_broadcast(room_id, {"type": "system_message", "payload": {"text": "The drawer abandoned the room! Skipping turn..."}})

            if not room["players"]:
                # Wipe room from server memory if entirely empty
                manager.rooms.pop(room_id, None)
            else:
                # If room host disconnected, cleanly pass host privileges to the next available client node
                if room["host_id"] == player_id:
                    room["host_id"] = list(room["players"].keys())[0]
                    room["players"][room["host_id"]]["is_host"] = True
                await send_broadcast(room_id, {"type": "room_updated", "payload": list(room["players"].values())})
    except asyncio.CancelledError:
        pass  # Catch-all block for when player reconnects inside the 30 seconds threshold loop


@app.websocket("/ws")
async def ws_router(websocket: WebSocket):
    await websocket.accept()
    current_player = None
    current_room = None

    try:
        while True:
            payload_raw = await websocket.receive_text()
            packet = json.loads(payload_raw)

            action = packet.get("type")
            r_id = packet.get("roomId")
            p_id = packet.get("playerId")
            user_name = packet.get("name")
            body = packet.get("payload", {})

            if not p_id or not r_id:
                continue
            current_player, current_room = p_id, r_id

            # Anti-abuse protection: Drop excessive operations running per second
            timestamp = time.time()
            ticks = [t for t in rate_tracker.get(
                p_id, []) if timestamp - t < 1.0]
            if len(ticks) > MAX_BURST_RATE_PER_SECOND:
                await websocket.send_text(json.dumps({"type": "system_message", "payload": {"text": "Slow down! Rate limit exceeded."}}))
                continue
            ticks.append(timestamp)
            rate_tracker[p_id] = ticks

            # Game core action messaging router matrix
            if action == "join_room":
                connections[p_id] = {"socket": websocket, "room_id": r_id}
                host_config = body.get("hostSettings", {})

                # Check session recovery or instantiate a room configuration model
                room_data = manager.get_or_create_room(
                    r_id, p_id, user_name, host_config)

                await websocket.send_text(json.dumps({
                    "type": "sync_state",
                    "payload": {
                        "roomState": {**room_data, "players": list(room_data["players"].values())},
                        "history": room_data["history"]
                    }
                }))
                await send_broadcast(r_id, {"type": "room_updated", "payload": list(room_data["players"].values())})

            elif action == "start_game":
                room = manager.rooms.get(r_id)
                if room and room["host_id"] == p_id:
                    choices = manager.setup_new_turn(r_id)
                    await send_broadcast(r_id, {
                        "type": "turn_choosing",
                        "payload": {"drawerId": room["current_drawer_id"], "choices": choices}
                    })

            elif action == "word_chosen":
                room = manager.rooms.get(r_id)
                if room and room["current_drawer_id"] == p_id:
                    room["current_word"] = body.get("word", "").lower().strip()
                    room["game_status"] = "drawing"
                    await send_broadcast(r_id, {"type": "drawing_started", "payload": {"timer": room["draw_time"]}})
                    # Spin up non-blocking loop handling scheduling authority asynchronously
                    asyncio.create_task(countdown_timer_thread(r_id))

            elif action == "stroke":
                room = manager.rooms.get(r_id)
                if room and room["current_drawer_id"] == p_id and room["game_status"] == "drawing":
                    # Evaluate structural payload safety thresholds using isolated parameter properties
                    if len(str(body)) < MAX_STROKE_PAYLOAD_BYTES:
                        room["history"].append(body)
                        # Ensure replay structural container array is safely instantiated before append pipelines
                        if "replay_store" not in room:
                            room["replay_store"] = []
                        room["replay_store"].append(body)
                        await send_broadcast(r_id, {"type": "stroke", "payload": body}, skip_id=p_id)

            elif action == "guess":
                room = manager.rooms.get(r_id)
                if room and room["game_status"] == "drawing" and room["current_drawer_id"] != p_id:
                    user = room["players"].get(p_id)
                    if user and not user["is_correct"]:
                        attempt = body.get("text", "").lower().strip()

                        if attempt == room["current_word"]:
                            user["is_correct"] = True
                            user["score"] += int((room["timer"] /
                                                 room["draw_time"]) * 400) + 100
                            room["has_guessed_count"] += 1

                            # Secure alert insertion: prevents user revealing word via socket code intercept
                            await send_broadcast(r_id, {"type": "system_message", "payload": {"text": f"🎉 {user['name']} found the word right!"}})

    except WebSocketDisconnect:
        if current_player and current_room in manager.rooms:
            connections.pop(current_player, None)
            room = manager.rooms[current_room]
            player_profile = room["players"].get(current_player)

            if player_profile:
                # 30-Second Disconnection Recovery Implementation Block
                # Save data profiles to cache and launch structural delay thread execution paths
                recovery_key = f"{current_room}_{current_player}"
                cleanup_task = asyncio.create_task(
                    delayed_player_cleanup(current_room, current_player))
                manager.disconnected_players[recovery_key] = {
                    "player_profile": player_profile,
                    "cancel_task": cleanup_task
                }

                # Broadcast warning statement to the rest of the room members
                await send_broadcast(current_room, {
                    "type": "system_message",
                    "payload": {"text": f"⚠️ {player_profile['name']} left the room. Retaining workspace profile scores for 30s..."}
                })
