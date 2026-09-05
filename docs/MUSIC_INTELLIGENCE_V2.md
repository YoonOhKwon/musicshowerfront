# Music Shower V2 — Music Intelligence 재건축 보고서

기준 빌드: `2026.09.04.music-intelligence-v2`

## 1. 기존 architecture 분석

기존 앱은 탭/시스템 오디오 또는 로컬 파일을 `AudioContext`에 연결하고, `AnalyserNode`와 Meyda가 메인 스레드에서 fast DSP를 만들었다. AudioWorklet은 mono PCM을 4096샘플씩 모아 ML용 장기 버퍼에 전달했다. ML Worker는 Essentia MusiCNN mel frontend와 Discogs EffNet/Jamendo ONNX heads를 실행했다. 그 결과는 장르 tracker, 다중 창 aggregator, Track Character, 14개 semantic facet, optional language service, critic, phrase pool을 거쳐 Floating Word가 됐다.

## 2. 발견한 병목

- AudioWorklet PCM이 메인 스레드 버퍼를 한 번 거친 뒤 ML Worker로 다시 복사됐다.
- fast/musical/context 후보가 같은 표시 풀로 곧바로 들어가 문화 맥락의 시간 게이트가 약했다.
- 장르가 불명확할 때 음악 용어보다 DSP 변화 문장이 강해질 수 있었다.
- semantic epoch 또는 pool 변화가 이미 생성된 Floating Word를 흐리거나 제거할 여지가 있었고, 상한 처리에서 오래된 단어를 밀어낼 수 있었다.
- CLAP 호환 text embedding은 설치되지 않았는데 다른 임베딩 공간을 섞으면 가짜 zero-shot이 되는 상태였다.
- Meyda의 feature callback은 여전히 메인 스레드 ScriptProcessor 경로를 사용한다.

## 3. V2 architecture

```text
Audio Input
  → AudioWorklet (mono/RMS/peak/basic bands)
  → SharedArrayBuffer ring ───────────────┐
       └ transferable fallback            │
                                          ▼
Fast DSP ───────────────→ Visual Reflex   ML Worker
Beat/Chroma history ────→ MIR             Essentia mel + ONNX
Instrument/Rhythm/Track Character         genre/instrument/mood/embedding
               └─────────────┬────────────┘
                             ▼
Musical Primitives → Idiom Lexicon → Evidence Fusion
 → Temporal Evidence (200ms / 5s / 30s) + hysteresis + Track Memory
 → Semantic State V2 → optional LLM specialization → critic → Floating Words
```

## 4. 새로 추가한 engine

- `MIREngine`: tempo stability, chroma, confidence-gated key/scale proxy, rhythm grammar view.
- `EvidenceFusion`: source reliability와 독립 source 수를 이용한 중앙 confidence 융합.
- `TemporalEvidence`: fast/musical/context window, facet hysteresis, pending challenger, 30초 Track Memory.
- `MusicalPrimitives`: pulse/texture/role/tonal/articulation/form/production의 장르 중립 7축.
- `MusicalIdioms`: JSON lexicon을 해석해 항상 중립 음악 용어를 먼저 제공하고, 장르 근거가 충분할 때만 전문화.
- `ArrangementEngine`: 리듬 섹션, 보컬 중심, 레이어드 신스, 소편성 질감.
- `ConceptEmbeddingEngine`: matching text vectors가 있을 때만 활성화되는 concept-bank adapter. 현재는 정직하게 unavailable.
- `SemanticStateV2`: 14개 facet과 계층 준비 상태를 하나의 구조로 노출.

## 5. AudioWorklet 적용 여부

적용했다. Worklet은 raw mono frame, RMS, peak, bass/mid/high 근사 energy를 audio thread에서 계산한다. 4096샘플 단위로만 상태를 공개하므로 48kHz 기준 약 11.7회/초다. rendering은 이 PCM 복사 작업과 분리된다.

## 6. Essentia 적용 내용

실제 `essentia.js`의 `EssentiaTFInputExtractor(..., "musicnn")`가 ML Worker에서 128×96 mel patch를 만든다. BPM/beat는 기존 onset history, key/scale은 Meyda chroma template proxy를 사용하고 confidence가 낮으면 null이다. 브라우저에 두 번째 Essentia core worker를 중복 로드하는 비용은 피했다.

## 7. ML model 적용 내용

