"""Regression coverage for the real, isolated deterministic graph publisher."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("sync-text-graph.py")


class RepeatedHeadingSyncTests(unittest.TestCase):
    def test_repeated_headings_keep_distinct_ids_and_evidence(self):
        spec = importlib.util.spec_from_file_location("sync_text_graph", SCRIPT)
        sync = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sync)
        with tempfile.TemporaryDirectory(prefix="thehive-graph-regression-") as directory:
            root = Path(directory)
            source_name = "10_Projekte/Repeated.md"
            source = root / source_name
            source.parent.mkdir()
            source_bytes = b"# Project\n\n## Same heading\nFirst occurrence.\n\n## Same heading\nSecond occurrence.\n"
            source.write_bytes(source_bytes)
            (root / ".graphifyignore").write_text("work/\ngraphify-out/\n", encoding="utf-8")
            maintenance = root / "work/maintenance"
            maintenance.mkdir(parents=True)
            archive_name = "graphify-out/archive/semantic-fixture"
            archive = root / archive_name
            archive.mkdir(parents=True)
            baseline = {
                "directed": False, "multigraph": False, "graph": {},
                "nodes": [
                    {"id": "semantic_a", "label": "Shared semantic label", "source_file": source_name,
                     "source_location": "L1", "file_type": "concept", "_origin": "semantic"},
                    {"id": "semantic_b", "label": "Shared semantic label", "source_file": source_name,
                     "source_location": "L1", "file_type": "concept", "_origin": "semantic"},
                ],
                "links": [
                    {"source": "semantic_a", "target": "semantic_b", "relation": "supports",
                     "source_file": source_name, "source_location": "L1", "confidence": "INFERRED",
                     "confidence_score": 0.7, "weight": 1.0, "_origin": "semantic"},
                ],
            }
            baseline_bytes = json.dumps(baseline).encode("utf-8")
            (archive / "graph.json").write_bytes(baseline_bytes)
            metadata = {
                "nodes": 2, "edges": 1,
                "artifacts": {"graph.json": hashlib.sha256(baseline_bytes).hexdigest()},
                "source_sha256": {source_name: hashlib.sha256(source_bytes).hexdigest()},
            }
            metadata_bytes = json.dumps(metadata).encode("utf-8")
            (archive / "archive.json").write_bytes(metadata_bytes)
            (maintenance / "text-graph-state.json").write_text(
                json.dumps({"baseline_archive": archive_name}), encoding="utf-8")

            try:
                result = sync.run(root, html=False)
            except RuntimeError as error:
                self.fail(f"Real graph sync must preserve repeated heading occurrences: {error}")

            self.assertEqual(result["status"], "updated")
            output = json.loads((root / "graphify-out/graph.json").read_text(encoding="utf-8"))
            headings = [node for node in output["nodes"]
                        if node.get("kind") == "heading" and node["label"] == "[Ueberschrift] Same heading"]
            self.assertEqual(len(headings), 2)
            self.assertEqual(len({node["id"] for node in headings}), 2)
            self.assertEqual({node["source_location"] for node in headings}, {"L3", "L6"})
            evidence = [edge for edge in output["links"]
                        if edge["relation"] == "contains_heading"
                        and edge["target"] in {node["id"] for node in headings}]
            self.assertEqual(len(evidence), 2)
            self.assertEqual({edge["source_location"] for edge in evidence}, {"L3", "L6"})
            self.assertTrue(all(edge["evidence"][0]["text"] == "## Same heading" for edge in evidence))
            self.assertEqual((archive / "graph.json").read_bytes(), baseline_bytes)
            self.assertEqual((archive / "archive.json").read_bytes(), metadata_bytes)
            self.assertEqual(source.read_bytes(), source_bytes)
            semantic_nodes = [node for node in output["nodes"] if node.get("layer") == "historical_semantic"]
            self.assertEqual({node["id"] for node in semantic_nodes}, {"semantic_a", "semantic_b"})
            semantic_edges = [edge for edge in output["links"] if edge.get("layer") == "historical_semantic"]
            self.assertEqual(len(semantic_edges), 1)
            for field, value in baseline["links"][0].items():
                self.assertEqual(semantic_edges[0][field], value)
            for node in semantic_nodes:
                original = next(item for item in baseline["nodes"] if item["id"] == node["id"])
                for field, value in original.items():
                    self.assertEqual(node[field], value)


if __name__ == "__main__":
    unittest.main()
