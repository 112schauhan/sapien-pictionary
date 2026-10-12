from words import get_random_choices


class GameManager:
    def __init__(self):
        self.rooms = {}

    def get_or_create_room(self, room_id: str, player_id: str, name: str) -> dict:
        if room_id not in self.rooms:
            self.rooms[room_id] = {
                "id": room_id,
                "host_id": player_id,
                "players": {},
                "current_drawer_id": None,
                "current_word": None,
                "game_status": "lobby",
                "history": [],
                "timer": 0,
                "has_guessed_count": 0
            }

        room = self.rooms[room_id]
        if player_id not in room["players"]:
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
            room["current_drawer_id"] = p_ids[0]
        else:
            next_idx = (p_ids.index(
                room["current_drawer_id"]) + 1) % len(p_ids)
            room["current_drawer_id"] = p_ids[next_idx]

        return get_random_choices(3)

    def check_near_miss(self, guess: str, target: str) -> bool:
        if abs(len(guess) - len(target)) > 1:
            return False

        # Simple Levenshtein distance matching 1-letter deviations
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
