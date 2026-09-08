// This file used to be a manually-duplicated copy of js/semantic/directAudioRealizer.js for
// server-side (Node) use. That duplication is exactly how the two drifted -- a fix applied to one
// (e.g. the English+Korean-suffix mixing fix) silently did not apply to the other, so the server's
// /api/realize-direct-audio "fast path" and lib/directAudioReview.js kept producing the bug the
// browser-side copy had already fixed. There must be exactly one implementation.
module.exports = require("../js/semantic/directAudioRealizer");
