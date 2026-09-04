# "-코어" Whitelist Externalization

## Problem

`js/semantic/semanticFacets.js`'s `safeText()` blocked every "-코어" (*-core*) term except a
hardcoded 4-entry array (브레이크코어/하드코어/데스코어/매스코어). This conflicted with the
project's goal of surfacing genre aesthetic/cultural identity through language: real,
scene-established micro-genres like 글리치코어(glitchcore), 디지코어(digicore),
프렌치코어(frenchcore) etc. were being rejected as if they were AI-invented coinages, even
though the actual risk (models freely minting "유리코어"/"네온코어"-style nonsense) is a real,
separate problem the filter should keep blocking.

## Change

1. **`data/approvedCoreTerms.json`** (new) is now the source of truth for the whitelist. Each
   entry records `term`, `aliases` (English spelling) and `genreFamily` as minimal grounding —
   nothing is listed without a real scene/distribution-channel identity. Expanded from 4 to 11
   entries: 브레이크코어, 하드코어, 데스코어, 매스코어, 글리치코어, 디지코어, 시길코어,
   프렌치코어, 스피드코어, 니트로코어, 로파이코어.
2. **`js/semantic/semanticFacets.js`** reads this list instead of a hardcoded array, following the
   file's existing UMD-style conditional-loading pattern: a small 4-term safe default lives in the
   module until real data arrives, Node/tests load the JSON synchronously via `require()` at
   module-init time (same as the file's existing `Layers` import), and a new
   `setApprovedCoreTerms()` export lets the browser bootstrap inject the fetched list
   asynchronously. All other `safeText()` filters (generic AI-poetry blocklist, song/composer
   identification blocker, era-year regex) are untouched.
3. **`js/semantic/semanticEngine.js`**'s `loadSemanticData()` now also fetches
   `./data/approvedCoreTerms.json` and calls `SemanticFacets.setApprovedCoreTerms(...)`, alongside
   its existing sibling `data/*.json` fetches — so the browser runtime picks up the same expanded
   list as Node.
4. **`lib/languageService.js`**'s `languageInstructions` prohibition text was reworded from an
   implied enumerated-whitelist framing ("only established whitelisted terms are accepted") to a
   policy statement ("arbitrary invented *core/코어 labels are forbidden; only terms registered as
   established scene genres are accepted") — the LLM is told the *policy*, not the list; the local
   `safeText()` critic still performs the actual validation regardless of what the LLM produces.

## Tests

Added to `test/musicLanguageReform.test.js`:
- The whitelist file carries the expanded scene list, and every entry has a grounding alias +
  genreFamily and is accepted by `safeText()`.
- Arbitrary invented "-코어" coinages (유리코어, 네온코어, 헬로키티코어, 달빛코어) are still
  rejected, including when one invented term is embedded alongside a registered one.
- The unrelated `safeText()` filters (AI-poetry blocklist, song identification, era-year
  regex) are unaffected by this change.

`npm run check` (syntax check + knowledge validator + full test suite) passes: 268/268 tests green.
