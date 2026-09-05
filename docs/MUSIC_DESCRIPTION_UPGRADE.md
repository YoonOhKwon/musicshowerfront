# Music description upgrade

## Applied

The language endpoint now builds a deterministic listening brief from its sanitized
snapshot before the existing LLM request. It groups genre hypotheses, trusted tempo,
beat-grid-supported rhythm, instrument presence, texture and production candidates.
Each observation retains source paths. Complementary observations may be composed
without counting them as independent new evidence. Missing facets stay missing.

The existing phrase schema, local critic, cooldown, output budget, provider and
DSP fallback remain in place. The brief is not a direct audio model, cultural
retriever or a Suno-equivalent classifier. No additional model or API call is added.
Its synopsis is diagnostic input, not an extra paragraph imposed on the visual UI.

Full requests include the brief alongside the sanitized snapshot. Compact delta
requests preserve their existing payload and do not rebuild the portrait. Full
request input size increases by the brief; no input-token saving or paid generation
quality gain is claimed. Measure usage and accepted novel concepts before changing
scheduling or budgets.

## Evaluate without an API call

`node scripts/describe-recording.cjs <recording.json>`

The report samples the brief every 15 seconds and reports construction time and
maximum character count. These are descriptor-based summaries, not listening
ground truth, actual FloatingWord history or measured LLM output quality.

## Next experiment

Compare unchanged baseline and brief-enabled generation on the same audio excerpts.
Rate factual correctness, useful musical relationships, cultural overreach,
accepted distinct concepts, latency and actual usage. Only then add an optional
audio-language model and sourced cultural retrieval. Audio upload, model hosting,
hardware requirements and licenses must be evaluated explicitly; none is silently
enabled in this change. Fix genre transition and replay parity separately before
using replay results as end-to-end accuracy scores.

References inspected:
- https://help.suno.com/en/articles/2477633 (audio upload workflow, not an exposed analysis architecture)
- https://developers.openai.com/api/docs/guides/structured-outputs (existing response contract retained)
