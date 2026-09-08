// Re-exports the single canonical implementation (js/semantic/flamingoWordReservoir.js) instead
// of duplicating it -- a manually-duplicated copy here previously drifted out of sync with fixes
// made to the browser-side file (see lib/directAudioRealizer.js for the bug that caused).
module.exports = require("../js/semantic/flamingoWordReservoir");
