"""Explicit research setup; downloads public model weights, never uploads audio."""
import argparse
import json
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
MODEL = "nvidia/music-flamingo-2601-hf"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download-model", action="store_true")
    parser.add_argument("--accept-research-license", action="store_true")
    args = parser.parse_args()
    if not args.download_model or not args.accept_research_license:
        parser.error("Explicit --download-model --accept-research-license required")
    os.environ["HF_HOME"] = str(ROOT / ".research-cache" / "huggingface")
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    from huggingface_hub import HfApi, snapshot_download
    destination = ROOT / "models" / "research" / "music-flamingo"
    info = HfApi().model_info(MODEL, files_metadata=True, token=False)
    patterns = ["*.json", "*.jinja", "*.safetensors", "README.md"]
    size = sum(item.size or 0 for item in info.siblings if item.rfilename.endswith(".safetensors"))
    if shutil.disk_usage(ROOT).free < size + 8 * 1024**3:
        raise RuntimeError("Insufficient free disk for model and research headroom")
    print(json.dumps({"model": MODEL, "revision": info.sha, "weightBytes": size,
                      "destination": str(destination), "audioUpload": False}), flush=True)
    snapshot_download(MODEL, revision=info.sha, local_dir=destination,
                      allow_patterns=patterns, token=False, max_workers=2)
    print(json.dumps({"status": "downloaded", "revision": info.sha}), flush=True)


if __name__ == "__main__":
    main()
