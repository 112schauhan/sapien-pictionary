from __future__ import annotations

from constants import (
    DEFAULT_DRAW_TIME,
    DEFAULT_ROUNDS,
    GUESS_BASE_POINTS,
    GUESS_TIME_BONUS_MAX,
    DRAWER_POINTS_PER_GUESS,
    MAX_DRAW_TIME,
    MAX_ROUNDS,
    MAX_WORD_LIST_SIZE,
    MIN_DRAW_TIME,
    MIN_ROUNDS,
)
from words import get_random_choices, normalize_word, sanitize_word_list


class GameManager:
    def __init__(self) -> None:
        self.rooms: dict[str, dict] = {}
        # recovery_key -> {player_profile, cancel_task}
        self.disconnected_players: dict[str, dict] = {}

    def get_or_create_room(
        self,
        room_id: str,
        player_id: str,
        name: str,
        host_settings: dict | None = None,
    ) -> dict:
        if room_id not in self.rooms:
            settings = host_settings or {}
            rounds = self._clamp_int(
                settings.get("rounds", DEFAULT_ROUNDS), MIN_ROUNDS, MAX_ROUNDS, DEFAULT_ROUNDS
            )
            draw_time = self._clamp_int(
                settings.get("drawTime", DEFAULT_DRAW_TIME),
                MIN_DRAW_TIME,
                MAX_DRAW_TIME,
                DEFAULT_DRAW_TIME,
            )
            word_list = sanitize_word_list(settings.get("wordList"))
            if len(word_list) > MAX_WORD_LIST_SIZE:
                word_list = word_list[:MAX_WORD_LIST_SIZE]

            self.rooms[room_id] = {
                "id": room_id,
                "host_id": player_id,
                "players": {},
                "player_order": [],
                "current_drawer_id": None,
                "current_word": None,
                "word_choices": [],
                "game_status": "lobby",
                "history": [],
                "replay_store": [],
                "timer": 0,
                "total_rounds": rounds,
                "draw_time": draw_time,
                "word_list": word_list,
                "current_round": 1,
                "has_guessed_count": 0,
                "stroke_seq": 0,
                "timer_task": None,
                "turn_end_task": None,
                "auto_pick_task": None,
            }

        room = self.rooms[room_id]
        recovery_key = f"{room_id}_{player_id}"

        if recovery_key in self.disconnected_players:
            saved = self.disconnected_players.pop(recovery_key)
            room["players"][player_id] = saved["player_profile"]
            if saved.get("cancel_task"):
                saved["cancel_task"].cancel()
            if player_id not in room["player_order"]:
                room["player_order"].append(player_id)
        elif player_id not in room["players"]:
            room["players"][player_id] = {
                "id": player_id,
                "name": name[:20] if name else "Player",
                "score": 0,
                "is_host": room["host_id"] == player_id,
                "is_correct": False,
            }
            room["player_order"].append(player_id)
        else:
            # Same player_id reconnecting while still listed (duplicate tab edge case)
            room["players"][player_id]["name"] = name[:20] if name else room["players"][player_id]["name"]

        return room

    def public_room_state(self, room: dict, viewer_id: str | None = None) -> dict:
        """Sanitize room state so clients never receive the secret word."""
        is_drawer = viewer_id is not None and room.get("current_drawer_id") == viewer_id
        hint = ""
        if room["game_status"] == "drawing" and room.get("current_word"):
            if is_drawer:
                hint = room["current_word"]
            else:
                elapsed = 100 * (1 - (room["timer"] / max(1, room["draw_time"])))
                hint = self.make_obfuscated_hint(room["current_word"], elapsed)

        return {
            "id": room["id"],
            "host_id": room["host_id"],
            "players": list(room["players"].values()),
            "current_drawer_id": room["current_drawer_id"],
            "game_status": room["game_status"],
            "timer": room["timer"],
            "total_rounds": room["total_rounds"],
            "draw_time": room["draw_time"],
            "current_round": room["current_round"],
            "hint": hint,
            "word_list_size": len(room.get("word_list", [])),
        }

    def setup_new_turn(self, room_id: str) -> dict | None:
        """Advance drawer / round and return turn payload metadata."""
        room = self.rooms.get(room_id)
        if not room:
            return None

        order = [pid for pid in room["player_order"] if pid in room["players"]]
        room["player_order"] = order
        if len(order) < 1:
            return None

        prev_drawer = room.get("current_drawer_id")
        if prev_drawer and prev_drawer in order:
            next_idx = (order.index(prev_drawer) + 1) % len(order)
            if next_idx == 0:
                room["current_round"] += 1
            room["current_drawer_id"] = order[next_idx]
        else:
            room["current_drawer_id"] = order[0]

        if room["current_round"] > room["total_rounds"]:
            room["game_status"] = "game_over"
            room["current_word"] = None
            room["word_choices"] = []
            return {"ended": True}

        room["game_status"] = "choosing"
        room["history"] = []
        room["has_guessed_count"] = 0
        room["current_word"] = None
        room["timer"] = room["draw_time"]
        room["stroke_seq"] = 0

        for pid in room["players"]:
            room["players"][pid]["is_correct"] = False

        choices = get_random_choices(room.get("word_list"), 3)
        room["word_choices"] = choices
        return {
            "ended": False,
            "drawerId": room["current_drawer_id"],
            "choices": choices,
            "round": room["current_round"],
            "totalRounds": room["total_rounds"],
        }

    def begin_drawing(self, room_id: str, player_id: str, word: str) -> bool:
        room = self.rooms.get(room_id)
        if not room:
            return False
        if room["current_drawer_id"] != player_id or room["game_status"] != "choosing":
            return False

        chosen = normalize_word(word)
        if chosen not in room.get("word_choices", []):
            return False

        room["current_word"] = chosen
        room["word_choices"] = []
        room["game_status"] = "drawing"
        room["timer"] = room["draw_time"]
        room["has_guessed_count"] = 0
        room["history"] = []
        return True

    def score_correct_guess(self, room: dict, guesser_id: str) -> int:
        """Award points to guesser and drawer. Returns points given to guesser."""
        remaining = max(0, room["timer"])
        draw_time = max(1, room["draw_time"])
        points = GUESS_BASE_POINTS + int((remaining / draw_time) * GUESS_TIME_BONUS_MAX)

        guesser = room["players"][guesser_id]
        guesser["is_correct"] = True
        guesser["score"] += points
        room["has_guessed_count"] += 1

        drawer_id = room.get("current_drawer_id")
        if drawer_id and drawer_id in room["players"]:
            room["players"][drawer_id]["score"] += DRAWER_POINTS_PER_GUESS

        return points

    def everyone_guessed(self, room: dict) -> bool:
        guessers = max(0, len(room["players"]) - 1)
        return guessers > 0 and room["has_guessed_count"] >= guessers

    def check_near_miss(self, guess: str, target: str) -> bool:
        guess = normalize_word(guess)
        target = normalize_word(target)
        if not guess or not target:
            return False
        if abs(len(guess) - len(target)) > 1:
            return False
        return self._levenshtein(guess, target) == 1

    def contains_secret_word(self, text: str, word: str) -> bool:
        """True if the message would reveal the secret word to others."""
        if not word:
            return False
        normalized = normalize_word(text)
        secret = normalize_word(word)
        if normalized == secret:
            return True
        # Block spaced/joined variants that dump the answer
        compact = normalized.replace(" ", "")
        secret_compact = secret.replace(" ", "")
        if secret_compact and secret_compact in compact:
            return True
        tokens = normalized.split()
        return secret in tokens

    def make_obfuscated_hint(self, word: str, elapsed_percent: float) -> str:
        if not word:
            return ""
        letters = [c for c in word if c != " "]
        # Reveal up to half the letters over the round
        reveal_limit = int((elapsed_percent / 100) * max(1, len(letters) // 2))
        revealed = 0
        parts: list[str] = []
        for char in word:
            if char == " ":
                parts.append(" ")
            elif revealed < reveal_limit:
                parts.append(char)
                revealed += 1
            else:
                parts.append("_")
        return " ".join(parts)

    def append_stroke(self, room: dict, stroke: dict) -> dict:
        room["stroke_seq"] += 1
        stroke = {**stroke, "seq": room["stroke_seq"]}
        tool = stroke.get("tool")
        if tool == "undo":
            # Remove last drawable stroke from history (not undo/clear markers alone)
            for i in range(len(room["history"]) - 1, -1, -1):
                if room["history"][i].get("tool") not in ("undo",):
                    room["history"].pop(i)
                    break
            room["replay_store"].append(stroke)
            return stroke
        if tool == "clear":
            room["history"] = []
            room["replay_store"].append(stroke)
            return stroke

        # Incremental streaming: accumulate points server-side for mid-join sync
        stroke_id = stroke.get("strokeId")
        phase = stroke.get("phase", "end")
        new_points = stroke.get("points") or []

        if stroke_id and phase in ("begin", "move"):
            for i in range(len(room["history"]) - 1, -1, -1):
                existing = room["history"][i]
                if existing.get("strokeId") == stroke_id:
                    merged_points = list(existing.get("points") or []) + list(new_points)
                    # Cap stored points to keep mid-join payloads bounded
                    if len(merged_points) > 2000:
                        merged_points = merged_points[-2000:]
                    room["history"][i] = {**stroke, "points": merged_points}
                    return stroke
            room["history"].append(stroke)
            return stroke

        # Final stroke: merge with any in-progress version, then seal for replay
        if stroke_id:
            accumulated: list = []
            kept: list = []
            for s in room["history"]:
                if s.get("strokeId") == stroke_id:
                    accumulated.extend(s.get("points") or [])
                else:
                    kept.append(s)
            room["history"] = kept
            if not new_points and accumulated:
                stroke = {**stroke, "points": accumulated}
            elif accumulated:
                stroke = {**stroke, "points": accumulated + list(new_points)}

        room["history"].append(stroke)
        room["replay_store"].append(stroke)
        return stroke

    def transfer_host(self, room: dict, leaving_id: str) -> None:
        if room["host_id"] != leaving_id:
            return
        remaining = [pid for pid in room["player_order"] if pid in room["players"] and pid != leaving_id]
        if not remaining:
            remaining = [pid for pid in room["players"] if pid != leaving_id]
        if remaining:
            room["host_id"] = remaining[0]
            for pid, player in room["players"].items():
                player["is_host"] = pid == room["host_id"]

    def remove_player(self, room_id: str, player_id: str) -> dict | None:
        room = self.rooms.get(room_id)
        if not room:
            return None
        room["players"].pop(player_id, None)
        if player_id in room["player_order"]:
            room["player_order"].remove(player_id)
        self.transfer_host(room, player_id)
        if not room["players"]:
            self.rooms.pop(room_id, None)
            return None
        return room

    def reset_room_state(self, room_id: str) -> dict | None:
        room = self.rooms.get(room_id)
        if not room:
            return None
        room["game_status"] = "lobby"
        room["history"] = []
        room["replay_store"] = []
        room["current_drawer_id"] = None
        room["current_word"] = None
        room["word_choices"] = []
        room["timer"] = 0
        room["current_round"] = 1
        room["has_guessed_count"] = 0
        room["stroke_seq"] = 0
        for pid in room["players"]:
            room["players"][pid]["score"] = 0
            room["players"][pid]["is_correct"] = False
        return room

    @staticmethod
    def _clamp_int(value, lo: int, hi: int, default: int) -> int:
        try:
            n = int(value)
        except (TypeError, ValueError):
            return default
        return max(lo, min(hi, n))

    @staticmethod
    def _levenshtein(a: str, b: str) -> int:
        if a == b:
            return 0
        if not a:
            return len(b)
        if not b:
            return len(a)
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            curr = [i]
            for j, cb in enumerate(b, 1):
                cost = 0 if ca == cb else 1
                curr.append(min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost))
            prev = curr
        return prev[-1]
