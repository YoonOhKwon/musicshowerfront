import http.server
import socketserver
import json
import tempfile
import os
from pathlib import Path
import time
import gc
import threading
import sys
import traceback

# Setup Flamingo environment
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

# Windows commonly starts this standalone process with a cp949 console. Flamingo's own
# diagnostics can contain a non-breaking hyphen or other Unicode, and a failed diagnostic must
# never replace the real inference exception with a second encoding exception.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    except (AttributeError, OSError):
        pass

def load_flamingo_env():
    # The Node server loads .env, but this standalone local model process is often launched
    # directly from PowerShell. Read only the three Flamingo tuning keys and never print or import
    # unrelated values such as API credentials. Explicit process environment always wins.
    env_path = Path(".env")
    if not env_path.is_file():
        return
    allowed = {"MUSIC_FLAMINGO_PLACEMENT", "MUSIC_FLAMINGO_4BIT_QUANT_TYPE", "MUSIC_FLAMINGO_EMPTY_CACHE"}
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            key = key.strip()
            if separator and key in allowed and key not in os.environ:
                os.environ[key] = value.strip().strip('"').strip("'")
    except OSError:
        pass

load_flamingo_env()

PORT = 5005

class ThreadedFlamingoServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True

class LoadingHandler(http.server.BaseHTTPRequestHandler):
    """Answers while the model loads, so callers see "loading" instead of a refused connection."""

    def _loading(self):
        try:
            length = min(int(self.headers.get('Content-Length', 0) or 0), 30 * 1024 * 1024)
            if length:
                self.rfile.read(length)
            body = json.dumps({"status": "loading"}).encode('utf-8')
            self.send_response(503)
            self.send_header('Content-type', 'application/json')
            self.send_header('Retry-After', '10')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError, ValueError):
            pass

    do_GET = _loading
    do_POST = _loading

    def log_message(self, format, *args):
        pass

# Bind before the multi-minute model load. The same server switches to FlamingoHandler once the
# model is ready: socketserver builds a new handler per request, so there is no port gap.
HTTPD = None
if __name__ == "__main__":
    HTTPD = ThreadedFlamingoServer(("", PORT), LoadingHandler)
    threading.Thread(target=HTTPD.serve_forever, name="flamingo-http", daemon=True).start()
    print(f"Flamingo server listening at port {PORT} (503 while the model loads)", flush=True)

print("Loading Music Flamingo model (This will take a minute)...")
import torch
from transformers import (
    AutoProcessor,
    MusicFlamingoForConditionalGeneration,
    StoppingCriteria,
    StoppingCriteriaList,
)

MODEL_DIR = "models/research/music-flamingo"
if not Path(MODEL_DIR).is_dir():
    raise RuntimeError(f"Model directory not found at {MODEL_DIR}")

processor = AutoProcessor.from_pretrained(MODEL_DIR, local_files_only=True, trust_remote_code=False)

from transformers import BitsAndBytesConfig
FOUR_BIT_QUANT_TYPE = os.environ.get("MUSIC_FLAMINGO_4BIT_QUANT_TYPE", "nf4").strip().lower()
if FOUR_BIT_QUANT_TYPE not in {"nf4", "fp4"}:
    raise RuntimeError("MUSIC_FLAMINGO_4BIT_QUANT_TYPE must be 'nf4' or 'fp4'")
PLACEMENT_MODE = os.environ.get("MUSIC_FLAMINGO_PLACEMENT", "audio-priority").strip().lower()
if PLACEMENT_MODE not in {"audio-priority", "balanced", "auto"}:
    raise RuntimeError("MUSIC_FLAMINGO_PLACEMENT must be 'audio-priority', 'balanced', or 'auto'")

# A 12 GiB card cannot hold this ~15.4 GiB BF16 checkpoint in full precision. Audio-priority
# spends precision where the sound is interpreted (Whisper tower + multimodal projector), keeps
# the large Qwen decoder in NF4, and moves the one-off token embedding lookup to system RAM. The
# embedding transfer is small compared with putting recurrent decoder layers on CPU, while the
# saved ~1 GiB of VRAM pays for the full-precision audio path.
AUDIO_PRIORITY_SKIP_MODULES = ["model.audio_tower", "model.multi_modal_projector", "lm_head"]
AUDIO_PRIORITY_DEVICE_MAP = {
    "model.audio_tower": 0,
    "model.multi_modal_projector": 0,
    "model.pos_emb": 0,
    "model.language_model.embed_tokens": "cpu",
    "model.language_model.layers": 0,
    "model.language_model.norm": 0,
    "model.language_model.rotary_emb": 0,
    "lm_head": 0,
}

def quantization_for(placement):
    if not torch.cuda.is_available():
        return None
    audio_priority = placement == "audio-priority"
    return BitsAndBytesConfig(
        load_in_4bit=True,
        # NF4 preserves normally-distributed pretrained weights more faithfully than FP4 while
        # keeping essentially the same footprint.
        bnb_4bit_quant_type=FOUR_BIT_QUANT_TYPE,
        bnb_4bit_use_double_quant=False,
        bnb_4bit_compute_dtype=torch.bfloat16,
        # Supplying an explicit skip list replaces Transformers' default lm_head exclusion, so
        # lm_head is deliberately included above. CPU offload is required for the embedding map.
        llm_int8_skip_modules=AUDIO_PRIORITY_SKIP_MODULES if audio_priority else None,
        llm_int8_enable_fp32_cpu_offload=audio_priority,
    )

def load_music_flamingo(placement):
    quantization = quantization_for(placement)
    device_map = (AUDIO_PRIORITY_DEVICE_MAP if placement == "audio-priority"
                  else ("auto" if torch.cuda.is_available() else "cpu"))
    loaded = MusicFlamingoForConditionalGeneration.from_pretrained(
        MODEL_DIR,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        device_map=device_map,
        quantization_config=quantization,
        local_files_only=True,
        trust_remote_code=False,
    )
    return loaded, quantization

if not torch.cuda.is_available():
    PLACEMENT_MODE = "cpu"

try:
    model, quantization_config = load_music_flamingo(PLACEMENT_MODE)
except Exception as placement_error:
    if PLACEMENT_MODE != "audio-priority":
        raise
    # A driver/runtime combination may reject a mixed device map. Release any partially loaded
    # tensors and preserve availability with the previous all-NF4 automatic placement.
    print(f"Audio-priority placement failed ({placement_error}); falling back to balanced NF4.")
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    PLACEMENT_MODE = "balanced"
    model, quantization_config = load_music_flamingo(PLACEMENT_MODE)

print(f"Music Flamingo quantization: {FOUR_BIT_QUANT_TYPE.upper()} 4-bit; placement: {PLACEMENT_MODE}"
      if quantization_config else "Music Flamingo quantization: disabled (CPU)")
model.eval()
if getattr(model, "hf_device_map", None):
    print("Music Flamingo device map: " + json.dumps(model.hf_device_map, ensure_ascii=False, sort_keys=True))
if torch.cuda.is_available():
    print(f"CUDA after load: allocated={torch.cuda.memory_allocated() / 2**30:.2f} GiB, "
          f"reserved={torch.cuda.memory_reserved() / 2**30:.2f} GiB")
