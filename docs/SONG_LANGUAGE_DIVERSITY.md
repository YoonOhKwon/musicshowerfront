# Song-Specific Musical Language Diversity — V17

## Audited runtime path

```text
AudioWorklet / transferable fallback
  -> realtime DSP + Meyda + MIR + optional ONNX heads
  -> multi-rate temporal aggregation
  -> MusicalPrimitives (198 declared paths)
  -> MusicalIdioms + MusicalObservations
  -> VerifiedClaimStore + Fact/Context firewalls
  -> LIVE / FACT / CONTEXT / AESTHETIC / IMPRESSION
  -> EvidenceReservoir + SongLanguageProfile
  -> concept-level 70/30 exploit/explore selection + batch facet rotation
  -> FloatingWord (viewport traversal remains the removal condition)
```

The producer/consumer audit is executable with `npm run validate:knowledge` and
`node scripts/knowledge-coverage.cjs`. Before V17, 31 produced (REAL_DETECTOR or DERIVED)
primitive paths had no language consumer. V17 connects all of them through
`MusicalObservations`; the remaining graph-orphan paths are DECLARED_ONLY capabilities and do
not pretend to be measured data.

## Produced paths recovered by the direct musical-observation bridge

- Rhythm: `tempoClass`, `subdivision`, `swingRatio`, `accentDisplacement`
- Harmony: `harmonicTension`
- Role/instrument: `leadStability`, `accompanimentDensity`, `foregroundLikelihood`,
  `melodicRole`, `callResponse`, `ensembleDensity`, `exitLikelihood`, `legato`
- Articulation: `transientSoftness`
- Form/arrangement: `sectionChange`, `densityDelta`, `layerEntry`, `layerExit`, `variation`,
  `repetition`, `foregroundChange`, `instrumentRoleChange`
- Production: `harmonicity`, `spectralSlope`, `spectralFlux`, `compressionBehavior`,
  `saturationLikelihood`

Every resulting phrase carries its exact `primitives.*` anchors. LIVE observations additionally
carry a delta/event source and magnitude. Context and cultural firewalls were not relaxed.

## Bottlenecks fixed

1. Harmony and melody were stored inside broad display categories, making them invisible to
   facet rotation. Candidates now carry a separate `musicalFacet`.
2. Usage was tracked by display string and by a remote-only pool. The new evidence reservoir
   tracks canonical concept, semantic family, evidence source, stability, salience, freshness,
   temporal relevance and display history for local and remote candidates.
3. A semantic epoch could refresh a pool but there was no song-scoped language fingerprint.
   `SongLanguageProfile` survives section epochs, resets on a new session or a conservative
   corroborated song-change signal, and exposes dominant/unused/exhausted concepts.
4. Weighted selection could repeatedly exploit one high-confidence phrase. V17 uses 70% normal
   evidence exploitation and 30% verified under-exposed exploration, plus temporary concept
   exhaustion and batch-level facet exclusion.
5. Long-form layer scheduling previously gave only 30% to FACT. It now targets 55% FACT + 10%
   LIVE, 20% context and 15% aesthetic/impression.
6. The LLM did not receive concept-use memory. It now receives used, exhausted and unexplored
   concepts plus underrepresented facets, and must return `conceptKey`, `musicalFacet`,
   `epistemicLayer` and `evidenceRefs`. Local code recomputes identity and grounding.

## Evaluation

`npm run test:language:diversity` runs deterministic final-selection simulations for 14 distinct
semantic fixtures. Metrics include intra-song unique concept ratio, inter-song Jaccard, facet
coverage, specificity ratio, FACT/LIVE grounding and short-window repetition. The normal test
suite also runs a lightweight three-MP3 fallback regression. That smoke path intentionally makes
no genre/instrument claims because browser ML/MIR inference is not available in the Node decoder.

The benchmark observed 0.60–0.90 unique-concept ratio for the principal named-song fixtures,
8–12 musical facets, 0.83–0.97 specific-language ratio, 1.00 FACT/LIVE grounding, and average
inter-song Jaccard 0.057 (maximum 0.281). Exact values remain printed by the command so
regressions are visible.

The semantic-pipeline microbenchmark currently averages about 2.0 ms over 10,000 iterations.
The phrase pool caches evidence/firewall assessment for an unchanged, binned musical state:
an already-built snapshot averages about 0.6 ms, while a repeated complete pool refresh averages
about 9.7 ms on the development machine. A semantic epoch is part of the cache identity, so a
new song cannot inherit assessed candidates from the previous song.

## Deliberately optional / not fabricated

- DECLARED_ONLY fields such as room size, delay density, low/high-pass likelihood, ghost notes,
  microtonality and instrument-specific articulation remain silent until a real detector exists.
- No new large model or main-thread frame loop was added.
- Mixed-audio instrument classes are not promoted to detailed performance techniques without
  corroborating pitch, dominance or temporal evidence.
