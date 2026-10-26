#!/usr/bin/env python3
from __future__ import annotations
import concurrent.futures, json, os, pathlib, time
from openai import OpenAI

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "core/locales/ja_to_en_source.json"
OUTPUT = ROOT / "core/locales/ja_to_en.json"
MODEL = "gpt-6-luna"
BATCH_SIZE = 80

items = json.loads(SOURCE.read_text(encoding="utf-8"))
for index, item in enumerate(items):
    item["id"] = index

schema = {
    "type": "json_schema",
    "json_schema": {
        "name": "translations",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "translations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "id": {"type": "integer"},
                            "en": {"type": "string"},
                        },
                        "required": ["id", "en"],
                    },
                }
            },
            "required": ["translations"],
        },
    },
}

def translate(batch):
    client = OpenAI()
    payload = [{"id": x["id"], "text": x["text"]} for x in batch]
    prompt = (
        "Translate every Japanese UI/message string to natural concise English. "
        "Return exactly one result for every id. Preserve Markdown, Discord mentions, "
        "format placeholders such as {user}, printf placeholders such as %s, backticks, "
        "emoji, newlines, and punctuation. Translate fragments literally when they are "
        "only a label or a prefix; do not omit or merge entries. Do not translate proper "
        "names, commands, URLs, variable names, or code identifiers.\n\n"
        + json.dumps(payload, ensure_ascii=False)
    )
    for attempt in range(4):
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": "You are a precise Japanese-to-English software UI translator."},
                    {"role": "user", "content": prompt},
                ],
                response_format=schema,
                max_completion_tokens=16000,
            )
            data = json.loads(response.choices[0].message.content)
            result = {int(x["id"]): x["en"] for x in data["translations"]}
            missing = [x["id"] for x in batch if x["id"] not in result]
            if missing:
                raise ValueError(f"missing ids: {missing[:10]}")
            return result
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)

batches = [items[i:i + BATCH_SIZE] for i in range(0, len(items), BATCH_SIZE)]
merged = {}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    futures = {pool.submit(translate, batch): index for index, batch in enumerate(batches)}
    for completed, future in enumerate(concurrent.futures.as_completed(futures), 1):
        index = futures[future]
        merged.update(future.result())
        print(f"completed {completed}/{len(batches)} batch={index}", flush=True)

catalog = {item["text"]: merged[item["id"]] for item in items}
OUTPUT.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"wrote {len(catalog)} translations to {OUTPUT}")
