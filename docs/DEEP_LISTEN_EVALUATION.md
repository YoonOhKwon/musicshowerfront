# Optional direct-audio description evaluation

This is a research CLI, not a deployed browser feature. The normal Music Shower
audio, words, server and LLM path are unchanged. No upload endpoint is exposed.

## Verified environment

The inspected GPU is an RTX 4070 SUPER with 12,282 MiB total VRAM; about 5,321 MiB
was free at inspection. Free memory is transient, not a model capacity guarantee.
The bundled Python runtime is unchanged. A separate `.research-venv` now contains
the research dependencies following the user's confirmation of non-commercial
research use. Model weights and real inference must still be verified separately.

The desktop had only about 3.8 GiB free host RAM during setup. The evaluator now
requires either 20 GiB free GPU memory or 22 GiB free host RAM before model loading.
These are deliberately conservative safety gates, not measured model minimums.
Auto placement reserves 2 GiB GPU and 4 GiB host memory. It does not terminate apps.

Explicit, resumable model setup is provided separately:

```text
.research-venv/Scripts/python.exe scripts/setup-deep-listen.py --download-model --accept-research-license
```

This resolves the public repository revision and downloads about 16.5 GB of weights
plus processor/tokenizer files to ignored `models/research/music-flamingo`. No user
audio is transmitted. The offline evaluator itself still never downloads anything.

## Model and restrictions

Candidate: `nvidia/music-flamingo-2601-hf`.
The official card provides `MusicFlamingoForConditionalGeneration` with
`AutoProcessor.apply_chat_template` and states non-commercial research use only:
https://huggingface.co/nvidia/music-flamingo-2601-hf

This candidate must not silently become the product's production dependency.
Commercial deployment needs a separately licensed solution or permission.
Install optional dependencies in a separate research environment only after
deciding the license, model storage and hardware budget. Do not modify the bundled
desktop Python environment to install this stack.

## Commands (use the Python executable of your research environment)

```text
python -B scripts/deep-listen.py --doctor
python -B scripts/deep-listen.py --audio "clip.wav" --model-dir "local-model-directory" --accept-research-license
python -B test/deep_listen_test.py
```

The evaluator requires a local 5–30 second, mono/stereo 16-bit PCM WAV under 24 MiB,
and an existing local model directory. It disables Hub downloads, telemetry and
custom remote model code. No model is installed automatically. A semantic recording
JSON cannot substitute for audio. An unsupported runtime returns `unavailable`.

Output is JSON on stdout: caption, audio SHA-256, duration, generated token count,
load/inference times, peak allocated CUDA memory and an empty human-review form.
It does not write a report file or feed its claims into semantic state. The hash
links repeated runs of the same excerpt without publishing the local filename.

## Acceptance experiment before runtime integration

Use identical excerpts and a frozen descriptor snapshot. Compare:
1. existing descriptor-only brief;
2. direct-audio caption;
3. human-reviewed combinations (never automatically trust model captions).

Rate audible correctness, helpful specificity, unsupported historical/cultural
claims and important missed details. Log latency and memory per excerpt. Evaluate
multiple distinct tracks in each family, including unknown/non-Western music and
nearby confusing styles. Keep reviewed evaluation tracks separate from tuning.

Only after these results justify it should a separately scheduled, opt-in audio
service be integrated. It will need explicit audio-consent UX, per-window/session
IDs, stale-result rejection, request limits and independent evidence validation.
Current work establishes a runnable evaluation adapter and input/failure tests,
not equivalence to Suno or validated direct-audio model accuracy.