- Discogs EffNet: 400 style activations + 1280-D embedding.
- Jamendo instrument head: 40 classes.
- Jamendo mood/theme head: 56 classes.
- ONNX Runtime WebGPU 우선, WASM fallback.
- 번들 ONNX 크기: 23,473,532 bytes(22.4 MiB).
- `requestId`, `sessionId`, `analysisWindowId`, dispatch timestamp를 전달하고 오래된 window 결과를 거절한다.
- CLAP/MERT는 matching runtime/text-vector 자산이 없어 기본 dependency로 넣지 않았다.

## 8. Temporal Evidence 구조

`live/dynamics`는 fast tier에서 즉시 반영한다. `rhythm/instrumentation/performance/arrangement/production`은 musical tier에서 반복 관측이 필요하다. `genre/lineage/mood/era/scene/culture/association`은 context tier에서 최소 3회 및 5.5초 지속이 필요하다. 현재 label보다 challenger가 0.08 이상 높고 2.5초 takeover 시간을 통과해야 교체된다. 확정 정보는 30초 동안 재확인되는 Track Memory에 저장되며 스스로 만료를 연장하지 않는다. LIVE 이벤트는 별도 TTL 뒤 historicalEvents로 이동하고 Track Memory에 승격되지 않는다.

## 후속 보정 라운드 (v19)

v19에서는 semantic confidence와 temporal stability를 분리한 상태에서 실제 오디오 관측의 품질을 높였다. ML 악기 존재는 fast temporal window로 평활화하고, 등장·이탈·리드·솔로 판정은 새로운 `analysisWindowId`가 들어온 경우에만 history를 전진시킨다. 같은 ML 결과를 500ms semantic refresh마다 재사용해 관측 횟수를 부풀리던 경로를 제거했다. performance 표현은 `mixture-level temporal proxy; no source separation`으로 해상도를 명시한다.

beat detector는 steady band energy를 onset impact로 오인하지 않도록 bass/mid/high 상승량과 band share를 사용한다. 이를 통해 `backbeat`, `offbeat`, `hat`, `kick` 후보가 현재 transient에 근거하도록 했고, filter-sweep는 단조로운 centroid trajectory의 길이·방향성·반전량으로 graded confidence를 계산한다.

복합 장르는 classifier label set을 나누어 구성 요소의 출처를 확인한다. 예를 들어 Future Funk는 일본/인터넷 계열과 Disco 계열이 함께 있어야 하며, Nu Disco는 현대적·댄스 계열 label 없이 `Disco + Funk`만으로 생성되지 않는다. `independentEvidenceFamilies`는 group 개수가 아니라 실제 근거 계열(`genreModel`, `rhythm`, `production`, `instrumentation`, `mood`)을 센다.

`scripts/replay.cjs`는 v3 세션 기록을 새 hypothesis engine에 다시 통과시키고 primary timeline, composite, takeover를 보고한다. `scripts/audit-feedback.cjs`는 Language Inspector JSON을 읽기 전용으로 점검하며 수동 vote가 runtime을 학습시키지 않음을 명시하고, legacy persistence inflation과 LIVE/FACT 누수를 수치화한다.

## 9. Genre Context 구조

`data/genreContextKnowledge.json`은 lookup 결과가 아니라 conditional prior다. 장르 confidence 0.75 이상, 가청 상태, 서로 다른 두 evidence group이 일치해야만 lineage/era/scene/culture/association 후보가 생긴다. 실제 오디오 근거가 없으면 Future Funk도 마법소녀나 인터넷 문화를 출력하지 않는다.

## 10. Instrument / Solo 분석 구조

ML 악기 관측은 `presence → dominance history → entrance/lead/solo event` 순으로 처리한다. 개별 class와 별도로 brass/reed/flute/bowed/plucked/keys/synth/bass/percussion/voice 계열을 noisy-OR로 묶는다. 지배도는 정규화 entropy로 계산하고 12초 lead transition rate를 유지한다. 표현 단계는 foreground, lead, solo로 나뉜다. solo의 기존 0.8 다축 AND 조건은 유지했다. bass function은 none/static/ostinato/walking/melodic이며, pitch 근거가 없으면 세부 기능을 만들지 않는다.

## 11. Semantic State V2 구조

```text
genre, lineage, rhythm,
instrumentation, performance, arrangement,
production, dynamics, mood,
era, scene, culture, association, live
```

각 후보는 text/category/confidence/sources/timestamp/anchors/temporal 정보를 갖는다. snapshot은 MIR, embedding status, temporal state, track context, primitives, detected idioms를 포함하되 raw PCM과 raw embedding은 포함하지 않는다.