print("Model loaded successfully. Starting server...")

import re
import ast

PROMPT = """
You are Music Flamingo, the blind direct-listening stage of Music Shower. Listen only to the
supplied audio, which contains up to the latest 30 seconds of audible sound. No classifier label,
previous interpretation, genre list, or developer vocabulary is available to you. Treat every
window as an independent observation; track-level continuity is assembled after generation.

WHAT YOU SEND TO MUSIC SHOWER
Send exactly one valid JSON object, writing its fields in exactly the order below. The order is
deliberate: generation can be cut off at any moment, so the fields that matter most are first.
Never reorder them, and never spend the early fields on material that belongs to a later one.

1. "audibleObservations": 2-5 directly audible observations. Each object has "id", "text",
   "category", "confidence", and "reasoningHints". category is one of rhythm, instrumentation,
   performance, arrangement, production, dynamics. These become strict FACT evidence about the
   current segment. Write short noun phrases at or under 8 words, never a sentence explaining what
   you heard. Keep rhythm observations source-neutral: describe pulse, subdivision, swing,
   syncopation, accent placement, or timing feel before claiming that a beat is electronic or
   acoustic. Identify an instrument only when its audible traits discriminate it from confusable
   sources; otherwise describe the role or timbre and record the ambiguity in uncertainties.
2. "signatureRelations": zero or more recording-specific relationships between audible elements.
   Each object has "id", "text", "supportRefs", "confidence", and "reasoningHints". supportRefs
   contains ids from audibleObservations. Report a relation only when the interaction itself is
   audible; do not merely list two features together.
3. "styleCues": zero to four audible stylistic signifiers. Each object has "id", "text",
   "confidence", and "supportRefs". A style cue is a sound source, production or sampling
   technique, performance convention, or recording/mixing trait that listeners associate with a
   particular period, place, scene, medium, or subculture. Name the audible trait itself in at or
   under 8 words, not the period or scene it suggests; the association is drawn later from these
   cues. Report only cues that are actually present and distinctive in this window.
4. "uncertainties": a list of short strings naming unresolved sources, conflicts, or boundaries.
5. "genreHypotheses": zero or more genre hypotheses. Each object has "label", "confidence",
   "supportRefs", and "reasoningHints". supportRefs contains ids from the evidence fields above.
   label MUST contain only a compact established or emerging genre, microgenre,
   or genre-like scene NAME.
   Never put a sentence, instrument description, mood description, or explanation in label.
   Vocabulary is open: do not restrict labels to a familiar taxonomy and do not invent a label
   merely to fill this field. Infer genre from the RELATIONSHIP among groove, harmony, bass motion,
   instrumentation, vocal phrasing, arrangement, and production character -- never from one synth,
   drum sound, or mood adjective. Prefer a well-supported broad identity to a weakly inferred narrow
   subtype. Add a narrower name only when multiple discriminating musical cues support that added
   specificity. Zero labels is correct when the current segment does not support a genre identity.
6. "aestheticConcepts": sensory, visual, material, or cultural aesthetic concepts when strongly
   supported by the audio. Each object has "text", "confidence", "supportRefs", and
   "reasoningHints". These become AESTHETIC evidence. Do not fill predetermined aesthetic
   dimensions and do not paraphrase one concept merely to increase the count.
   Consider named internet micro-aesthetics, including -core names, alongside sensory descriptions.
   When a name captures the combination of audible traits more precisely than generic adjectives,
   use that compact name as text in its usual spelling. Cite complementary audible supportRefs;
   one mood adjective alone is insufficient. These are aesthetic associations, not genre or origin
   facts. Do not invent names by attaching -core, list alternatives in one item, or fill a quota.
   Keep different supported interpretations distinct; no preferred name or fixed vocabulary.
7. "impressions": nuanced emotional listening impressions when strongly supported by the audio.
   Each object has "text", "confidence", "supportRefs", and "reasoningHints". These become subjective IMPRESSION
   evidence. Mixed or internally contrasting feelings are allowed when the audio supports them.
8. "contextHypotheses": scene, era, culture, or lineage hypotheses when the audio supports them.
   Each object has "text", "category", "confidence", "supportRefs", and "reasoningHints"; category is one of
   scene, era, culture, lineage. These become qualified CONTEXT evidence, not factual recording origin.
Use confidence from 0.0 to 1.0. Every "text" and "label" must stay at or under 8 words and under
60 characters -- a longer one is cut off mid-word and becomes unusable. reasoningHints must name
compact audible cues, not hidden chain of thought, and must stay at or under 6 words: a long hint
costs an entire concept elsewhere in this JSON. Omit a field only when the audio genuinely offers
nothing for it -- an honest low-confidence entry is better than an empty list, but an invented one
is worse than both. Complete one useful entry in every supported field before adding a second entry
to any field. Repetition and paraphrases do not add evidence. Output JSON only, with no Markdown
fences and no prose before or after it.
""".strip()

FIRST_IMPRESSION_PROMPT = """
You are Music Flamingo, the blind first-impression stage of Music Shower. Listen only to the
supplied opening audio. This is a short provisional observation, not a track identity.
Send exactly one compact JSON object with these fields in order:
1. "audibleObservations": 1-3 directly audible observations. Each object has "id", "text",
   "category", "confidence". category is one of rhythm, instrumentation, performance,
   arrangement, production, dynamics. Short noun phrases, at most 8 words.
2. "signatureRelations": 0-2 recording-specific relationships between those observations.
   Each object has "id", "text", "supportRefs", "confidence".
3. "uncertainties": short strings naming what this short listen cannot yet decide.
4. "genreHypotheses": 0-1 provisional genre names only if the audio already supports one.
   Each object has "label", "confidence", "supportRefs". Keep confidence low. Zero labels is
   correct. A first impression must not lock track-level identity.
5. "aestheticConcepts": 0-2 sensory concepts or named internet micro-aesthetics, including -core
   names, supported by complementary audible traits. Use the name's usual spelling as "text",
   with "confidence" and "supportRefs". A named aesthetic is a provisional association, not a
   genre fact. Do not invent suffix names or force an aesthetic onto an ambiguous short clip.
6. "impressions": 0-2 emotional impressions strongly supported by the sound.
Do not add reasoning, examples, or paraphrases. Vocabulary is open. Every phrase is at most 8
words and 60 characters. Use lower confidence to express the short listen's uncertainty. Output JSON only.
""".strip()

