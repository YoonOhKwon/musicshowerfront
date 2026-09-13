"""Summarize Music Flamingo exchanges recorded in a flamingo-server log.

    python scripts/summarize-flamingo-log.py flamingo-server-v29.log --first 4

For every inference: listen depth, raw length, whether generation was cut off before the JSON
closed, and the sanitized item count per field. Style cues are listed verbatim.
"""
import argparse
import collections
import json
import sys
from pathlib import Path

RAW = "[Music Flamingo] RAW MODEL RESPONSE (max 6000 chars)"
SANITIZED = "[Music Flamingo] SANITIZED PACKET SENT TO MUSIC SHOWER (max 6000 chars)"
END = "[Music Flamingo] END PACKET"
FIELDS = ["audibleObservations", "signatureRelations", "styleCues", "genreHypotheses",
          "contextHypotheses", "aestheticConcepts", "impressions"]


def exchanges(text):
    cursor = 0
    while True:
        start = text.find(RAW, cursor)
        if start < 0:
            return
        middle = text.find(SANITIZED, start)
        end = text.find(END, middle)
        if middle < 0 or end < 0:
            return
        before = text[max(0, text.rfind("Running Flamingo", 0, start)):start]
        raw = text[start + len(RAW):middle].strip()
        try:
            packet = json.loads(text[middle + len(SANITIZED):end].strip())
        except ValueError:
            packet = {}
        yield {"firstImpression": "(first impression)" in before, "raw": raw, "packet": packet}
        cursor = end


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("log")
    parser.add_argument("--first", type=int, default=0, help="only the first N exchanges")
    parser.add_argument("--skip", type=int, default=0)
    args = parser.parse_args()
    items = list(exchanges(Path(args.log).read_text(encoding="utf-8", errors="replace")))[args.skip:]
    if args.first:
        items = items[:args.first]

    totals = collections.Counter()
    truncated = 0
    cues = []
    rows = []
    for index, item in enumerate(items, 1):
        closed = item["raw"].rstrip().endswith("}")
        truncated += not closed
        counts = {field: len(item["packet"].get(field) or []) for field in FIELDS}
        totals.update(counts)
        cues.extend(cue.get("text", "") for cue in item["packet"].get("styleCues") or [])
        rows.append({"n": index, "depth": "first" if item["firstImpression"] else "full",
                     "rawChars": len(item["raw"]), "truncated": not closed, **counts})
    report = {"log": args.log, "exchanges": len(items), "truncated": truncated,
              "fieldTotals": dict(totals), "styleCues": cues, "perExchange": rows}
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
