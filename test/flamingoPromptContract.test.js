const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "../scripts/flamingo_server.py"), "utf8");

test("Flamingo prompt declares what every outgoing packet field means", () => {
  for (const field of ["audibleObservations", "signatureRelations", "genreHypotheses", "contextHypotheses",
    "aestheticConcepts", "impressions", "uncertainties"]) {
    assert.match(source, new RegExp(`WHAT YOU SEND TO MUSIC SHOWER[\\s\\S]+${field}`));
  }
  assert.match(source, /label MUST contain only a compact established or emerging genre/);
  assert.match(source, /Vocabulary is open/);
  assert.match(source, /up to the latest\s*\n?30 seconds/);
});

test("Flamingo terminal prints both raw and sanitized bounded output", () => {
  assert.match(source, /RAW MODEL RESPONSE \(max 6000 chars\)/);
  assert.match(source, /SANITIZED PACKET SENT TO MUSIC SHOWER \(max 6000 chars\)/);
  assert.match(source, /str\(raw_text or ""\)\[:6000\]/);
  assert.match(source, /json\.dumps\(packet, ensure_ascii=False, indent=2\)\[:6000\]/);
});

// Every inference in flamingo-server-v23.log ran at `generation budget=96` -- the floor of
// max(96, MODEL_MAX_LENGTH - input - 8) -- because MODEL_MAX_LENGTH was hardcoded to 1200, the
// AUDIO tower's max_position_embeddings, while real inputs were 1496-1725 tokens. The subtraction
// was negative on every request, the clamp hid it, and the model never generated past its first
// field. These lock down the three properties that made that failure both possible and invisible.

