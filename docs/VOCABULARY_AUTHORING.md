# Offline Vocabulary Authoring

## Why this exists

The local engine can combine and select existing vocabulary in many ways, but it cannot invent
new WORDS -- the open layer (mood/association) was silent far more often than it was wrong,
because the hand-authored vocabulary pool was small. `scripts/author-vocabulary.mjs` uses an LLM
offline, in bulk, to author candidate vocabulary against the axis space
(`js/semantic/aestheticAxisEngine.js`, `data/aestheticAxes.json`) and against genre labels the
knowledge base doesn't cover yet (`data/genreContextKnowledge.json`). The runtime never calls an
LLM to invent vocabulary on the fly for this purpose -- it only ever selects from what has already
been authored, reviewed, and merged.

**This script is never imported by the runtime path.** It is not referenced from `server.js`,
`index.html`, or any file loaded by either. It is a developer tool, run by hand, from the command
line.

## What it produces

Two independent modes, selected with `--target`:

- `--target vocabulary` (default) authors open-layer aesthetic/impression phrases keyed to
  combinations of axes, in this exact shape:
  ```json
  { "text": "과거의 향기", "layer": "AESTHETIC", "conceptKey": "nostalgia.scent",
    "region": [{ "axis": "nostalgia", "band": "high", "min": 0.55 },
               { "axis": "decay", "band": "mid", "min": 0.4, "max": 0.68 }],
    "minAxes": 2, "register": "impression", "relatedKeys": ["nostalgia.revival"],
    "clicheRisk": 0.2 }
  ```
  Output: `data/aestheticVocabulary.generated.json`.
  **The LLM never picks an absolute number.** It picks a percentile `band`
  (`very_high`/`high`/`mid`/`low`) per axis condition -- real measured axis values cluster well
  below the 0.55-0.8 range early hand-authored regions used (see `data/axisDistribution.json`,
  built by `scripts/replay.cjs` from real captured sessions), so asking for an absolute threshold
  reliably produces vocabulary that never fires. The script converts each band to an actual
  `{min, max}` against that file's percentiles right after generation (`very_high`&nbsp;→&nbsp;≥p90,
  `high`&nbsp;→&nbsp;≥p75, `mid`&nbsp;→&nbsp;p40-p70, `low`&nbsp;→&nbsp;≤p25) and keeps the original
  band label on the same condition, so a later recalibration (new `axisDistribution.json`) can
  re-derive the numbers without re-authoring the text.
- `--target genre-context` authors style-association candidates, in the SAME shape
  `data/genreContextKnowledge.json`'s `genres[label].candidates` already uses
  (`{text, category, requires: [{path, min}]}`), for genre labels the real 400-class Discogs-EffNet
  model can produce but the knowledge base doesn't cover yet. Output:
  `data/genreContextCandidates.generated.json`.

Both are **review files**. Neither is read by the runtime. Nothing promotes them automatically.

## Usage

```bash
node scripts/author-vocabulary.mjs --target vocabulary --limit 20
node scripts/author-vocabulary.mjs --target genre-context --limit 15
```

- `--limit N`: total entries to request (vocabulary mode spreads this across seed axis-territories,
  `--terms-per-region` each; genre-context mode covers up to N uncovered genre labels).
- `--terms-per-region N`: entries requested per LLM call (default 6/3).
- `--model NAME`: override the model (defaults to `OPENAI_LANGUAGE_MODEL`/`OPENAI_MODEL`/`gpt-5.6-sol`).
- `--out PATH`: override the output file path.

Requires `OPENAI_API_KEY` in `.env`. **Always run with a small `--limit` first.** The full
1,000-2,000-term target scale in the reform request is a real cost decision -- run it in batches
and check the output between runs, not as one large unattended call.

## Review workflow (required, no shortcuts)

1. **Generate.** Run the script with a bounded `--limit`. It prints its own validation issues
   (unknown axis, duplicate conceptKey, failed `safeText()`, dangling `relatedKeys`, an
   out-of-range path) inline -- fix or discard flagged entries before moving on.
2. **Human review.** Read every entry. The validator only checks STRUCTURE, not QUALITY -- it
   will happily pass a `requires` condition that is technically reachable but nearly useless
   (e.g. `measurements.bpm >= 1`, seen in an actual sample run: technically valid, practically a
   no-op gate). Look specifically for:
   - Does the phrase actually read as an impression, not a claim of fact?
   - Is `clicheRisk` honest, or does the phrase read as generic AI-poetry regardless of the score?
   - Do the `requires`/`region` thresholds actually discriminate, or would they pass on almost
     any track?
   - Any residual risk of song/artist identification, invented historical claims, or unobserved
     narrative that slipped past the instructions.
