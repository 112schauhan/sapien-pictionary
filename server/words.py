import random

WORD_BANK = ["apple", "banana", "castle", "dragon", "elephant", "guitar", "helicopter",
             "iceberg", "jungle", "kangaroo", "lighthouse", "mountain", "ocean",
             "penguin", "pyramid", "robot", "spaceship", "submarine", "volcano", "wizard"]


def get_random_choices(count: int = 3) -> list:
    return random.sample(WORD_BANK, min(count, len(WORD_BANK)))
