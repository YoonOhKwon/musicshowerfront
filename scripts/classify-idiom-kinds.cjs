const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "..", "data", "musicalLexicon.json");
const lexicon = JSON.parse(fs.readFileSync(file, "utf8"));

const ACOUSTIC = new Set([
  "house_offbeat_hat", "house_clap_backbeat", "trailing_snare", "ride_led_swing",
  "laid_back_phrasing", "citypop_smooth_harmonic_motion", "citypop_melodic_bassline",
  "futurefunk_rhythmic_vocal_sampling", "bebop_fast_walking_pulse",
  "cool_jazz_relaxed_tempo", "fusion_dense_harmonic_rhythm", "techno_hypnotic_repetition",
  "trance_uplifting_buildup", "synthwave_gated_drums", "rnb_smooth_vocal_led_texture",
  "rock_driving_backbeat", "metal_dense_distortion_wall", "pop_bright_hook_production",
  "breakcore_extreme_density", "postrock_slow_build_swell", "cooljazz_understated_lead",
  "fusion_odd_meter_tendency", "rnb_lush_chord_bed", "indierock_loose_energy",
  "metal_precise_double_kick_feel", "pop_concise_hook_structure", "soul_gospel_vocal_led_warmth",
  "ambient_texture_dominant_arrangement", "techno_minimal_loop_focus"
]);

const newEntries = [
  {
    id: "rhythm.two_step_topology",
    kind: "ACOUSTIC_MATERIAL",
    facet: "rhythm",
    semanticFamily: "broken-pulse",
    neutralText: "킥-스네어가 엇갈린 펄스",
    required: [
      { path: "pulse.breakDensity", min: 0.5 },
      { path: "pulse.shuffleStrength", min: 0.4 }
    ],
    contradicting: [{ path: "pulse.kickPeriodicity", min: 0.55 }],
    anchors: ["pulse.breakDensity", "pulse.shuffleStrength"],
    confidenceRule: "min",
    ttlMs: 9000
  },
  {
    id: "rhythm.swing_pulse",
    kind: "ACOUSTIC_MATERIAL",
    facet: "rhythm",
    semanticFamily: "swing-pulse",
    neutralText: "스윙 셔플 펄스",
    required: [
      { path: "pulse.shuffleStrength", min: 0.5 },
      { path: "texture.voiceCount", min: 3 }
    ],
    anchors: ["pulse.shuffleStrength", "texture.voiceCount"],
    confidenceRule: "min",
    ttlMs: 9000
  },
  {
    id: "rhythm.comping_pattern",
    kind: "ACOUSTIC_MATERIAL",
    facet: "performance",
    semanticFamily: "accompaniment",
    neutralText: "엇박에 놓인 반주",
    required: [
      { path: "pulse.accentPlacement", min: 0.48 },
      { path: "instrument.presenceConfidence", min: 0.45 }
    ],
    anchors: ["pulse.accentPlacement", "instrument.presenceConfidence"],
    confidenceRule: "min",
    ttlMs: 8000
  }
];

let acoustic = 0, contextual = 0, inserted = 0;
for (const entry of lexicon.entries) {
  if (ACOUSTIC.has(entry.id)) {
    entry.kind = "ACOUSTIC_MATERIAL";
    delete entry.requiredContext;
    delete entry.contextMode;
    acoustic += 1;
  } else if (entry.requiredContext || entry.contextMode === "REQUIRED") {
    entry.kind = "CONTEXTUAL_INTERPRETATION";
    contextual += 1;
  }
}

const have = new Set(lexicon.entries.map(entry => entry.id));
for (const entry of newEntries) {
  if (have.has(entry.id)) continue;
  lexicon.entries.push(entry);
  inserted += 1;
}

fs.writeFileSync(file, `${JSON.stringify(lexicon, null, 2)}\n`);
console.log(JSON.stringify({ acousticUngated: acoustic, contextualKept: contextual, inserted, total: lexicon.entries.length }));