## 12. Worker 구조

- Main: p5/WebGL rendering, 작은 local semantic orchestration.
- AudioWorklet: PCM capture와 fast block descriptor.
- ML Worker: resample, Essentia mel, ONNX encoder/heads.
- Language Critic Worker: 원격/로컬 표현 검증과 순위화.

별도 DSP/MIR/Semantic worker는 현재 500–1500ms 작업이 1ms 안팎이고 메시지 복잡도가 더 커지므로 추가하지 않았다. profiler 결과가 악화될 때 분리할 수 있는 모듈 경계는 유지했다.

## 13. fallback 구조

```text
SharedArrayBuffer 불가 → transferable PCM
WebGPU 불가 → ONNX WASM
ONNX/Essentia 실패 → local DSP + primitives + neutral idioms
Concept text vectors 없음 → embedding concepts unavailable
Language API 실패/쿨다운/키 없음 → stabilized local phrase pool
WebGL 실패 → 2D organic background
```

어느 뒤쪽 layer도 앞쪽 realtime word와 background를 정지시키지 않는다.

## 14. UI 변경

일반 화면은 procedural background와 Floating Word만 유지한다. orb, waveform, foreground beat particle, radial equalizer/ripple은 없다. 킥은 비대칭 field impulse, bass는 큰 warp, high는 작은 turbulence로 배경에 통합된다.

Floating Word는 2.5% 이동 구간에서만 fade-in하고 이후 완전한 alpha를 유지한다. semantic pool/epoch 변화는 미래 선택에만 영향을 준다. lane 점유율이 낮은 위치를 우선하고 55%/80% 혼잡에서 spawn interval을 늘린다.

남아 있는 제거 경로는 정확히 다음뿐이다.

1. 진행 방향의 viewport 바깥으로 완전히 나감.
2. 움직임이 멈춘 채 `max(60초, 예상 완주 시간×2)`를 넘긴 safety cleanup.
3. 새 오디오 session 시작, 오디오 stop/end, 명시적 visual reset에서 전체 clear.

semantic epoch, 후보 pool 교체, 일반 max lifetime, max-word cap은 기존 단어를 제거하지 않는다.

## 15. 수정 파일

- `server.js`, `index.html`, `README.md`, `package.json`
- `js/config.js`, `js/core/performanceMonitor.js`
- `js/audio/audioEngine.js`, `js/audio/pcmCaptureProcessor.js`
- `js/ml/musicModel.js`, `js/ml/mlWorker.js`
- `js/semantic/semanticEngine.js`, `semanticFacets.js`, `semanticEvidence.js`, `semanticSnapshot.js`, `semanticFacetManager.js`, `instrumentationEventEngine.js`, `rhythmicGrammar.js`
- `js/visual/floatingWord.js`, `visualEngine.js`, `main.js`
- `lib/languageService.js`, `models/music-shower/manifest.json`, `scripts/model-smoke.mjs`

## 16. 추가 파일

- `js/audio/sharedAudioRing.js`
- `js/mir/mirEngine.js`
- `js/ml/conceptEmbeddingEngine.js`
- `js/semantic/evidenceFusionEngine.js`, `temporalEvidenceEngine.js`, `semanticStateV2.js`, `arrangementEngine.js`
- `js/semantic/musicalPrimitiveEngine.js`, `musicalIdiomEngine.js`
- `js/visual/wordLifecycle.js`
- `data/musicConceptBank.json`, `data/musicalLexicon.json`
- `scripts/profile-semantic.cjs`
- `test/floatingWordLifecycle.test.js`, `sharedAudioRing.test.js`, `mirEngine.test.js`, `musicalPrimitive.test.js`, `musicalLexicon.test.js`, `languageV2.test.js`

## 17. 테스트 결과

- `npm run check`: syntax 검사 + 166/166 통과.
- `npm run smoke:model`: 실제 MP3 3개에서 400/1280/40/56 shape, 유한값, 입력별 다른 출력 확인.
- 서버 `/` HEAD: 200, COOP `same-origin`, COEP `credentialless` 확인.
- 유료 language smoke는 실행하지 않았다.

## 18. 성능 측정 결과

현재 호스트의 Node/native ORT smoke 기준 모델 load 131.96ms, 2.048초 patch 평균은 Essentia mel 66.06–89.83ms, encoder 2.46–3.12ms, instrument+mood heads 12.49–20.54ms였다. 10,000회 semantic benchmark는 mean 0.579ms, p90 0.882ms, p99 1.181ms, max 1.918ms였다.

