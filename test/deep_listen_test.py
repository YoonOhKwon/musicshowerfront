import importlib.util
from pathlib import Path
import tempfile
import unittest
import wave

spec = importlib.util.spec_from_file_location("deep_listen", Path(__file__).parents[1] / "scripts" / "deep-listen.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DeepListenTest(unittest.TestCase):
    def wav(self, directory, seconds):
        path = Path(directory) / "clip.wav"
        with wave.open(str(path), "wb") as stream:
            stream.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            stream.writeframes(b"\0\0" * (8000 * seconds))
        return path

    def test_valid_excerpt(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(module.validate_audio(self.wav(directory, 5))[1], 5)

    def test_short_or_long_excerpt_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for duration in (1, 31):
                with self.assertRaises(ValueError):
                    module.validate_audio(self.wav(directory, duration))

    def test_recording_json_is_not_audio(self):
        with self.assertRaises(ValueError):
            module.validate_audio(Path(__file__).parents[1] / "package.json")

    def test_license_gate_before_runtime_or_audio_access(self):
        with self.assertRaisesRegex(ValueError, "research terms"):
            module.evaluate("missing.wav", "missing-model")

    def test_busy_desktop_is_not_overcommitted(self):
        with self.assertRaisesRegex(RuntimeError, "Insufficient free memory"):
            module.memory_budget({"freeBytes": 2 * 1024**3, "availableRamBytes": 4 * 1024**3})

    def test_offload_reserves_memory_for_the_desktop(self):
        budget = module.memory_budget({"freeBytes": 6 * 1024**3, "availableRamBytes": 24 * 1024**3})
        self.assertEqual(budget[0], 5 * 1024**3)
        self.assertEqual(budget["cpu"], 20 * 1024**3)

    def test_4bit_quantized_gpu_budget_is_realistic_not_full_precision(self):
        # The old gate required 20 GiB free GPU, sized for the UNQUANTIZED 16.5 GB model --
        # flamingo_server.py actually loads it in 4-bit whenever CUDA is available, so this must
        # not raise on a machine with only ~5-6 GiB free (the real quantized footprint).
        budget = module.memory_budget({"freeBytes": int(5.3 * 1024**3), "availableRamBytes": 4 * 1024**3})
        self.assertGreater(budget[0], 0)


if __name__ == "__main__":
    unittest.main()
