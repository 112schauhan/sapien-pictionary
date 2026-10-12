import json
import asyncio
import time
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from game_manager import GameManager
# Securely inject external environment rules from the configuration directory layer
from constants import TURN_DURATION_SECONDS, MAX_BURST_RATE_PER_SECOND, MAX_STROKE_PAYLOAD_BYTES

app = FastAPI()
manager = GameManager()

connections = {}
rate_tracker = {}


async def send_broadcast(room_id: str, data: dict, skip_id: str = None):
    serialized = json.dumps(data)
    for p_id, channel in list(connections.items()):
        if channel["room_id"] == room_id and p_id != skip_id:
            try:
                await channel["socket"].send_text(serialized)
            except Exception:
                pass


async def countdown_timer_thread(room_id: str):
    room = manager.rooms.get(room_id)
    if not room:
        return

    # Links variable initialization precisely to configuration definitions
    room["timer"] = TURN_DURATION_SECONDS
    while room["timer"] > 0 and room["game_status"] == "drawing":
        await asyncio.sleep(1)
        room["timer"] -= 1

        pct = ((TURN_DURATION_SECONDS -
               room["timer"]) / TURN_DURATION_SECONDS) * 100
        masked = manager.make_obfuscated_hint(room["current_word"], pct)

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

        if room["has_guessed_count"] >= max(1, len(room["players"]) - 1):
            break

    room["game_status"] = "ended"
    await send_broadcast(room_id, {
        "type": "turn_ended",
        "payload": {"word": room["current_word"]}
    })


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

            timestamp = time.time()
            ticks = [t for t in rate_tracker.get(
                p_id, []) if timestamp - t < 1.0]
            # Protect endpoints dynamically via constants configuration attributes
            if len(ticks) > MAX_BURST_RATE_PER_SECOND:
                await websocket.send_text(json.dumps({"type": "system_message", "payload": {"text": "Slow down! Rate limit exceeded."}}))
                continue
            ticks.append(timestamp)
            rate_tracker[p_id] = ticks

            if action == "join_room":
                connections[p_id] = {"socket": websocket, "room_id": r_id}
                room_data = manager.get_or_create_room(r_id, p_id, user_name)

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
                    await send_broadcast(r_id, {"type": "drawing_started", "payload": {"timer": TURN_DURATION_SECONDS}})
                    asyncio.create_task(countdown_timer_thread(r_id))

            elif action == "stroke":
                room = manager.rooms.get(r_id)
                if room and room["current_drawer_id"] == p_id and room["game_status"] == "drawing":
                    # Evaluate structural payload safety thresholds using isolated parameter properties
                    if len(str(body)) < MAX_STROKE_PAYLOAD_BYTES:
                        room["history"].append(body)
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
                                                 TURN_DURATION_SECONDS) * 400) + 100
                            room["has_guessed_count"] += 1

                            await send_broadcast(r_id, {"type": "system_message", "payload": {"text": f"🎉 {user['name']} found the word!"}})
                            await send_broadcast(r_id, {"type": "room_updated", "payload": list(room["players"].values())})
                        else:
                            if manager.check_near_miss(attempt, room["current_word"]):
                                await websocket.send_text(json.dumps({"type": "system_message", "payload": {"text": "Close!"}}))
                            await send_broadcast(r_id, {"type": "chat_message", "payload": {"sender": user["name"], "text": body.get("text")}})

    except WebSocketDisconnect:
        if current_player:
            connections.pop(current_player, None)
            if current_room in manager.rooms:
                room = manager.rooms[current_room]
                room["players"].pop(current_player, None)

                if room["current_drawer_id"] == current_player:
                    room["game_status"] = "ended"
                    await send_broadcast(current_room, {"type": "system_message", "payload": {"text": "The drawer abandoned the session!"}})

                if not room["players"]:
                    manager.rooms.pop(current_room, None)
                else:
                    if room["host_id"] == current_player:
                        room["host_id"] = list(room["players"].keys())
                        room["players"][room["host_id"]]["is_host"] = True
                    await send_broadcast(current_room, {"type": "room_updated", "payload": list(room["players"].values())})
