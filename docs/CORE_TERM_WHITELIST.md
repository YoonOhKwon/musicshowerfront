# Open-World Genre Vocabulary Policy

## Decision

`safeText()` no longer treats `data/approvedCoreTerms.json` as a whitelist. A genre, microgenre,
scene term, or productive `-core`/`-코어` label is not false merely because the project authors did
not know it in advance.

The JSON catalog remains as a compatibility index for aliases, genre-family hints, migrations,
and diagnostics. Registration can improve normalization, but it is not permission to speak.

## Where truth is decided

The pipeline separates vocabulary hygiene from musical support:

1. `SemanticFacets.safeText()` rejects malformed, unsafe, overlong, identification-like, and other
   structurally unsuitable display text. It does not decide whether a genre exists.
2. `SemanticFacets.support()` and `LanguageCritic` require resolvable evidence, confidence,
   appropriate evidence groups, and no strong contradiction.
3. Direct Music Flamingo observations count as one explicit evidence family rather than a human
   approval. Repeated captures and local features can corroborate or weaken them over time.
4. `OpenWorldConceptRegistry` gives unfamiliar concepts a reversible lifecycle. A new term can be
   provisional, stabilize through independent observations, or decay when later evidence disagrees.

This makes the system open-world without making it credulous: the engine may name something the
developer never registered, but it still has to explain that name through what it heard.

## Korean display realization

Flamingo source evidence may be English. Established international genre names such as `Mallsoft`
may remain unchanged when natural, while descriptive FACT, CONTEXT, AESTHETIC, and IMPRESSION text
is retained as source evidence and sent to the language service for concise Korean realization.
Untranslated descriptive prose is not placed directly into the floating-word pool.

## Regression contract

Tests assert that:

- registered catalog entries remain valid;
- genuinely unregistered `-코어` spellings pass text hygiene;
- unsupported claims still fail evidence/critic gates rather than a spelling whitelist;
- song identification, exact-year, malformed-text, and strict-facet cliche filters still apply;
- Flamingo evidence and reasoning survive snapshot sanitization;
- untranslated descriptions wait for Korean realization, while international genre labels remain
  displayable.
