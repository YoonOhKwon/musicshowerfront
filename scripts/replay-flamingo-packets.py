"""Replay logged Music Flamingo raw responses through the server's packet parser.

Measures what the sanitizer keeps without loading the model or touching the GPU:
    python scripts/replay-flamingo-packets.py flamingo-server-v23.log flamingo-server-v27.log
    python scripts/replay-flamingo-packets.py --source old_flamingo_server.py *.log

Only the parsing section of flamingo_server.py (from `import re` to `INFERENCE_LOCK`) is executed,
so the model, torch and transformers are never imported.
"""
import argparse
import collections
import io
import json
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path

RAW_MARKER = "[Music Flamingo] RAW MODEL RESPONSE (max 6000 chars)"
SANITIZED_MARKER = "[Music Flamingo] SANITIZED PACKET SENT TO MUSIC SHOWER"
FIELDS = ["audibleObservations", "signatureRelations", "genreHypotheses",
          "contextHypotheses", "aestheticConcepts", "impressions"]


def load_parser(source_path):
    source = Path(source_path).read_text(encoding="utf-8")
    start = source.index("import re\nimport ast")
    end = source.index("INFERENCE_LOCK = threading.Lock()")
    namespace = {"json": json}
    exec(compile(source[start:end], str(source_path), "exec"), namespace)
    return namespace["parse_deep_listen_packet"]


def raw_responses(log_paths):
    for log_path in log_paths:
        text = Path(log_path).read_text(encoding="utf-8", errors="replace")
        for block in text.split(RAW_MARKER)[1:]:
            raw = block.split(SANITIZED_MARKER)[0].strip()
            if raw:
                yield raw


def raw_audible_categories(raw):
    return re.findall(r"""["']category["']\s*:\s*["']([^"']{1,40})["']""",
                      raw.split("genreHypotheses")[0] if raw.find("audibleObservations") < raw.find("genreHypotheses") else raw)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("logs", nargs="+")
    parser.add_argument("--source", default=str(Path(__file__).with_name("flamingo_server.py")))
    args = parser.parse_args()
    parse = load_parser(args.source)

    packets = 0
    field_totals = collections.Counter()
    unique_texts = collections.defaultdict(set)
    kept_categories = collections.Counter()
    quarantined = collections.Counter()
    for raw in raw_responses(args.logs):
        with redirect_stdout(io.StringIO()):
            packet = parse(raw)
        packets += 1
        for field in FIELDS:
            for item in packet.get(field) or []:
                field_totals[field] += 1
                unique_texts[field].add(str(item.get("text") or item.get("label") or "").casefold())
                if field == "audibleObservations":
                    kept_categories[item.get("sourceCategory") or item.get("category")] += 1
        for note in packet.get("uncertainties") or []:
            if "category" in note:
                quarantined[note] += 1

    report = {
        "source": args.source,
        "packets": packets,
        "items": dict(field_totals),
        "uniqueTexts": {field: len(unique_texts[field]) for field in FIELDS},
        "audibleCategoriesKept": dict(kept_categories.most_common()),
        "quarantineNotes": dict(quarantined),
    }
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
