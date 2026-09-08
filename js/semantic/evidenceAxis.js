// Maps an evidence anchor path to a canonical musical axis.
// First-segment slicing ("primitives.pulse.x" → "primitives") collapses independent
// detectors onto one root. This resolver keeps pulse, bass, harmony, melody distinct.
const EvidenceAxis = (() => {
  const PARENT = Object.freeze({
    pulse: "rhythm",
    drums: "rhythm",
    "production.filter": "production",
    "production.dynamics": "production",
    "production.sampling": "production",
    "production.space": "production",
    "instrumentation.vocal": "instrumentation",
    "instrumentation.percussion": "instrumentation",
    arrangement: "form"
  });

  const AXIS_ALIASES = Object.freeze({
    pulse: "pulse", rhythm: "rhythm", drums: "drums", drum: "drums",
    bass: "bass", harmony: "harmony", tonal: "harmony", melody: "melody",
    vocal: "instrumentation.vocal", voice: "instrumentation.vocal",
    instrumentation: "instrumentation", instrument: "instrumentation",
    performance: "performance", role: "performance", articulation: "performance",
    production: "production", form: "form", arrangement: "form",
    dynamics: "dynamics", texture: "instrumentation"
  });

  function tokens(path) {
    return String(path || "").replace(/^snapshot\.?/i, "").split(".").filter(Boolean);
  }

  function fromKnownSegment(segment) {
    const key = String(segment || "").toLowerCase().replace(/[_-]/g, "");
    if (AXIS_ALIASES[key]) return AXIS_ALIASES[key];
    if (key === "fouronfloor" || key === "swing" || key === "syncopation" || key === "brokenbeat"
      || key === "subdivisionratio" || key === "kickperiodicity" || key === "microtimingdeviation")
      return "pulse";
    if (key === "sidechain" || key === "pumping" || key === "compression") return "production.dynamics";
    if (key === "filtersweep" || key === "lowpass" || key === "highpass" || key === "filter") return "production.filter";
    if (key === "samplebased" || key === "samplerepetition" || key === "vocalchop") return "production.sampling";
    if (key === "reverb" || key === "roomsize" || key === "delaydensity" || key === "stereowidth") return "production.space";
    if (key === "chroma" || key === "harmonicmotion" || key === "tonalfocus") return "harmony";
    if (key === "pitchevidence" || key === "melodiccontour") return "melody";
    return null;
  }

  function resolveEvidenceAxis(anchor) {
    const parts = tokens(anchor);
    if (!parts.length) return "unknown";
    const head = parts[0];
    const second = parts[1] || "";
    const third = parts[2] || "";

    if (head === "primitives" || head === "primitive") {
      return fromKnownSegment(second) || fromKnownSegment(third) || "unknown";
    }
    if (head === "rhythmicGrammar" || head === "rhythm") {
      return fromKnownSegment(second) || "pulse";
    }
    if (head === "productionEvidence" || head === "production") {
      return fromKnownSegment(second) || "production";
    }
    if (head === "instrumentation" || head === "instrumentationEvidence" || head === "instrumentEvents") {
      if (/vocal|voice/i.test(second + third + String(anchor))) return "instrumentation.vocal";
      if (/drum|perc/i.test(second + third)) return "instrumentation.percussion";
      return fromKnownSegment(second) || "instrumentation";
    }
    if (head === "performance") {
      if (/bass/i.test(second + third)) return "bass";
      return "performance";
    }
    if (head === "measurements" || head === "analysisWindow" || head === "expressionFeatures") {
      if (/bass/i.test(second)) return "bass";
      if (/onset|bpm|beat|transient/i.test(second)) return "pulse";
      if (/centroid|flatness|rms|energy/i.test(second)) return "dynamics";
      return "dynamics";
    }
    if (head === "trackCharacter") {
      if (/harmony/i.test(second)) return "harmony";
      if (/rhythm/i.test(second)) return "pulse";
      if (/structure/i.test(second)) return "form";
      if (/production|timbre|dynamics/i.test(second)) return fromKnownSegment(third) || "production";
      if (/texture/i.test(second)) return "instrumentation";
      return fromKnownSegment(second) || "dynamics";
    }
    if (head === "mir") return fromKnownSegment(second) || (second === "tonal" ? "harmony" : "harmony");
    if (head === "pitchEvidence") return "melody";
    if (head === "harmonicMotion") return "harmony";
    if (head === "audio") {
      if (/chroma|tonal/i.test(second)) return "harmony";
      if (/bass/i.test(second)) return "bass";
      return "dynamics";
    }
    if (head === "genreEvidence" || head === "primaryGenre" || head === "genre") return "genre";
    if (head === "moodDimensions" || head === "mood") return "dynamics";
    if (head === "directAudioEvidence") return fromKnownSegment(second) || "performance";
    return fromKnownSegment(head) || fromKnownSegment(second) || head.toLowerCase() || "unknown";
  }

  function familyOf(axis) {
    const resolved = String(axis || "unknown");
    return PARENT[resolved] || resolved.split(".")[0] || "unknown";
  }

  function independentAxes(anchors = []) {
    const paths = (Array.isArray(anchors) ? anchors : []).filter(Boolean);
    const axes = [...new Set(paths.map(resolveEvidenceAxis).filter(axis => axis && axis !== "unknown"))];
    const families = new Set();
    const unique = [];
    for (const axis of axes) {
      const family = familyOf(axis);
      if (families.has(family) || families.has(axis)) continue;
      if (axes.some(other => other !== axis && familyOf(other) === axis)) continue;
      families.add(family);
      unique.push(axis);
    }
    return unique;
  }

  function strongMultiAxis(anchors, { minAxes = 2 } = {}) {
    return independentAxes(anchors).length >= minAxes;
  }

  return { resolveEvidenceAxis, independentAxes, familyOf, strongMultiAxis, PARENT };
})();

if (typeof module !== "undefined" && module.exports) module.exports = EvidenceAxis;