3. **Merge.** Hand-copy the entries you keep into the runtime files:
   - Vocabulary entries: `data/aestheticRegions.json`'s `entries` array (drop `conceptKey`/
     `relatedKeys`/`clicheRisk`/`register` if you don't need them there yet, or extend that file's
     schema deliberately if you do -- don't smuggle new fields in silently).
   - Genre-context entries: `data/genreContextKnowledge.json`'s matching `genres[label].candidates`
     array (create the genre entry if the label is new).
4. **Freeze.** Run `npm run check` (which runs `scripts/validate-knowledge.cjs`). Delete or archive
   the `*.generated.json` review file once its content has been merged or rejected -- it should
   not linger as a second, drifting copy of runtime vocabulary.

There is no automatic path from step 1 to step 3. A human decides what ships, every time.

## Validating a generated batch by hand

```bash
node -e "
const Validator = require('./js/semantic/knowledgeConsistencyValidator');
const axes = require('./data/aestheticAxes.json');
const generated = require('./data/aestheticVocabulary.generated.json');
console.log(Validator.validateGeneratedVocabulary(generated, Object.keys(axes.axes)));
"
```

`scripts/knowledge-coverage.cjs` also reports axis-space coverage
(`js/semantic/languageDiversityMetrics.js`'s `axisCoverage()`) against whatever is currently in
`data/aestheticRegions.json` -- use it to see which (axis, low/mid/high) cells still have zero
vocabulary before choosing which seed regions to author next.

## Automated batch review (Gate 4)

`scripts/analyze-vocabulary-batch.cjs` runs the four numeric checks a real review round needs
before reading 100 lines by hand is worth doing:

```bash
node scripts/analyze-vocabulary-batch.cjs data/aestheticVocabulary.generated.json --replay test/fixtures/replays
```

- **conceptKeyRatio** (target ≥ 0.7): unique `conceptKey` count / total entries. Below this, most of
  the batch is synonym inflation of a few real concepts.
- **axisBias** (target: no axis > 30% of all region conditions): a skewed batch means the prompt (or
  the seed-region list) is leaning on whichever axes Korean already has rich vocabulary for
  (nostalgia/warmth/intimacy) and neglecting the rest (drive/tension/weight/density/clarity).
- **gateWidth** (target: ≤ 30% single-axis entries): a 1-axis region fires on almost any track: not
  discriminating anything. Reject-worthy on sight regardless of how good the text reads.
- **universalFireTest** (target: 0 entries): needs `--replay <dir>` pointed at real recordings (or,
  for a trial run, synthetic ones) -- computes each track's median axis vector and flags any entry
  whose gate is satisfied by literally every track. This is the automatable half of "아무 음악
  테스트"; skipped with a clear `"SKIPPED"` marker when no `--replay` dir is given, never silently
  treated as passing.
- **structural**: re-runs `validateGeneratedVocabulary()` (unknown axis, dangling `relatedKeys`,
  failed `safeText()`, etc.) so a review pass never has to run two separate commands.

None of these auto-discard anything. **Voice consistency and Korean naturalness are not
automated** -- read the batch yourself; the report's job is to make that read fast, not replace it.

## Trial log

**Round 1** (percentile-band schema, `--limit 100`, `--terms-per-region 5`, 20 seed regions):
axis percentiles came from `data/axisDistribution.json`, itself built from a **synthetic**
replay run (14 `test/fixtures/languageProfiles.js` fixtures, jittered ±6% per frame, 24 frames
each) -- STEP 3's real-recording gate was not yet closed when this round ran, so these bands are a
provisional starting point, not calibrated ground truth. Automated results: conceptKeyRatio 1.0
(100/100 unique), axisBias PASS (max share ~12%, though `syncopation`/`density`/`clarity` got 0%
representation simply because `--limit 100` only reached the first 20 of 23 seed regions -- the
three newest regions covering those axes sit at the end of the list), gateWidth PASS (0%
single-axis, 90 two-axis + 10 three-axis), universalFireTest PASS (0 of 100 fire on every synthetic
track), structural PASS (0 issues). Manual spot-read of all 100: strong overall, two findings --
(1) five separate "Y2K ␣X" entries (인터페이스/터보/드리프트/경고창/질주) risk reading as one
template with the filler word swapped, distinct `conceptKey`s notwithstanding; (2) one entry
("천장이 내려온다") is a full sentence, breaking the noun-phrase register every other entry uses.
Neither violates a hard rule (no identification, no unobserved-person narrative); both are
prompt-tuning notes for a possible round 2, not blockers. No second round was run this session --
the user asked to trial the pipeline with synthetic data only, not iterate to convergence.
