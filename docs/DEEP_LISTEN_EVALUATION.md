# Direct-audio description (Music Flamingo)

Live-wired, not human-review-gated: js/main.js captures 30s of the actual listening
session automatically (first at 30s of playback, then every 45s) and POSTs it to
`/api/deep-analysis`. That endpoint (server.js) never calls an LLM to invent cultural
claims and never hands back display-ready words directly -- it runs the caption
through `lib/directAudioReview.js`'s `reviewCaption()` (classifies each sentence
musical / cultural-or-historical / impression) and `toObservations()` (turns the
keyword-anchored ones into candidate-shaped observations at reduced, differentiated
confidence: musical 0.6, cultural/aesthetic 0.45). `js/main.js` feeds those into
`applyDirectAudioObservations()` (js/semantic/semanticEngine.js), which joins the SAME
evidence-fusion / temporal-stability pipeline (`evidenceFusionEngine.js` ->
`temporalEvidenceEngine.js`) every other evidence source (classifier, rhythm grammar,
production detectors) already goes through -- a caption earns its confidence there,
across repeated observations, exactly like a measured signal does; it is not handed a
shortcut to the screen. There is currently no consent UI beyond this document; treat
that as an open item if this ships to anyone other than the developer running it locally.

## Verified environment

The inspected GPU is an RTX 4070 SUPER with 12,282 MiB total VRAM; about 5,321 MiB
was free at inspection. Free memory is transient, not a model capacity guarantee.
The bundled Python runtime is unchanged. A separate `.research-venv` now contains
the research dependencies following the user's confirmation of non-commercial
research use. Model weights and real inference must still be verified separately.

`flamingo_server.py` loads the model 4-bit quantized (`BitsAndBytesConfig(load_in_4bit=True)`)
whenever a GPU is present -- roughly a 4x reduction from the 16.5 GB full-precision
weights. `scripts/deep-listen.py`'s memory gate is sized for that (~5 GiB free GPU),
not the old unquantized figure, which no run on this codepath ever actually needed;
the desktop's ~5.3 GiB free GPU sits right at that boundary -- a real one, not a
guarantee, and worth revisiting from measurement after a first real run. The
CPU-only fallback path does not quantize (bitsandbytes 4-bit is CUDA-only) and still
needs the larger ~22 GiB free host RAM figure the gate also checks.

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

## Evaluating quality now that this is live

Runtime integration has happened (see the top of this doc) -- this section is about
judging and tuning it, not gating whether it happens. Use identical excerpts and a
frozen descriptor snapshot to compare:
1. existing descriptor-only brief (`lib/musicDescription.js`);
2. direct-audio caption (this feature);
3. what actually reaches the screen after evidenceFusionEngine/temporalEvidenceEngine/
   critic (the real end-to-end result, not the raw caption).

Rate audible correctness, helpful specificity, unsupported historical/cultural
claims and important missed details. Log latency and memory per excerpt. Evaluate
multiple distinct tracks in each family, including unknown/non-Western music and
nearby confusing styles. Keep reviewed evaluation tracks separate from tuning.

Known open items, not yet built: explicit audio-consent UX (nothing tells the
listener their audio is being captured), per-window/session IDs, stale-result
rejection, and a request-rate limit on `/api/deep-analysis`. Current work
establishes the real evidence-fusion wiring and a runnable offline evaluation
adapter, not equivalence to Suno or a validated accuracy figure for the underlying
model.
