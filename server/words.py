import random
from constants import WORD_BANK


def get_random_choices(count: int = 3) -> list:
    return random.sample(WORD_BANK, min(count, len(WORD_BANK)))