브라우저 HUD는 FPS, Worklet p90, ML 단계별 latency, long task, MIR/semantic p90, JS heap을 측정한다. 이 실행 환경의 UI 자동화 transport가 닫혀 있었으므로 실제 브라우저 FPS 숫자는 만들지 않았다. 디버그 `D`에서 기기별 실제 값을 확인할 수 있다.

## 19. 아직 구현하지 않은 optional 기능

- matching text encoder/vector가 포함된 CLAP zero-shot.
- MERT representation.
- Basic Pitch/polyphonic note tracking과 신뢰 가능한 microtonal/ornament 분석.
- MDX/RoFormer/Demucs 계열 server stem separation.
- DSP/MIR 전용 worker 추가 분리.
- 두 번째 Essentia core 기반 beat/key extractor.
- 전문화 전용 LLM delta request. 현재는 안전한 전체 whitelist snapshot과 0.05 cache-key 양자화를 사용한다.

## 20. 다음 단계에서 효과가 큰 개선점

가장 큰 효과는 브라우저에 억지로 MERT를 넣는 것이 아니라, 검증된 CLAP audio+text 쌍을 서버 optional inference로 제공하고 concept bank의 text vector를 동일 모델로 미리 생성하는 것이다. 다음은 Basic Pitch 또는 stem-aware bass/pitch tracking으로 walking/ostinato/solo의 null 영역을 실제 evidence로 채우는 것이다.

## 실제 코드 기준 장르별 분석 경로 예시

아래 단어는 해당 근거가 실제로 임계치를 넘고 temporal tier를 통과할 때만 나온다.

| 입력 경향 | 분석 경로 | 가능한 점진 출력 |
|---|---|---|
| Future Funk | Bundled EffNet의 Disco/Nu-Disco/House 인접 class → 4/4+신스/베이스 → sample/sidechain. `Future Funk` 자체는 400-class model에 없어 neighborhood 후보만 만들고 확정 label로 승격하지 않음 | 로컬 기본은 `Disco`/`Nu-Disco` 계열 후보, `정박 4박`, `신스`, `반복 베이스`, `사이드체인 펌핑`. 검증된 optional language/향후 CLAP가 `Future Funk`를 지지한 뒤에만 `French House 계열`, `인터넷 리바이벌 씬` 등이 열림. `Kawaii/마법소녀`는 별도 aesthetic 근거가 있어야 함 |
| City Pop | EffNet → piano/bass + syncopation → warm context | `City Pop` → `싱코페이션`, `피아노`, `베이스` → `AOR 계열`, `Jazz Funk 계열` → `1970s-1980s 스타일`, `일본 City Pop 씬` |
| UK Garage | EffNet → broken beat/swing + bass → context persistence | `UK Garage` → `브레이크비트`, `불균등 분할`, `베이스` → `2-Step 계열` → `1990년대 UK 스타일`, `UK 클럽 씬`, `Pirate Radio 문화` |
| Jazz | Discogs Jazz family → swing/tonal motion → instrument families/bass function | `Jazz` 또는 세부 Jazz label → `스윙 필`, `다성적 짜임새`, `혼 계열` → 근거가 있으면 `Bebop 계열`, `재즈 소편성 씬`, `순차 진행 베이스/워킹 베이스` → dominance 조건 뒤 `색소폰 중심/리드/솔로` |
| Jungle | EffNet → fast broken pulse + drums/sub weight | `Jungle` → `브레이크비트`, `쪼개진 드럼 리듬`, `드럼`, `지속 저역 기반` → context가 있으면 관련 scene 표현. Amen break는 전용 pattern evidence가 없어 현재 단정하지 않음 |
| Techno | EffNet → stable four-on-floor + synth → production | `Techno` → `정박 4박/4/4 플로어`, `기계적 펄스`, `신스` → 근거가 있으면 `사이드체인 펌핑`, `댄스 씬 계열`, `일렉트로닉 클럽 문화` |
| Ambient | EffNet → low pulse/onset + sustain/spaciousness → context | `Ambient` → `자유 리듬`, `지속음 층`, `레가토 흐름` → `지속음 중심`, `앰비언트 계열`, 근거가 있을 때 `드론 하모니` |

표에 있는 문화·시대·연상 표현은 장르 이름만으로 열리지 않는다. 필요한 현재 오디오 evidence가 없으면 더 일반적인 음악 원형 용어에서 멈추는 것이 정상 동작이다.
