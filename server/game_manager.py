from words import get_random_choices


class GameManager:
    def __init__(self):
        self.rooms = {}

    def get_or_create_room(self, room_id: str, player_id: str, name: str, host_settings: dict = None) -> dict:
        if room_id not in self.rooms:
            # Safely handle incoming custom configurations from the host client UI
            rounds = int(host_settings.get("rounds", 3)
                         ) if host_settings else 3
            draw_time = int(host_settings.get("drawTime", 60)
                            ) if host_settings else 60

            self.rooms[room_id] = {
                "id": room_id,
                "host_id": player_id,
                "players": {},
                "current_drawer_id": None,
                "current_word": None,
                "game_status": "lobby",
                "history": [],  # Active canvas stroke lines cache array
                "replay_store": [],  # Grand master persistent store of all game lines for final replay
                "timer": 0,
                "total_rounds": rounds,
                "draw_time": draw_time,
                "current_round": 1,
                "has_guessed_count": 0
            }

        room = self.rooms[room_id]

        # Session Recovery: Check if the user is reconnecting within the 30-second window
        recovery_key = f"{room_id}_{player_id}"
        if recovery_key in self.disconnected_players:
            saved_data = self.disconnected_players.pop(recovery_key)
            room["players"][player_id] = saved_data["player_profile"]
            # Cancel the pending deletion task
            if saved_data["cancel_task"]:
                saved_data["cancel_task"].cancel()
        elif player_id not in room["players"]:
            room["players"][player_id] = {
                "id": player_id,
                "name": name,
                "score": 0,
                "is_host": (room["host_id"] == player_id),
                "is_correct": False
            }
        return room

    def setup_new_turn(self, room_id: str):
        room = self.rooms[room_id]
        room["game_status"] = "choosing"
        room["history"] = []
        room["has_guessed_count"] = 0

        for p_id in room["players"]:
            room["players"][p_id]["is_correct"] = False

        p_ids = list(room["players"].keys())
        if not room["current_drawer_id"] or room["current_drawer_id"] not in p_ids:
            room["current_drawer_id"] = p_ids
        else:
            next_idx = (p_ids.index(
                room["current_drawer_id"]) + 1) % len(p_ids)
            room["current_drawer_id"] = p_ids[next_idx]

        # Dynamically pulls choice counts from our underlying dictionary mapping layers
        return get_random_choices(3)

    def check_near_miss(self, guess: str, target: str) -> bool:
        if abs(len(guess) - len(target)) > 1:
            return False

        matrix = [[0] * (len(target) + 1) for _ in range(len(guess) + 1)]
        for i in range(len(guess) + 1):
            matrix[i][0] = i
        for j in range(len(target) + 1):
            matrix[0][j] = j

        for i in range(1, len(guess) + 1):
            for j in range(1, len(target) + 1):
                cost = 0 if guess[i-1] == target[j-1] else 1
                matrix[i][j] = min(matrix[i-1][j] + 1, matrix[i]
                                   [j-1] + 1, matrix[i-1][j-1] + cost)

        return matrix[len(guess)][len(target)] == 1

    def make_obfuscated_hint(self, word: str, elapsed_percent: float) -> str:
        reveal_limit = int((elapsed_percent / 100) * (len(word) // 2))
        hidden_chars = []
        for idx, char in enumerate(word):
            if char == " ":
                hidden_chars.append(" ")
            elif idx < reveal_limit:
                hidden_chars.append(char)
            else:
                hidden_chars.append("_")
        return " ".join(hidden_chars)
