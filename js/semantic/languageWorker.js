importScripts("./musicExpressionEngine.js", "./evidenceCompatibility.js", "./phraseQuality.js",
  "./languageLayerPolicy.js", "./semanticFacets.js", "./factFirewall.js", "./phraseGenome.js",
  "./languageCritic.js");
self.onmessage = event => {
  const { id, candidates, options } = event.data;
  try { self.postMessage({ id, result: LanguageCritic.rank(candidates, options) }); }
  catch (error) { self.postMessage({ id, error: String(error.message || error) }); }
};