# Forensic listening: questions about how the recording was made. In the prompt probe
# (scripts/probe-flamingo-listening.cjs) the structured JSON listen never mentioned sampling on
# sample-based tracks, while these questions surfaced looped, pitch-shifted vocal samples from an
# older source -- and answered "no" to every question on a live brass recording. Keep the wording
# exactly as probed: adding an answer format ("start with yes, no or unsure, at most 20 words")
# collapsed nearly every answer to "No, all parts are performed or programmed", on the same windows
# where this wording found the samples. No genre, scene or example vocabulary appears here.
FORENSIC_PROMPT = """
Answer each question from what you hear in this audio. For every answer name the audible cue, and answer "unsure" when the audio does not decide it.
1. Is any part taken from a pre-existing recording (a sample or loop) rather than performed or programmed for this track? Which parts?
2. Are there vocals? If so, what language, and are they pitch-shifted, time-stretched, chopped, or filtered?
3. Does a phrase or bar repeat identically as a loop?
4. What processing is audible on the main loop or groove (for example filtering, sidechain pumping, saturation, bit reduction)?
5. What period does the recording and production character of any source material suggest, separately from the newer production around it?
""".strip()
FORENSIC_KEYS = ["sampled", "vocals", "loop", "processing", "sourcePeriod"]
# Polarity of a descriptive answer to the two yes/no production questions. These words restate the
# question itself (was material sampled/looped, does a bar repeat); they are not musical vocabulary.
FORENSIC_NEGATION = re.compile(r"\b(no|not|none|nothing|never|without)\b|n't\b|\bentirely (performed|programmed|original)", re.I)
FORENSIC_STATEMENTS = {
    "sampled": re.compile(r"\b(sampl\w*|loop\w*|pre-existing|taken from|lifted from)\b", re.I),
    "loop": re.compile(r"\b(repeat\w*|loop\w*)\b", re.I),
}

def parse_forensic_answers(text):
    """One {key, answer, cue} per numbered answer; answer is yes, no or unsure.

    A leading "Yes"/"No" decides the answer. The model often answers the sampling and loop
    questions descriptively instead ("The track is built around a looped vocal sample ..."); for
    those two yes/no questions the first sentence decides: a negation means no, a statement of the
    asked-about property means yes (marked inferred). Anything else, and the open questions 4 and 5,
    is "unsure": the text is kept as a cue but never counted as agreement.
    """
    answers = {}
    for line in str(text or "").splitlines():
        match = re.match(r'^\s*([1-5])\s*[.):-]\s*(.+)$', line)
        if not match:
            continue
        key = FORENSIC_KEYS[int(match.group(1)) - 1]
        if key in answers:
            continue
        body = re.sub(r'\s+', ' ', match.group(2)).strip()
        polarity = re.match(r'^(yes|no|unsure)\b[\s:,.;-]*', body, re.I)
        answer = polarity.group(1).lower() if polarity else "unsure"
        cue = trim_to_word_boundary(body[polarity.end():] if polarity else body, 160)
        entry = {"key": key, "answer": answer, "cue": cue}
        if not polarity and key in FORENSIC_STATEMENTS:
            first = re.split(r'(?<=[.;])\s', body, maxsplit=1)[0]
            if FORENSIC_NEGATION.search(first):
                entry.update(answer="no", inferred=True)
            elif FORENSIC_STATEMENTS[key].search(first):
                entry.update(answer="yes", inferred=True)
        answers[key] = entry
    return [answers[key] for key in FORENSIC_KEYS if key in answers]

