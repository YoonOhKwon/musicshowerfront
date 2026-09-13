"""Packet sanitizer checks that run without importing torch or loading the model.

    .research-venv/Scripts/python.exe -m unittest test/flamingo_packet_test.py
"""
import json
from pathlib import Path
import unittest

SOURCE = (Path(__file__).parents[1] / "scripts" / "flamingo_server.py").read_text(encoding="utf-8")
START = SOURCE.index("import re\nimport ast")
END = SOURCE.index("INFERENCE_LOCK = threading.Lock()")
scope = {"json": json}
exec(compile(SOURCE[START:END], "flamingo_packet", "exec"), scope)
sanitize_packet = scope["sanitize_packet"]
fact_category = scope["fact_category"]
parse_packet = scope["parse_deep_listen_packet"]


class PacketRepairTest(unittest.TestCase):
    def test_truncated_nested_packet_keeps_completed_fields(self):
        raw = ("{'audibleObservations': [{'id': 1, 'text': 'steady 4/4 pulse', 'category': 'rhythm'}, "
               "{'id': 2, 'text': 'bright brass timbre', 'category': 'instrumentation'}], "
               "'styleCues': [{'id': 'c1', 'text': 'tape saturated drum loop', 'supportRefs': [1]}], "
               "'genreHypotheses': [{'label': 'jazz', 'confidence': 0.6, 'supportRefs': [1, 2")
        packet = parse_packet(raw)
        self.assertEqual([item["text"] for item in packet["audibleObservations"]],
                         ["steady 4/4 pulse", "bright brass timbre"])
        self.assertEqual(packet["styleCues"][0]["text"], "tape saturated drum loop")
        self.assertEqual(packet["styleCues"][0]["supportRefs"], ["1"])

    def test_style_cues_are_capped_deduplicated_and_counted(self):
        cues = [{"text": f"cue number {i}", "confidence": 0.7} for i in range(6)]
        packet = sanitize_packet({"styleCues": cues + cues[:2]})
        self.assertEqual(len(packet["styleCues"]), 4)
        self.assertEqual(packet["packetDiagnostics"]["fieldCounts"]["styleCues"], 4)


class FactCategoryTest(unittest.TestCase):
    def test_model_written_categories_map_to_display_facets(self):
        self.assertEqual(fact_category("harmony"), "arrangement")
        self.assertEqual(fact_category("bass motion"), "instrumentation")
        self.assertEqual(fact_category("Drums"), "rhythm")
        self.assertEqual(fact_category("vocal sample"), "instrumentation")
        self.assertEqual(fact_category("rhythm"), "rhythm")
        self.assertEqual(fact_category("mood"), "")

    def test_mapped_observations_survive_and_keep_their_source_category(self):
        packet = sanitize_packet({"audibleObservations": [
            {"text": "steady 4/4 swing", "category": "rhythm", "confidence": 0.9},
            {"text": "walking bass line", "category": "bass motion", "confidence": 0.9},
            {"text": "major key chord changes", "category": "harmony", "confidence": 0.8},
            {"text": "wistful and tender", "category": "mood", "confidence": 0.8},
        ]})
        kept = {item["text"]: item for item in packet["audibleObservations"]}
        self.assertEqual(kept["walking bass line"]["category"], "instrumentation")
        self.assertEqual(kept["walking bass line"]["sourceCategory"], "bass motion")
        self.assertEqual(kept["major key chord changes"]["category"], "arrangement")
        self.assertNotIn("sourceCategory", kept["steady 4/4 swing"])
        self.assertNotIn("wistful and tender", kept)
        self.assertIn("unrecognized audible category", packet["uncertainties"])

    def test_eight_distinct_observations_survive_and_repeats_do_not_count(self):
        texts = ["steady 4/4 pulse", "bright brass timbre", "simple major harmony", "steady bass line",
                 "steady drum pattern", "bright clean production", "steady tempo", "steady dynamics"]
        categories = ["rhythm", "instrumentation", "harmony", "bass", "drums", "production", "tempo", "dynamics"]
        items = [{"text": t, "category": c, "confidence": 0.9} for t, c in zip(texts, categories)]
        packet = sanitize_packet({"audibleObservations": items + items[:3] + [
            {"text": "ninth distinct observation", "category": "performance", "confidence": 0.9}]})
        kept = [item["text"] for item in packet["audibleObservations"]]
        self.assertEqual(len(kept), 8)
        self.assertEqual(len(set(kept)), 8)
        self.assertEqual(packet["packetDiagnostics"]["duplicateOrRejectedCount"], 4)

    def test_balance_rotates_over_source_categories(self):
        # Two different source facets that share a display facet must not starve each other.
        items = [{"text": f"groove detail {i}", "category": "rhythm", "confidence": 0.9} for i in range(5)]
        items.append({"text": "tight drum kit groove", "category": "drums", "confidence": 0.8})
        packet = sanitize_packet({"audibleObservations": items})
        self.assertIn("tight drum kit groove", [item["text"] for item in packet["audibleObservations"]])


if __name__ == "__main__":
    unittest.main()
