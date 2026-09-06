# Deep Listening Continuity

Music Flamingo captures are successive hearings of one song, not unrelated classification calls.

## Capture semantics

- A globally unique browser session key identifies the song/input session. It includes the local
  semantic session but does not repeat after a page reload, so a new source or tab cannot inherit
  another song's interpretation from the long-running Flamingo process.
- Each capture has a distinct segment id and active-listening timestamp.
- The Flamingo server keeps at most three recent packets for a bounded number of sessions. Previous
  packets are supplied as untrusted hypotheses, never instructions.
- Flamingo is asked to repeat a prior concept only when the current segment corroborates it, lower
  confidence or report uncertainty when it conflicts, and add newly heard concepts freely.

## Browser interpretation memory

- LIVE and FACT observations describe a segment and are replaced by the next capture.
- Genre, context, aesthetic, and impression hypotheses can remain temporarily across captures.
- An unreconfirmed retained hypothesis loses confidence on every capture and expires after three
  minutes. A re-heard concept arrives with a new observation id and can gain genuine temporal
  support; simply retaining it never counts as another observation.
- Competing hypotheses may coexist while their confidence changes. The evidence and temporal
  engines decide which one is currently displayable.

## Uncertainty

Flamingo uncertainty is preserved in `directAudioEvidence.uncertainties` and reaches the Korean
language-realization request. A disputed genre boundary must therefore remain qualified instead of
being converted into an unjustified categorical label.
