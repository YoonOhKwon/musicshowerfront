"""Exercise server cancellation functions without importing GPU/model dependencies."""
import ast
from pathlib import Path
import threading
import unittest

source = ast.parse(Path(__file__).with_name("flamingo_server.py").read_text(encoding="utf-8"))
functions = [node for node in source.body if isinstance(node, ast.FunctionDef) and
             node.name in {"register_inference", "unregister_inference", "cancel_inferences"}]


class CancellationTest(unittest.TestCase):
    def setUp(self):
        self.scope = {"threading": threading, "ACTIVE_INFERENCES_LOCK": threading.Lock(), "ACTIVE_INFERENCES": {}}
        exec(compile(ast.Module(body=functions, type_ignores=[]), "cancellation", "exec"), self.scope)

    def test_other_listener_survives_and_same_listener_is_superseded(self):
        register = self.scope["register_inference"]
        old = register("a1", "a", 1)
        other = register("b1", "b", 1)
        self.assertFalse(old.is_set())
        new = register("a2", "a", 1)
        self.assertTrue(old.is_set())
        self.assertFalse(other.is_set())
        self.scope["cancel_inferences"]("a1", "a", 1)
        self.assertFalse(new.is_set(), "late cancellation must not cancel the newer request")
        self.scope["cancel_inferences"](session_id="a", track_epoch=1)
        self.assertTrue(new.is_set())
        self.assertFalse(other.is_set())


if __name__ == "__main__":
    unittest.main()