def repetition_detected(text, tail_chars=900, min_unit=48, repeats=3):
    """True when generation has fallen into a loop.

    Digits are normalized first: the degenerate outputs seen so far repeat a shape with changing
    numbers ("0:00-0:02, 0:04-0:06, ...") or re-emit whole observation objects with new ids. JSON keys
    and punctuation are stripped too: a well-formed packet repeats `"category": ..., "confidence": 0.9`
    scaffolding on every item, which is not a loop.
    """
    content = re.sub(r'["\']\w+["\']\s*:', ' ', str(text or ''))
    content = re.sub(r'[\[\]{}"\',]+', ' ', content)
    tail = re.sub(r'\s+', ' ', re.sub(r'\d', '#', content))[-tail_chars:]
    for unit in range(min_unit, len(tail) // repeats + 1):
        if tail.count(tail[-unit:]) >= repeats:
            return True
    return False

def clean_identity(value):
    return re.sub(r'[^A-Za-z0-9_.:-]', '', str(value or ''))[:40]

def nonnegative_int(value):
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0

# Each call is deliberately memory-free. Continuity lives in the evidence registry, never in the
# model prompt, so an early interpretation cannot become evidence for itself on the next window.
def build_blind_listen_prompt(active_audio_ms=0, first_impression=False):
    listened_seconds = max(0, nonnegative_int(active_audio_ms) // 1000)
    stage = (
        f"\nLISTENING STAGE: INDEPENDENT BLIND LISTEN ({listened_seconds}s audible time). "
        "Judge only this audio window and preserve ambiguity where it does not discriminate among "
        "plausible readings."
    )
    return (FIRST_IMPRESSION_PROMPT if first_impression else PROMPT) + stage, 0

def log_model_exchange(raw_text, packet):
    # Make the model/server boundary inspectable without dumping audio or allowing an unexpectedly
    # malformed generation to flood the terminal indefinitely.
    print("\n[Music Flamingo] RAW MODEL RESPONSE (max 6000 chars)")
    print(str(raw_text or "")[:6000])
    print("[Music Flamingo] SANITIZED PACKET SENT TO MUSIC SHOWER (max 6000 chars)")
    print(json.dumps(packet, ensure_ascii=False, indent=2)[:6000])
    print("[Music Flamingo] END PACKET\n")

def clean_value(v):
    if not isinstance(v, str):
        return ""
    clean = re.sub(r'[{}\[\]"\'`:;,]', ' ', v).strip()
    clean = re.sub(r'\s+', ' ', clean)
    # The model sometimes bleeds a genreHypotheses-shaped "<confidence> reasoning: ..." string
    # into a plain array item (e.g. audibleObservations) instead of a short phrase. Strip that
    # leaked confidence+reasoning prefix before the keyword-prefix check below can see it.
    clean = re.sub(r'^\d+(?:\.\d+)?\s*reasoning(?:hints)?\b\s*', '', clean, flags=re.I).strip()
    if re.search(r'^(audibleObservations|signatureRelations|styleCues|genreHypotheses|contextHypotheses|aestheticConcepts|impressions|uncertainties|reasoning|confidence)', clean, re.I):
        return ""
    # A literal "reasoning"/"confidence" token surviving anywhere means this is still leaked
    # JSON scaffolding, not real observation text -- drop it rather than display it.
    if re.search(r'\b(reasoning(?:hints)?|confidence)\b', clean, re.I):
        return ""
    if len(clean) < 2:
        return ""
    return trim_to_word_boundary(clean, CONCEPT_CHAR_LIMIT)

CONCEPT_CHAR_LIMIT = 72

def trim_to_word_boundary(text, limit):
    """Cut between words, never through one.

    A blunt `text[:60]` turned a complete "...crisp, punchy kick and tight hi-hat pattern" into
    "...crisp punchy kick an" and shipped that to the UI as a concept. If it has to be shortened,
    end it on a word so what survives is still readable.
    """
    if len(text) <= limit:
        return text
    cut = text[:limit + 1]
    space = cut.rfind(" ")
    # Only honour the boundary if it leaves a usable phrase behind; a single very long token
    # would otherwise collapse to nothing.
    if space >= limit // 2:
        return cut[:space].rstrip(" -/,")
    return text[:limit].rstrip(" -/,")

GENRE_SENTENCE_VERB = re.compile(
    r'\b(is|are|was|were|has|have|had|provides?|features?|blends?|combines?|creates?|uses?|drives?|sounds?|feels?|evokes?|contains?|includes?|supports?|adds?|builds?|delivers?|showcases?|characteri[sz](e|es|ed)|dominat(e|es|ed))\b',
    re.I
)
GENRE_SENTENCE_OPENING = re.compile(r'^(a|an|the|this|that|these|those|it|there|track|song|music|recording|mix)\b', re.I)
KOREAN_SENTENCE_ENDING = re.compile(r'(한다|하다|이다|이며|있다|없다|느껴진다|들린다|돋보인다|제공한다|만든다|보여준다|이어진다|강조된다|형성한다)(고|며|지만|다)?$')
def plausible_genre_label(value):
    text = re.sub(r'\s+', ' ', str(value or '')).strip()
    words = re.findall(r"[A-Za-z0-9가-힣&/+.'’-]+", text)
    return bool(text and len(text) <= 64 and 0 < len(words) <= 7
        and not re.search(r'[.!?。！？]', text)
        and not GENRE_SENTENCE_OPENING.search(text)
        and not GENRE_SENTENCE_VERB.search(text)
        and not KOREAN_SENTENCE_ENDING.search(text))

FACT_CATEGORIES = {"rhythm", "instrumentation", "performance", "arrangement", "production", "dynamics"}
# Distinct audible observations kept per packet, after dedupe. At 5, a packet with eight distinct
# observations (rhythm, brass, harmony, bass, drums, production, tempo, dynamics) lost three of them.
AUDIBLE_OBSERVATION_LIMIT = 8
STYLE_CUE_LIMIT = 4
# The model names audible facets in its own words ("harmony", "bass motion", "drums"). Rejecting
# those discarded real observations -- a walking bass line or a chord progression -- purely over a
# field name. Route them onto the six display facets; the observation text itself is unchanged.
FACT_CATEGORY_ALIASES = {
    "instrument": "instrumentation", "instruments": "instrumentation", "timbre": "instrumentation",
    "bass": "instrumentation", "bassline": "instrumentation", "sample": "instrumentation",
    "vocal sample": "instrumentation", "vocal samples": "instrumentation", "vocal chop": "instrumentation",
    "synth": "instrumentation", "synths": "instrumentation", "keys": "instrumentation",
    "guitar": "instrumentation", "piano": "instrumentation", "brass": "instrumentation",
    "vocal": "performance", "vocals": "performance", "voice": "performance", "singing": "performance",
    "rap": "performance", "delivery": "performance", "phrasing": "performance",
    "tempo": "rhythm", "groove": "rhythm", "drums": "rhythm", "drum": "rhythm", "percussion": "rhythm",
    "beat": "rhythm", "meter": "rhythm", "pulse": "rhythm", "swing": "rhythm", "syncopation": "rhythm",
    "harmony": "arrangement", "harmonic": "arrangement", "melody": "arrangement", "melodic": "arrangement",
    "chords": "arrangement", "chord": "arrangement", "tonality": "arrangement", "key": "arrangement",
    "structure": "arrangement", "form": "arrangement", "texture": "arrangement", "layering": "arrangement",
    "motif": "arrangement", "counterpoint": "arrangement",
    "mix": "production", "mixing": "production", "space": "production", "spatial": "production",
    "stereo": "production", "reverb": "production", "effects": "production", "fx": "production",
    "sound design": "production", "tone": "production", "mastering": "production", "filter": "production",
    "energy": "dynamics", "intensity": "dynamics", "loudness": "dynamics", "build": "dynamics",
    "dynamic": "dynamics",
}

def fact_category(raw):
    """Canonical FACT facet for a model-written category, or "" when none applies."""
    name = re.sub(r'[^a-z ]+', ' ', str(raw or "").lower()).strip()
    name = re.sub(r'\s+', ' ', name)
    if name in FACT_CATEGORIES:
        return name
    if name in FACT_CATEGORY_ALIASES:
        return FACT_CATEGORY_ALIASES[name]
    # Multi-word names ("bass motion", "vocal performance"): the first recognised word decides.
    for word in name.split(" "):
        if word in FACT_CATEGORIES:
            return word
        if word in FACT_CATEGORY_ALIASES:
            return FACT_CATEGORY_ALIASES[word]
    return ""

def sanitize_packet(parsed):
    res = {
        "audibleObservations": [],
        "signatureRelations": [],
        "styleCues": [],
        "uncertainties": [],
        "genreHypotheses": [],
        "aestheticConcepts": [],
        "impressions": [],
        "contextHypotheses": []
    }
    quarantine = []
    raw_item_count = 0
    def confidence_of(item, default):
        if not isinstance(item, dict):
            return default
        try:
            return max(0.0, min(1.0, float(item.get("confidence", default))))
        except Exception:
            return default

    def reasoning_of(item):
        # The checkpoint writes "reasoning" no matter how firmly the prompt names the field, so
        # reading only "reasoningHints" discarded every hint the model produced -- 100% of them,
        # while still paying the generation tokens to produce them. Accept what it actually sends.
        if not isinstance(item, dict):
            return ""
        for key in ("reasoningHints", "reasoning", "reasoning_hints", "why", "cues"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                hint = clean_value(value)
                if hint:
                    return hint
        return ""

    def id_of(item):
        return clean_identity(item.get("id", "")) if isinstance(item, dict) else ""

    def support_refs_of(item):
        if not isinstance(item, dict) or not isinstance(item.get("supportRefs"), list):
            return []
        return [ref for ref in (clean_identity(value) for value in item["supportRefs"][:8]) if ref]

    def dedupe(items, text_field="text"):
        """Collapse literal repeats before applying field caps, retaining the strongest claim."""
        unique = {}
        order = []
        for item in items:
            text = item.get(text_field, "") if isinstance(item, dict) else ""
            key = re.sub(r'[^\w가-힣]+', '', str(text).casefold())
            if not key:
                continue
            if key not in unique:
                order.append(key)
                unique[key] = item
            elif float(item.get("confidence", 0)) > float(unique[key].get("confidence", 0)):
                unique[key] = item
        return [unique[key] for key in order]

    def balanced_audible(items, limit=AUDIBLE_OBSERVATION_LIMIT):
        """Do not let one verbose facet consume every FACT slot."""
        remaining = list(items)
        selected = []
        while remaining and len(selected) < limit:
            used_this_round = set()
            next_remaining = []
            for item in remaining:
                category = item.get("sourceCategory") or item.get("category", "")
                if category not in used_this_round and len(selected) < limit:
                    selected.append(item)
                    used_this_round.add(category)
                else:
                    next_remaining.append(item)
            remaining = next_remaining
        return selected

    audible_candidates = []
    incoming_audible = parsed.get("audibleObservations") or []
    raw_item_count += len(incoming_audible) if isinstance(incoming_audible, list) else 0
    for item in incoming_audible:
        raw = item if isinstance(item, str) else (item.get("text") if isinstance(item, dict) else "")
        c = clean_value(raw)
        if c:
            raw_category = str(item.get("category", "") if isinstance(item, dict) else "").strip().lower()
            category = fact_category(raw_category)
            if not category:
                quarantine.append("unrecognized audible category")
                continue
            candidate = {"text": c, "category": category,
                "confidence": confidence_of(item, 0.68), "reasoningHints": reasoning_of(item)}
            if raw_category and raw_category != category:
                candidate["sourceCategory"] = raw_category
            candidate["id"] = id_of(item) or f"f{len(audible_candidates) + 1}"
            audible_candidates.append(candidate)
    res["audibleObservations"] = balanced_audible(dedupe(audible_candidates), AUDIBLE_OBSERVATION_LIMIT)

    incoming_relations = parsed.get("signatureRelations") or []
    raw_item_count += len(incoming_relations) if isinstance(incoming_relations, list) else 0
    relation_candidates = []
    for item in incoming_relations:
        raw = item if isinstance(item, str) else (item.get("text") if isinstance(item, dict) else "")
        c = clean_value(raw)
        if not c:
            continue
        candidate = {"text": c, "confidence": confidence_of(item, 0.62),
            "reasoningHints": reasoning_of(item), "supportRefs": support_refs_of(item)}
        candidate["id"] = id_of(item) or f"s{len(relation_candidates) + 1}"
        relation_candidates.append(candidate)
    res["signatureRelations"] = dedupe(relation_candidates)[:4]

    # Audible period/scene signifiers. They are evidence for the later association stage, so they
    # keep ids and support refs but never carry the association itself.
    incoming_cues = parsed.get("styleCues") or []
    raw_item_count += len(incoming_cues) if isinstance(incoming_cues, list) else 0
    cue_candidates = []
    for item in incoming_cues if isinstance(incoming_cues, list) else []:
        raw = item if isinstance(item, str) else (item.get("text") if isinstance(item, dict) else "")
        c = clean_value(raw)
        if not c:
            continue
        candidate = {"text": c, "confidence": confidence_of(item, 0.6),
            "reasoningHints": reasoning_of(item), "supportRefs": support_refs_of(item)}
        candidate["id"] = id_of(item) or f"c{len(cue_candidates) + 1}"
        cue_candidates.append(candidate)
    res["styleCues"] = dedupe(cue_candidates)[:STYLE_CUE_LIMIT]

    incoming_genres = parsed.get("genreHypotheses") or []
    raw_item_count += len(incoming_genres) if isinstance(incoming_genres, list) else 0
    genre_candidates = []
    for item in incoming_genres:
        raw = item if isinstance(item, str) else (item.get("label") if isinstance(item, dict) else "")
        c = clean_value(raw)
        if c:
            confidence = confidence_of(item, 0.65)
            reasoning = reasoning_of(item)
            if plausible_genre_label(c):
                genre_item = {"label": c, "confidence": confidence,
                    "reasoningHints": reasoning, "supportRefs": support_refs_of(item)}
                if id_of(item):
                    genre_item["id"] = id_of(item)
                else:
                    genre_item["id"] = f"g{len(genre_candidates) + 1}"
                genre_candidates.append(genre_item)
            else:
                quarantine.append("misfiled genre claim")
    res["genreHypotheses"] = dedupe(genre_candidates, "label")[:4]

    CONTEXT_CATEGORIES = ["scene", "era", "culture", "lineage"]
    incoming_contexts = parsed.get("contextHypotheses") or []
    raw_item_count += len(incoming_contexts) if isinstance(incoming_contexts, list) else 0
    context_candidates = []
    for item in incoming_contexts:
        raw = item if isinstance(item, str) else (item.get("text") if isinstance(item, dict) else "")
        category = item.get("category", "scene") if isinstance(item, dict) else "scene"
        category = category if isinstance(category, str) else "scene"
        # The model sometimes files the hypothesis itself under "category" and omits "text"
        # entirely ({"category": "contemporary digital", "confidence": 0.8}). Reading only "text"
        # silently dropped the whole CONTEXT layer for that packet. If "category" holds something
        # that is plainly not one of the four enum values, it IS the hypothesis.
        if not clean_value(raw) and category.lower() not in CONTEXT_CATEGORIES:
            raw, category = category, "scene"
        c = clean_value(raw)
        if c:
            if category.lower() not in CONTEXT_CATEGORIES:
                quarantine.append("unrecognized context category")
                continue
            context_candidates.append({"text": c, "category": category.lower(),
                "confidence": confidence_of(item, 0.60), "reasoningHints": reasoning_of(item),
                "supportRefs": support_refs_of(item)})
    res["contextHypotheses"] = dedupe(context_candidates)[:4]

    incoming_aesthetics = parsed.get("aestheticConcepts") or []
    raw_item_count += len(incoming_aesthetics) if isinstance(incoming_aesthetics, list) else 0
    aesthetic_candidates = []
    for item in incoming_aesthetics:
        raw = item if isinstance(item, str) else (item.get("text") if isinstance(item, dict) else "")
        c = clean_value(raw)
        if c: aesthetic_candidates.append({"text": c, "confidence": confidence_of(item, 0.62),
            "reasoningHints": reasoning_of(item), "supportRefs": support_refs_of(item)})
    res["aestheticConcepts"] = dedupe(aesthetic_candidates)[:5]

    incoming_impressions = parsed.get("impressions") or []
    raw_item_count += len(incoming_impressions) if isinstance(incoming_impressions, list) else 0
    impression_candidates = []
    for item in incoming_impressions:
        raw = item if isinstance(item, str) else (item.get("text") if isinstance(item, dict) else "")
        c = clean_value(raw)
        if c: impression_candidates.append({"text": c, "confidence": confidence_of(item, 0.60),
            "reasoningHints": reasoning_of(item), "supportRefs": support_refs_of(item)})
    res["impressions"] = dedupe(impression_candidates)[:5]

    uncertainty_items = [clean_value(item if isinstance(item, str) else item.get("text", ""))
        for item in (parsed.get("uncertainties") or [])
        if clean_value(item if isinstance(item, str) else item.get("text", ""))]
    res["uncertainties"] = list(dict.fromkeys(uncertainty_items + quarantine))[:8]

    # Sanitizing is allowed to reject an item, but never quietly. A packet whose CONTEXT layer
    # arrived and then vanished into a field-name mismatch looked identical in the log to one the
    # model never wrote -- so the loss was invisible for as long as it kept happening.
    losses = []
    for key in ["aestheticConcepts", "impressions", "genreHypotheses", "contextHypotheses",
                "signatureRelations", "styleCues",
                "audibleObservations", "uncertainties"]:
        incoming = parsed.get(key)
        before = len(incoming) if isinstance(incoming, list) else 0
        after = len(res.get(key) or [])
        if before and after < before:
            losses.append(f"{key} {before}->{after}")
    if losses:
        # Some of this is legitimate re-routing (a misfiled genre becomes an impression), so this
        # reports a shrink, not necessarily a bug -- but a field going to 0 is worth looking at.
        print(f"[Music Flamingo] NOTE: fewer items than the model sent: {', '.join(losses)}",
              flush=True)

    accepted_count = sum(len(res[key]) for key in ["audibleObservations", "signatureRelations", "styleCues",
        "genreHypotheses", "contextHypotheses", "aestheticConcepts", "impressions"])
    res["packetDiagnostics"] = {
        "rawItemCount": raw_item_count,
        "acceptedConceptCount": accepted_count,
        "duplicateOrRejectedCount": max(0, raw_item_count - accepted_count),
        "quarantinedCount": len(quarantine),
        "fieldCounts": {key: len(res[key]) for key in ["audibleObservations", "signatureRelations", "styleCues",
            "genreHypotheses", "contextHypotheses", "aestheticConcepts", "impressions"]}
    }

    return res

def load_object_literal(text):
    """Parse one packet written either as JSON or as a Python object literal.

    Returns the dict, or None. ast.literal_eval accepts only literals -- dicts, lists, strings,
    numbers, True/False/None -- so nothing in the model's output can execute.
    """
    if not text:
        return None
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except Exception:
        pass
    try:
        value = ast.literal_eval(text)
    except Exception:
        return None
    return value if isinstance(value, dict) else None

def truncated_literal_repairs(text, attempts=200):
    """Repaired prefixes of a packet cut off mid-generation, longest first.

    Each candidate ends right after a complete string or closed bracket and then closes the
    still-open brackets in reverse nesting order. Appending every "]" before every "}" (the old
    repair) produced `]]}}` for `{"a": [{"b": [1`, so deeply nested packets lost every field.
    """
    stack = []
    quote = None
    escaped = False
    boundaries = []
    for index, char in enumerate(text):
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
                boundaries.append((index + 1, tuple(stack)))
            continue
        if char in "\"'":
            quote = char
        elif char in "[{":
            stack.append("]" if char == "[" else "}")
        elif char in "]}":
            if stack:
                stack.pop()
            boundaries.append((index + 1, tuple(stack)))
    for end, still_open in reversed(boundaries[-attempts:]):
        yield text[:end].rstrip(" ,:\n\r\t") + "".join(reversed(still_open))

def parse_deep_listen_packet(raw_text):
    text = raw_text.strip()
    json_candidate = text
    if "```json" in json_candidate:
        json_candidate = json_candidate.split("```json")[1].split("```")[0].strip()
    elif "```" in json_candidate:
        json_candidate = json_candidate.split("```")[1].split("```")[0].strip()

    # 1. Try standard JSON parse -- or a Python object literal, which is the same packet in a
    #    different quoting style. The checkpoint regularly answers with {'text': 'x'} instead of
    #    {"text": "x"}; json.loads rejects that outright, and every regex below looks for double
    #    quotes, so a complete and genuinely good packet was discarded down to an empty result.
    #    literal_eval evaluates data only -- no names, calls or operators -- so this reads the
    #    model's output, it does not run it.
    parsed = load_object_literal(json_candidate)
    if isinstance(parsed, dict):
        return sanitize_packet(parsed)

    # 2. Try partial repair (close unclosed brackets/braces from token truncation), in
    #    whichever of the two quoting styles the model used.
    for fixed in truncated_literal_repairs(json_candidate):
        parsed = load_object_literal(fixed)
        if isinstance(parsed, dict) and any(k in parsed for k in
                ["aestheticConcepts", "impressions", "genreHypotheses", "contextHypotheses",
                 "signatureRelations", "styleCues", "audibleObservations"]):
            return sanitize_packet(parsed)

    # 3. Regex key extraction from broken/truncated JSON
    audible = []
    relations = []
    cues = []
    genres = []
    contexts = []
    aesthetics = []
    impressions = []
    recovery_uncertainties = []

    aud_match = re.search(r'"audibleObservations"\s*:\s*\[(.*?)(\]|\Z)', text, re.DOTALL)
    if aud_match:
        # Match the "text" VALUES, the way every other block below does. Harvesting every quoted
        # string in the array swept up the JSON key names themselves, which is where the concepts
        # literally called "text", "category" and "rhythm" came from.
        for item in re.findall(r'"text"\s*:\s*"([^"\n]{2,120})"', aud_match.group(1)):
            c = clean_value(item)
            if c: audible.append({"text": c, "category": "production", "confidence": 0.65})

    relation_match = re.search(r'"signatureRelations"\s*:\s*\[(.*?)(\]|\Z)', text, re.DOTALL)
    if relation_match:
        for item in re.findall(r'"text"\s*:\s*"([^"\n]{2,120})"', relation_match.group(1)):
            c = clean_value(item)
            if c: relations.append({"text": c, "confidence": 0.55, "supportRefs": []})

    cue_match = re.search(r'"styleCues"\s*:\s*\[(.*?)(\]|\Z)', text, re.DOTALL)
    if cue_match:
        for item in re.findall(r'"text"\s*:\s*"([^"\n]{2,120})"', cue_match.group(1)):
            c = clean_value(item)
            if c: cues.append({"text": c, "confidence": 0.5, "supportRefs": []})

    genre_match = re.search(r'"genreHypotheses"\s*:\s*\[(.*?)(\]|\Z)', text, re.DOTALL)
    if genre_match:
        for label in re.findall(r'"label"\s*:\s*"([^"\n]{2,64})"', genre_match.group(1)):
            c = clean_value(label)
            if not c:
                continue
            if plausible_genre_label(c):
                genres.append({"label": c, "confidence": 0.65})
            else:
                recovery_uncertainties.append("misfiled genre claim")

    ctx_match = re.search(r'"contextHypotheses"\s*:\s*\[(.*?)(\]|\Z)', text, re.DOTALL)
    if ctx_match:
        for item in re.findall(r'"text"\s*:\s*"([^"\n]{2,120})"', ctx_match.group(1)):
            c = clean_value(item)
            if c: contexts.append({"text": c, "category": "scene", "confidence": 0.55})

    aes_match = re.search(r'"aestheticConcepts"\s*:\s*\[(.*?)(\]|\Z)', text, re.DOTALL)
    if aes_match:
        for item in re.findall(r'"text"\s*:\s*"([^"\n]{2,120})"', aes_match.group(1)):
            c = clean_value(item)
            if c: aesthetics.append({"text": c, "confidence": 0.58})

    imp_match = re.search(r'"impressions"\s*:\s*\[(.*?)(\]|\Z)', text, re.DOTALL)
    if imp_match:
        for item in re.findall(r'"text"\s*:\s*"([^"\n]{2,120})"', imp_match.group(1)):
            c = clean_value(item)
            if c: impressions.append({"text": c, "confidence": 0.55})

    if any([audible, relations, cues, genres, contexts, aesthetics, impressions]):
        return {
            "audibleObservations": audible,
            "signatureRelations": relations,
            "styleCues": cues,
            "uncertainties": recovery_uncertainties,
            "genreHypotheses": genres,
            "contextHypotheses": contexts,
            "aestheticConcepts": aesthetics,
            "impressions": impressions
        }

    # 4. An unstructured response is quarantined. Guessing its semantics with developer-authored
    # keyword lists would silently turn parser failure into subjective word-pool authority.
    return sanitize_packet({
        "audibleObservations": audible,
        "signatureRelations": relations,
        "uncertainties": ["unstructured model response quarantined"],
        "genreHypotheses": genres,
        "contextHypotheses": contexts,
        "aestheticConcepts": aesthetics,
        "impressions": impressions
    })


INFERENCE_LOCK = threading.Lock()
ACTIVE_INFERENCES_LOCK = threading.Lock()
ACTIVE_INFERENCES = {}
EMPTY_CACHE_AFTER_INFERENCE = os.environ.get("MUSIC_FLAMINGO_EMPTY_CACHE", "1").strip().lower() not in {
    "0", "false", "no", "off"
}
def resolve_text_context_length(default=4096):
    """The decoder's context, not the audio tower's.

    The top-level `max_position_embeddings` in this checkpoint's config is 1200, but that belongs
    to the audio encoder (it sits with audio_frame_step and the tower's own rope_theta=1200).
    The text decoder is a Qwen2 with max_position_embeddings=32768. Hardcoding 1200 as the TEXT
    budget made `1200 - input - 8` negative on literally every request, so the generation budget
    silently sat on its floor and the model never got to write past its first field. Read the real
    number off the loaded config instead of trusting a constant that cannot notice it is wrong.
    """
    try:
        text_config = getattr(model.config, "text_config", None)
        limit = int(getattr(text_config, "max_position_embeddings", 0) or 0)
    except Exception:
        limit = 0
    if limit <= 0:
        return default
    # We never need the full 32k; a bounded window keeps the KV cache small on a 4-bit load while
    # still leaving room for the whole packet many times over.
    return max(default, min(limit, 8192))

MODEL_MAX_LENGTH = resolve_text_context_length()
# At 512, 14 of 21 logged full passes (flamingo-server-v29.log) stopped before the JSON closed,
# so the late fields -- aesthetics, impressions and every contextHypotheses entry -- never arrived.
MAX_GENERATION_TOKENS = 1024
# Enough for a small entry in every field. The full pass still gets the whole allowance.
FIRST_IMPRESSION_TOKENS = 256
# Five answers of one or two sentences (the probe answers were 540-930 characters).
FORENSIC_TOKENS = 400
print(f"[Music Flamingo] text context budget: {MODEL_MAX_LENGTH} tokens", flush=True)

class CancelledInference(Exception):
    pass

class CancelWhenSuperseded(StoppingCriteria):
    def __init__(self, cancel_event):
        self.cancel_event = cancel_event

    def __call__(self, input_ids, scores, **kwargs):
        # Recent Transformers versions expect one boolean per batch row.
        return torch.full(
            (input_ids.shape[0],), self.cancel_event.is_set(),
            device=input_ids.device, dtype=torch.bool,
        )

class StopOnRepetition(StoppingCriteria):
    """Ends generation that has degenerated into a repeating loop (see repetition_detected)."""
    CHECK_EVERY = 16

    def __init__(self, prompt_length):
        self.prompt_length = prompt_length
        self.steps = 0
        self.triggered = False

    def __call__(self, input_ids, scores, **kwargs):
        self.steps += 1
        if not self.triggered and self.steps % self.CHECK_EVERY == 0:
            tail = input_ids[0, max(self.prompt_length, input_ids.shape[1] - 320):]
            text = processor.tokenizer.decode(tail, skip_special_tokens=True)
            self.triggered = repetition_detected(text)
        return torch.full((input_ids.shape[0],), self.triggered, device=input_ids.device, dtype=torch.bool)

def register_inference(request_id, session_id, track_epoch):
    cancel_event = threading.Event()
    with ACTIVE_INFERENCES_LOCK:
        # Only a newer capture from the same listener supersedes their older work.
        # Other visitors wait on INFERENCE_LOCK and must not cancel each other's songs.
        for active in ACTIVE_INFERENCES.values():
            if active.get("sessionId") == session_id:
                active["cancel"].set()
        ACTIVE_INFERENCES[request_id] = {
            "cancel": cancel_event,
            "sessionId": session_id,
            "trackEpoch": track_epoch,
        }
    return cancel_event

def unregister_inference(request_id, cancel_event):
    with ACTIVE_INFERENCES_LOCK:
        active = ACTIVE_INFERENCES.get(request_id)
        if active and active["cancel"] is cancel_event:
            ACTIVE_INFERENCES.pop(request_id, None)

def cancel_inferences(request_id="", session_id="", track_epoch=None):
    cancelled = 0
    with ACTIVE_INFERENCES_LOCK:
        for active_request_id, active in ACTIVE_INFERENCES.items():
            request_matches = bool(request_id) and active_request_id == request_id
            session_matches = bool(session_id) and active.get("sessionId") == session_id
            epoch_matches = track_epoch is not None and active.get("trackEpoch") == track_epoch
            if request_matches or (not request_id and session_matches and (track_epoch is None or epoch_matches)):
                active["cancel"].set()
                cancelled += 1
    return cancelled

def release_inference_cache():
    gc.collect()
    if torch.cuda.is_available() and EMPTY_CACHE_AFTER_INFERENCE:
        # Returning inactive generation/KV/attention blocks to WDDM prevents the CUDA caching
        # allocator from appearing to grow after every song and leaves headroom for the browser.
        torch.cuda.empty_cache()

def run_inference(tmp_path, listen_prompt, cancel_event, budget_cap=None):
    conversation = None
    inputs = None
    output = None
    generated = None
    try:
        if cancel_event.is_set():
            raise CancelledInference("superseded before inference")
        conversation = [{"role": "user", "content": [
            {"type": "text", "text": listen_prompt},
            {"type": "audio", "path": tmp_path}
        ]}]
        inputs = processor.apply_chat_template(
            conversation,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
        ).to(model.device)

        if "input_features" in inputs:
            inputs["input_features"] = inputs["input_features"].to(model.dtype)

        if cancel_event.is_set():
            raise CancelledInference("superseded during preprocessing")
        input_token_count = int(inputs.input_ids.shape[1])
        # The checkpoint warns once total input + generated tokens pass 1200. Keep the rich JSON
        # budget, but leave headroom for the audio/text prompt instead of allowing a 768-token
        # tail to run past the model's context and hold temporary KV blocks unnecessarily.
        headroom = MODEL_MAX_LENGTH - input_token_count - 8
        allowance = MAX_GENERATION_TOKENS if not budget_cap else min(MAX_GENERATION_TOKENS, budget_cap)
        generation_budget = max(96, min(allowance, headroom))
        print(
            f"[Music Flamingo] input tokens={input_token_count}; "
            f"generation budget={generation_budget}",
            flush=True,
        )
        # A budget that fell to its floor cannot write past the first field of the packet, so
        # aesthetics and impressions never get generated at all. That used to happen on every
        # single request while looking like a perfectly successful inference -- say it out loud.
        if generation_budget < allowance:
            print(
                f"[Music Flamingo] WARNING: generation budget reduced from {allowance}"
                f" to {generation_budget} (context {MODEL_MAX_LENGTH}, headroom {headroom})."
                " Expect a truncated packet -- shorten the prompt or the prior-segment memory.",
                flush=True,
            )
        repetition = StopOnRepetition(input_token_count)
        with torch.inference_mode():
            output = model.generate(
                **inputs,
                max_new_tokens=generation_budget,
                do_sample=False,
                stopping_criteria=StoppingCriteriaList([CancelWhenSuperseded(cancel_event), repetition]),
            )
        if cancel_event.is_set():
            raise CancelledInference("superseded during generation")
        if repetition.triggered:
            print(f"[Music Flamingo] stopped a repeating generation after {repetition.steps} tokens", flush=True)

        generated = output[:, inputs.input_ids.shape[1]:]
        return processor.batch_decode(generated, skip_special_tokens=True)[0]
    finally:
        generated = None
        output = None
        inputs = None
        conversation = None
        release_inference_cache()

class FlamingoHandler(http.server.BaseHTTPRequestHandler):
    def report_error(self, code, message):
        """Send an error status, tolerating a client that has already hung up.

        The 409 path exists precisely because a newer capture superseded this one -- which the
        browser signals by aborting the in-flight request. So by the time this runs the socket is
        usually gone, and send_error() then raises ConnectionAbortedError from inside the except
        block, replacing an ordinary cancellation with a full traceback and an unclean thread exit.
        Cancellation is the normal case here, not a failure.
        """
        try:
            self.send_error(code, message)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            print(f"Client already disconnected; {code} not delivered.", flush=True)

    def do_GET(self):
        if self.path != '/health':
            self.send_error(404)
            return
        body = json.dumps({"status": "ready"}).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_probe(self):
        """Research endpoint: run one arbitrary prompt over one WAV and return the raw text.

        Used by scripts/probe-flamingo-listening.cjs to compare listening prompts and windows without
        touching the word pipeline. Loopback clients only; nothing here reaches the word pool.
        """
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self.send_error(403)
            return
        tmp_path = None
        try:
            import base64
            prompt = base64.b64decode(self.headers.get('X-Probe-Prompt', '')).decode('utf-8')
            budget = max(64, min(MAX_GENERATION_TOKENS, nonnegative_int(self.headers.get('X-Probe-Max-Tokens', '512'))))
            content_length = int(self.headers.get('Content-Length', 0))
            if not prompt or content_length <= 0 or content_length > 30 * 1024 * 1024:
                self.send_error(400, "prompt and WAV body required")
                return
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp.write(self.rfile.read(content_length))
                tmp_path = tmp.name
            started = time.time()
            with INFERENCE_LOCK:
                text_out = run_inference(tmp_path, prompt, threading.Event(), budget)
            body = json.dumps({"text": text_out, "seconds": round(time.time() - started, 1)}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            print(f"Probe error: {e!r}", flush=True)
            self.report_error(500, "probe failed")
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)

    def do_POST(self):
        if self.path == '/probe':
            self.handle_probe()
            return
        if self.path == '/cancel':
            request_id = clean_identity(self.headers.get('X-Music-Shower-Request-Id', ''))
            session_id = clean_identity(self.headers.get('X-Music-Shower-Session', ''))
            epoch_header = self.headers.get('X-Music-Shower-Track-Epoch')
            track_epoch = nonnegative_int(epoch_header) if epoch_header is not None else None
            cancelled = cancel_inferences(request_id, session_id, track_epoch)
            self.send_response(202)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"cancelled": cancelled}).encode('utf-8'))
            return
        if self.path == '/analyze':
            cancel_event = None
            request_id = ""
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length > 30 * 1024 * 1024:
                    self.send_error(400, "File too large")
                    return
                
                # Write to a temp WAV file
                audio_data = self.rfile.read(content_length)
                session_id = clean_identity(self.headers.get('X-Music-Shower-Session', ''))
                segment_id = clean_identity(self.headers.get('X-Music-Shower-Segment', ''))
                track_epoch = nonnegative_int(self.headers.get('X-Music-Shower-Track-Epoch', '1'))
                request_id = clean_identity(self.headers.get('X-Music-Shower-Request-Id', ''))
                if not request_id:
                    request_id = f"local-{track_epoch}-{time.time_ns()}"
                cancel_event = register_inference(request_id, session_id, track_epoch)
                active_audio_ms = nonnegative_int(self.headers.get('X-Music-Shower-Active-Ms', '0'))
                # Every word-pool listen is independent and blind. Local classifier evidence is
                # reconciled later by /api/compose-genre; it never enters this generation prompt.
                independent_listen = True
                listen_depth = self.headers.get('X-Music-Shower-Listen-Depth', '')
                first_impression = listen_depth == 'first-impression'
                listen_prompt, prior_segment_count = build_blind_listen_prompt(
                    active_audio_ms, first_impression)
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp.write(audio_data)
                    tmp_path = tmp.name
                audio_data = None

                if listen_depth == 'forensic':
                    print("Running Flamingo forensic listening...", flush=True)
                    start_t = time.time()
                    with INFERENCE_LOCK:
                        text_out = run_inference(tmp_path, FORENSIC_PROMPT, cancel_event, FORENSIC_TOKENS)
                    answers = parse_forensic_answers(text_out)
                    print(f"[Music Flamingo] FORENSIC RESPONSE ({time.time()-start_t:.1f}s)\n{text_out[:2000]}\n"
                          f"[Music Flamingo] FORENSIC ANSWERS {json.dumps(answers, ensure_ascii=False)}", flush=True)
                    body = json.dumps({"forensics": answers, "caption": text_out,
                        "continuity": {"sessionId": session_id or None, "segmentId": segment_id or None,
                            "trackEpoch": track_epoch, "requestId": request_id or None,
                            "activeAudioMs": active_audio_ms, "listenDepth": "forensic",
                            "listeningMode": "independent", "independent": True}}).encode('utf-8')
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return

                print("Running Flamingo structured deep-listening inference"
                      + (" (first impression)" if first_impression else "") + "...", flush=True)
                start_t = time.time()
                with INFERENCE_LOCK:
                    text_out = run_inference(tmp_path, listen_prompt, cancel_event,
                        FIRST_IMPRESSION_TOKENS if first_impression else None)
                packet = parse_deep_listen_packet(text_out)
                if first_impression:
                    for item in packet.get("genreHypotheses") or []:
                        if isinstance(item, dict):
                            item["provisional"] = True
                            try:
                                item["confidence"] = min(float(item.get("confidence", 0.5)), 0.48)
                            except (TypeError, ValueError):
                                item["confidence"] = 0.45
                log_model_exchange(text_out, packet)
                
                print(
                    f"Inference complete in {time.time()-start_t:.1f}s. "
                    f"Packet parsed: {list(packet.keys())}",
                    flush=True,
                )
                
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"caption": text_out, "structuredPacket": packet,
                    "continuity": {"sessionId": session_id or None, "segmentId": segment_id or None,
                        "trackEpoch": track_epoch, "requestId": request_id or None,
                        "activeAudioMs": active_audio_ms, "priorSegments": prior_segment_count,
                        "listenDepth": "first-impression" if first_impression else "full",
                        "listeningMode": "independent", "independent": True,
                        "genreAdvisoryUsed": False, "genreAdvisoryCandidates": []}
                }).encode('utf-8'))
            except CancelledInference as e:
                print(f"Inference cancelled: {e}", flush=True)
                self.report_error(409, "Inference superseded by a newer track or capture")
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                print("Client disconnected before the Flamingo response was delivered.", flush=True)
            except Exception as e:
                print(f"Error: {e!r}", flush=True)
                traceback.print_exc()
                self.report_error(500, "Flamingo inference failed")
            finally:
                if cancel_event is not None:
                    unregister_inference(request_id, cancel_event)
                if 'tmp_path' in locals() and os.path.exists(tmp_path):
                    os.remove(tmp_path)
        else:
            self.send_error(404)

if __name__ == "__main__":
    HTTPD.RequestHandlerClass = FlamingoHandler
    print(f"Flamingo server serving at port {PORT}", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        HTTPD.shutdown()
        HTTPD.server_close()
