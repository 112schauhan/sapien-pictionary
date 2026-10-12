WORD_BANK = [
    "apple",
    "banana",
    "castle",
    "dragon",
    "elephant",
    "guitar",
    "helicopter",
    "iceberg",
    "jungle",
    "kangaroo",
    "lighthouse",
    "mountain",
    "ocean",
    "penguin",
    "pyramid",
    "robot",
    "spaceship",
    "submarine",
    "volcano",
    "wizard",
    "bicycle",
    "camera",
    "dolphin",
    "firetruck",
    "giraffe",
    "hamburger",
    "igloo",
    "jellyfish",
    "koala",
    "lollipop",
    "mushroom",
    "notebook",
    "octopus",
    "pineapple",
    "rainbow",
    "scooter",
    "telescope",
    "umbrella",
    "violin",
    "watermelon",
]

DEFAULT_ROUNDS = 3
DEFAULT_DRAW_TIME = 60
MIN_ROUNDS = 1
MAX_ROUNDS = 10
MIN_DRAW_TIME = 20
MAX_DRAW_TIME = 180
MIN_PLAYERS_TO_START = 2

# Reconnect grace period before score/player is purged
DISCONNECT_GRACE_SECONDS = 30

# Brief pause between turns so players can see the revealed word
TURN_END_PAUSE_SECONDS = 3

# Abuse protection
MAX_STROKE_RATE_PER_SECOND = 40
MAX_CHAT_RATE_PER_SECOND = 4
MAX_STROKE_PAYLOAD_BYTES = 8192
MAX_CHAT_MESSAGE_CHARS = 80
MAX_NAME_CHARS = 20
MAX_WORD_LIST_SIZE = 200
MAX_POINTS_PER_STROKE = 64

# Scoring
GUESS_BASE_POINTS = 100
GUESS_TIME_BONUS_MAX = 400
DRAWER_POINTS_PER_GUESS = 50
