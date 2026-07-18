#!/usr/bin/env python3
"""Repair Excel date serials without changing question IDs or answer keys."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATCHES = {
    "2cf9f46aea28": {
        "B": "8月8日",
        "C": "8月9日",
        "D": "8月15日",
    },
    "69bfb6c39703": {
        "A": "2024年11月8日",
        "B": "2025年1月1日",
        "C": "2024年12月1日",
        "D": "2025年3月1日",
    },
    "abe1a2f4c3d2": {
        "A": "12月15日",
        "B": "12月20日",
        "C": "12月28日",
        "D": "12月31日",
    },
}


def read_bank(path: Path) -> dict:
    text = path.read_text(encoding="utf-8").strip()
    prefix = "window.QUIZ_BANK = "
    if not text.startswith(prefix) or not text.endswith(";"):
        raise ValueError(f"Unexpected question-bank wrapper: {path}")
    return json.loads(text[len(prefix) : -1])


def write_bank(path: Path, bank: dict) -> None:
    payload = json.dumps(bank, ensure_ascii=False, separators=(",", ":"))
    path.write_text(f"window.QUIZ_BANK = {payload};\n", encoding="utf-8")


def repair(path: Path) -> tuple[int, set[str]]:
    bank = read_bank(path)
    changed = 0
    found: set[str] = set()
    for question in bank.get("questions", []):
        patch = PATCHES.get(question.get("id"))
        if not patch:
            continue
        found.add(question["id"])
        before_id = question["id"]
        before_answer = list(question.get("answer", []))
        for option in question.get("options", []):
            replacement = patch.get(option.get("key"))
            if replacement and option.get("text") != replacement:
                option["text"] = replacement
                changed += 1
        if question["id"] != before_id or question.get("answer") != before_answer:
            raise RuntimeError(f"Protected fields changed for {before_id}")
    if changed:
        write_bank(path, bank)
    return changed, found


def main() -> None:
    total = 0
    full_found: set[str] = set()
    for relative in ("data/questions.js", "data/starter.js"):
        path = ROOT / relative
        changed, found = repair(path)
        total += changed
        if relative.endswith("questions.js"):
            full_found = found
        print(f"{relative}: repaired {changed} option values")
    missing = set(PATCHES) - full_found
    if missing:
        raise RuntimeError(f"Full bank is missing repair targets: {sorted(missing)}")
    print(f"Repaired {total} option values; IDs and answers preserved")


if __name__ == "__main__":
    main()