test("the generation budget is derived from the TEXT decoder's context, not a hardcoded constant", () => {
  assert.doesNotMatch(source, /^MODEL_MAX_LENGTH\s*=\s*\d+\s*$/m,
    "a literal context length cannot notice when it is smaller than the prompt it must hold");
  assert.match(source, /MODEL_MAX_LENGTH\s*=\s*resolve_text_context_length\(\)/);
  assert.match(source, /getattr\(model\.config,\s*"text_config"/,
    "the limit must be read off the text decoder, whose context is 32768, not the audio tower's 1200");
});

test("a generation budget that fell below the full allowance announces itself", () => {
  // Compared against the allowance actually requested, so a deliberately smaller first-impression
  // budget is not reported as an accident -- only a budget the context could not honour is.
  assert.match(source, /if generation_budget < allowance:/);
  assert.match(source, /WARNING: generation budget reduced from/,
    "a clamped budget silently truncates every packet -- it must never look like a clean run");
});

test("the packet schema is evidence-first and protects recording-specific relations", () => {
  const prompt = source.split('PROMPT = """')[1].split('""".strip()')[0];
  const order = [...prompt.matchAll(/^\s*\d+\.\s+"(\w+)"/gm)].map((match) => match[1]);
  assert.deepEqual(order, ["audibleObservations", "signatureRelations", "uncertainties",
    "genreHypotheses", "aestheticConcepts", "impressions", "contextHypotheses"],
    "audible evidence and uncertainty must precede interpretation");
});

test("Flamingo prompt contains no semantic examples that can leak into the listening report", () => {
  const prompt = source.split('PROMPT = """')[1].split('""".strip()')[0];
  for (const leakedExample of ["crisp quantized kick", "detuned saw pad", "Mallsoft",
    "Singeli", "Atmospheric Drum and Bass", "Liquid Drum and Bass", "Vaporwave",
    "Shibuya-kei", "melancholic propulsion", "restrained euphoria"]) {
    assert.equal(prompt.includes(leakedExample), false, `${leakedExample} must not prime the model`);
  }
  assert.match(prompt, /Prefer a well-supported broad identity to a weakly inferred narrow/);
  assert.match(prompt, /Zero labels is correct/);
});

test("classifier advisory has no path into Flamingo word-pool generation", () => {
  assert.doesNotMatch(source, /def parse_genre_advisory_header\(value\)/);
  assert.doesNotMatch(source, /LOCAL CLASSIFIER ADVISORY/);
  assert.doesNotMatch(source, /X-Music-Shower-Genre-Advisory/);
  assert.match(source, /"genreAdvisoryUsed": False/);
});

test("every Flamingo word-pool pass is independent and blind", () => {
  assert.match(source, /def build_blind_listen_prompt\(active_audio_ms=0, first_impression=False\)/);
  assert.match(source, /LISTENING STAGE: INDEPENDENT BLIND LISTEN/);
  assert.match(source, /independent_listen = True/);
  assert.doesNotMatch(source, /independent_listen = segment_number/);
  assert.match(source, /"listeningMode": "independent"/);
});

test("FACT prompt distinguishes a rhythmic pattern from an uncertain sound source", () => {
  assert.match(source, /Keep rhythm observations source-neutral/);
  assert.match(source, /audible traits discriminate it from confusable/);
  assert.match(source, /record the ambiguity in uncertainties/);
});

test("prior-segment semantic memory is absent from generation", () => {
  assert.doesNotMatch(source, /def compact_packet/);
  assert.doesNotMatch(source, /SESSION_MEMORY/);
  assert.doesNotMatch(source, /ALREADY REPORTED/);
});

test("broken-JSON recovery reads text VALUES, never the JSON key names", () => {
  const recovery = source.split("# 3. Regex key extraction")[1].split("# 4.")[0];
  const bareQuotedString = String.raw`re.findall(r'"([^"\n]`;
  assert.ok(!recovery.includes(bareQuotedString),
    'matching every quoted string harvested "text", "category" and "rhythm" as concepts');
  const textValue = String.raw`re.findall(r'"text"\s*:\s*"([^"\n]{2,120})"'`;
  const occurrences = recovery.split(textValue).length - 1;
  assert.equal(occurrences, 5,
    'audible, signature, context, aesthetic and impression recovery must all read the "text" value');
});

test("a concept too long to keep is cut between words, never through one", () => {
  assert.doesNotMatch(source, /return clean\[:60\]/,
    "blunt slicing turned '...punchy kick and tight hi-hat' into '...punchy kick an'");
  assert.match(source, /def trim_to_word_boundary\(text, limit\)/);
  assert.match(source, /return trim_to_word_boundary\(clean, CONCEPT_CHAR_LIMIT\)/);
});

// From the first successful run: the model writes "reasoning", files a context hypothesis under
// "category" with no "text", and copies the shape of whatever the prior-segment summary looks like.
test("hint extraction accepts the key the checkpoint actually writes", () => {
  assert.match(source, /for key in \("reasoningHints", "reasoning"/,
    'reading only "reasoningHints" discarded 100% of the hints the model generated');
});

test("a context hypothesis filed under category with no text is still recovered", () => {
  assert.match(source, /if not clean_value\(raw\) and category\.lower\(\) not in CONTEXT_CATEGORIES:/,
    "the whole CONTEXT layer used to vanish on that shape without a word in the log");
});

test("no prior semantic summary can anchor the next audio window", () => {
  assert.doesNotMatch(source, /ALREADY REPORTED|prior hypothesis data|Spend this segment on angles/);
  assert.match(source, /Continuity lives in the evidence registry/);
});

test("sanitizing that loses items says so", () => {
  assert.match(source, /NOTE: fewer items than the model sent/,
    "a layer that arrived and then vanished looked exactly like one the model never wrote");
});

// The checkpoint answered one capture with a Python object literal -- {'text': 'x'} -- carrying
// 5 aesthetics, 5 impressions and 4 genres. json.loads rejects single quotes and every recovery
// regex looks for double ones, so the entire packet was discarded and an empty result shipped.
test("a packet written as a Python object literal is parsed, not discarded", () => {
  assert.match(source, /^import ast$/m);
  assert.match(source, /def load_object_literal\(text\)/);
  assert.match(source, /ast\.literal_eval\(text\)/);
  assert.doesNotMatch(source, /parsed = json\.loads\(json_candidate\)/,
    "the first parse tier must accept both quoting styles, not JSON alone");
  const repair = source.split("# 2. Try partial repair")[1].split("# 3. Regex")[0];
  assert.match(repair, /load_object_literal\(fixed\)/,
    "truncation repair must also accept a Python literal -- truncated packets are the common case");
});

test("truncation repair recognises every layer that may be emitted before the tail", () => {
  const repair = source.split("# 2. Try partial repair")[1].split("# 3. Regex")[0];
  for (const field of ["audibleObservations", "signatureRelations", "aestheticConcepts", "impressions"]) {
    assert.ok(repair.includes(field),
      `${field} can appear in a truncated packet and must still count as a packet`);
  }
});

test("a client that hung up mid-inference does not turn cancellation into a crash", () => {
  assert.match(source, /def report_error\(self, code, message\)/);
  assert.match(source, /ConnectionAbortedError/,
    "the 409 path runs precisely when the browser aborted the request, so the socket is usually gone");
  assert.doesNotMatch(source, /self\.send_error\(409/,
    "409 must go through the tolerant path");
});

// Nothing Flamingo-derived could reach the screen for ~90s: a 30s wait for the first capture on
// top of ~50s of inference. The encoder treats 30s as a ceiling rather than a requirement, so the
// first capture is now a shallower opening listen taken much sooner.
test("the first capture of a track is a shallower listen taken sooner", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../js/main.js"), "utf8");
  assert.match(main, /const DEEP_LISTEN_FIRST_CAPTURE_SECONDS = (\d+);/);
  const first = Number(main.match(/const DEEP_LISTEN_FIRST_CAPTURE_SECONDS = (\d+);/)[1]);
  const chunk = Number(main.match(/const DEEP_LISTEN_CHUNK_SECONDS = (\d+);/)[1]);
  assert.ok(first < chunk, `first capture (${first}s) must not wait a full window (${chunk}s)`);
  assert.ok(first >= 5, "the capture path itself refuses anything under 5s of audio");
  assert.match(main, /X-Music-Shower-Listen-Depth/);
  assert.match(source, /FIRST_IMPRESSION_TOKENS = \d+/);
  const cap = Number(source.match(/FIRST_IMPRESSION_TOKENS = (\d+)/)[1]);
  const full = Number(source.match(/MAX_GENERATION_TOKENS = (\d+)/)[1]);
  assert.ok(cap < full, "a first impression must cost fewer generated tokens than the full pass");
});

test("a first impression spends its small budget on evidence-first provisional listening", () => {
  const prompt = source.split('FIRST_IMPRESSION_PROMPT = """')[1].split('""".strip()')[0];
  const order = [...prompt.matchAll(/^\s*\d+\.\s+"(\w+)"/gm)].map((match) => match[1]);
  assert.deepEqual(order, ["audibleObservations", "signatureRelations", "uncertainties",
    "genreHypotheses", "aestheticConcepts", "impressions"],
    "the opening listen must still hear before it interprets");
  assert.match(prompt, /provisional/);
  assert.match(prompt, /must not lock track-level identity/);
  assert.match(prompt, /Do not add reasoning/);
  assert.match(prompt, /lower\s*\n?confidence/);
});

test("sanitizer deduplicates before field caps and quarantines schema mismatches", () => {
  const sanitizer = source.split("def sanitize_packet")[1].split("\ndef ")[0];
  assert.match(sanitizer, /def dedupe\(items/);
  assert.match(sanitizer, /balanced_audible\(dedupe\(audible_candidates\), 5\)/);
  assert.doesNotMatch(sanitizer, /parsed\.get\("audibleObservations"\).*\[:5\]/);
  assert.match(sanitizer, /unrecognized audible category/);
  assert.match(sanitizer, /misfiled genre claim/);
  assert.match(sanitizer, /packetDiagnostics/);
});

test("unstructured model prose is quarantined instead of mapped by genre or mood keywords", () => {
  const fallback = source.split("# 4. An unstructured response is quarantined")[1];
  assert.match(fallback, /unstructured model response quarantined/);
  assert.doesNotMatch(fallback, /\["genre", "subgenre", "pop"/);
});

test("only the first capture of a track is shallow", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../js/main.js"), "utf8");
  assert.match(main, /const firstImpression = !deepListenState\.lastTriggeredAt;/,
    "depth is decided by whether this track has been captured before, not by a timer");
});

test("a slow Flamingo inference preserves one scheduled pending audio window", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../js/main.js"), "utf8");
  assert.match(main, /pendingCapture:\s*null/);
  assert.match(main, /else if \(!deepListenState\.pendingCapture\)/,
    "the queue must be bounded to one waiting window");
  assert.match(main, /deepListenState\.pendingCapture = capture/);
  assert.match(main, /queueMicrotask\(\(\) => triggerDeepAnalysisUpload\(\{ capture: pending \}\)\)/,
    "the preserved window must start when the active inference releases the GPU slot");
});

// Naming example genres in the prompt narrows what comes back: an open-vocabulary model reaches
// for the shapes it was just shown. The prompt may describe what a good label IS -- compact, a
// name rather than a sentence, as narrow as the audio supports -- but must not exhibit specimens.
test("the prompt shows no specimen genre names to anchor the vocabulary", () => {
  const prompt = source.split('PROMPT = """')[1].split('""".strip()')[0];
  const suffix = source.includes('FIRST_IMPRESSION_SUFFIX = """')
    ? source.split('FIRST_IMPRESSION_SUFFIX = """')[1].split('"""')[0] : "";
  const classes = require("../models/music-shower/assets/discogs-effnet-bsdynamic-1.json").classes;
  // Multi-word style names only: single common words ("Pop", "House", "Modern") occur in ordinary
  // prose, while "Deep House" or "Drum and Bass" in a prompt can only be an example.
  const specimens = [...new Set(classes.map((c) => c.split("---").pop()))]
    .filter((name) => name.trim().includes(" "));
  const haystack = `${prompt}\n${suffix}`.toLowerCase();
  const offenders = specimens.filter((name) => haystack.includes(name.toLowerCase()));
  assert.deepEqual([...new Set(offenders)], [],
    "these genre names appear in the prompt and will bias what the model is willing to name");
});

test("the prompt keeps saying the vocabulary is open and unbounded", () => {
  const prompt = source.split('PROMPT = """')[1].split('""".strip()')[0];
  assert.match(prompt, /Vocabulary is open/);
  assert.match(prompt, /do not restrict labels to a familiar taxonomy/i,
    "absence from any local list is never grounds for refusing a name");
});
