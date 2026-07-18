#!/usr/bin/env python3
"""Validate the deployed bank and optionally compare it with the source zip."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATE_OPTION_QUESTION = re.compile(r"何时|何日|起施行|每年.{0,8}前")


def read_bank(path: Path) -> dict:
    text = path.read_text(encoding="utf-8").strip()
    prefix = "window.QUIZ_BANK = "
    if not text.startswith(prefix) or not text.endswith(";"):
        raise ValueError(f"Unexpected question-bank wrapper: {path}")
    return json.loads(text[len(prefix) : -1])


def stable_id(question: dict) -> str:
    payload = "\n".join(
        [
            question["category"],
            question["type"],
            question["question"],
            "|".join(question["answer"]),
        ]
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]


def audit(bank: dict) -> tuple[dict, list[str]]:
    questions = bank.get("questions", [])
    errors: list[str] = []
    exact_fingerprints = Counter()
    id_counts = Counter()
    type_counts = Counter()
    category_counts = Counter()

    for index, question in enumerate(questions, 1):
        label = f"row {index} id={question.get('id', '<missing>')}"
        required = ("id", "category", "categoryName", "type", "question", "answer", "options")
        for field in required:
            if field not in question or question[field] in (None, "", []):
                errors.append(f"{label}: missing {field}")
        if any(field not in question for field in required):
            continue

        id_counts[question["id"]] += 1
        type_counts[question["type"]] += 1
        category_counts[question["categoryName"]] += 1
        if question["id"] != stable_id(question):
            errors.append(f"{label}: unstable ID")

        option_keys = [option.get("key") for option in question["options"]]
        if len(option_keys) != len(set(option_keys)):
            errors.append(f"{label}: duplicate option keys")
        if any(not str(option.get("text", "")).strip() for option in question["options"]):
            errors.append(f"{label}: empty option text")
        missing_answers = [answer for answer in question["answer"] if answer not in option_keys]
        if missing_answers:
            errors.append(f"{label}: answers not present in options: {missing_answers}")

        for option in question["options"]:
            text = str(option.get("text", "")).strip()
            if (
                DATE_OPTION_QUESTION.search(question["question"])
                and re.fullmatch(r"\d{5}(?:\.0+)?", text)
                and 30000 <= float(text) <= 60000
            ):
                errors.append(f"{label}: leaked Excel date serial {text}")

        fingerprint = json.dumps(
            {
                "category": question["category"],
                "type": question["type"],
                "question": question["question"],
                "answer": question["answer"],
                "options": question["options"],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        exact_fingerprints[fingerprint] += 1

    summary = {
        "questions": len(questions),
        "categories": len(bank.get("categories", [])),
        "types": dict(type_counts),
        "categoryCounts": dict(category_counts),
        "duplicateIds": sum(1 for count in id_counts.values() if count > 1),
        "exactDuplicateRows": sum(count - 1 for count in exact_fingerprints.values() if count > 1),
        "errors": len(errors),
    }
    return summary, errors


def compare_source(bank: dict, zip_path: Path, converter_path: Path) -> list[str]:
    spec = importlib.util.spec_from_file_location("quiz_bank_converter", converter_path)
    if spec is None or spec.loader is None:
        return [f"Cannot load converter: {converter_path}"]
    converter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(converter)
    source = converter.convert(zip_path)
    fields = ("id", "category", "categoryName", "type", "question", "answer", "options", "explanation")
    errors: list[str] = []
    if len(source["questions"]) != len(bank["questions"]):
        errors.append(
            f"Source/current count mismatch: {len(source['questions'])} != {len(bank['questions'])}"
        )
        return errors
    for index, (expected, actual) in enumerate(zip(source["questions"], bank["questions"]), 1):
        for field in fields:
            if expected.get(field) != actual.get(field):
                errors.append(f"row {index} id={actual.get('id')}: source mismatch in {field}")
                break
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bank", type=Path, default=ROOT / "data/questions.js")
    parser.add_argument("--source-zip", type=Path)
    parser.add_argument("--converter", type=Path)
    args = parser.parse_args()

    bank = read_bank(args.bank)
    summary, errors = audit(bank)
    if args.source_zip:
        converter = args.converter or ROOT.parent / "quiz-pwa/scripts/convert_bank.py"
        errors.extend(compare_source(bank, args.source_zip, converter))
        summary["sourceCompared"] = True
    summary["errors"] = len(errors)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if errors:
        print("\n".join(errors[:100]))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
