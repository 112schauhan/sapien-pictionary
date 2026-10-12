from __future__ import annotations

import random
from typing import List, Optional

from constants import WORD_BANK


def normalize_word(word: str) -> str:
    return " ".join(word.lower().strip().split())


def sanitize_word_list(raw_list) -> List[str]:
    """Normalize a custom host word list; fall back to default bank if empty."""
    if not isinstance(raw_list, list):
        return list(WORD_BANK)

    cleaned: List[str] = []
    seen = set()
    for item in raw_list:
        if not isinstance(item, str):
            continue
        word = normalize_word(item)
        if not word or len(word) > 40 or word in seen:
            continue
        seen.add(word)
        cleaned.append(word)

    return cleaned if cleaned else list(WORD_BANK)


def get_random_choices(
    word_bank: Optional[List[str]] = None, count: int = 3
) -> List[str]:
    bank = word_bank if word_bank else WORD_BANK
    if len(bank) <= count:
        return list(bank)
    return random.sample(bank, count)
