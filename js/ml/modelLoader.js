const MusicModelLoader = (() => {
  async function loadManifest(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`model manifest HTTP ${response.status}`);
    const manifest = await response.json();
    if (!manifest.available || !manifest.metadataUrls) return manifest;
    const entries = await Promise.all(Object.entries(manifest.metadataUrls).map(async ([key, metadataUrl]) => {
      const metadataResponse = await fetch(metadataUrl, { cache: "force-cache" });
      if (!metadataResponse.ok) throw new Error(`model metadata ${key} HTTP ${metadataResponse.status}`);
      return [key, await metadataResponse.json()];
    }));
    manifest.metadata = Object.fromEntries(entries);
    manifest.labels = Object.fromEntries(entries.map(([key, metadata]) => [key, metadata.classes || []]));
    return manifest;
  }

  function validateManifest(manifest) {
    if (!manifest?.available) return { valid: false, reason: manifest?.reason || "modelUnavailable" };
    const required = ["sampleRate", "preprocessing", "runtime", "models", "labels", "license"];
    const missing = required.filter(key => manifest[key] == null);
    if (missing.length) return { valid: false, reason: `manifestMissing:${missing.join(",")}` };
    if (!manifest.models.encoder?.url || !manifest.models.instrument?.url || !manifest.models.mood?.url) {
      return { valid: false, reason: "manifestModelsInvalid" };
    }
    return { valid: true, reason: null };
  }

  async function selectInferenceBackend(preference = ["webgpu", "wasm"]) {
    for (const backend of preference) {
      if (backend === "webgpu" && typeof navigator !== "undefined" && navigator.gpu) return "webgpu";
      if (backend === "wasm" && typeof WebAssembly !== "undefined") return "wasm";
    }
    return "unavailable";
  }

  return { loadManifest, validateManifest, selectInferenceBackend };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MusicModelLoader;
