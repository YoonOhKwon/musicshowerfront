# Music Shower V2.x Architecture

## 목표

렌더링은 오디오를 즉시 느끼고, 느린 의미 분석은 렌더링과 분리합니다. 장르 모델이나 네트워크가 실패해도 파형, 비트, 입자, 오브, 로컬 분위기와 단어는 계속 동작합니다.

```text
getDisplayMedia / audio file
            │
            ▼
      Web Audio graph
       ├─ Analyser ── 30–60Hz ── FFT / waveform / beat ── Visual Reflex
       ├─ Meyda ───── bounded RingBuffer ────────────────┐
       └─ AudioWorklet 4096 PCM block ─ native ring      │
                                                        ▼
                                             MultiRateScheduler
                                              ├─ 125ms local mood
                                              ├─ 450ms instrument evidence
                                              ├─ 500ms semantic words
                                              └─ 900ms novelty / model gate
                                                        │
                         ┌──────────────────────────────┴─────────────┐
                         ▼                                            ▼
                 DSP fallback state                         Web Worker model
                                                   sinc → mel → WebGPU/WASM
                                                              │
                                        Discogs-EffNet shared embedding
                                            genre · instrument · mood
                                                              │
                         ┌────────────────────────────────────┘
                         ▼
            TemporalAggregator + GenreTracker
       real fast / mid / long rolling observations
        recency weighting + novelty + hysteresis
                         │
                         ▼
        calibrated certainty / hybrid / family
              + Track Character profile
                         semanticState (single view)
                         │
             ┌───────────┼────────────────────┐
             ▼           ▼                    ▼
       Phrase pool    Visual fusion    Background mapper
             └───────────┼────────────────────┘
                         ▼
               Music Shower visual engine
```

## Realtime DSP

`audioFeatures.js`는 RMS, energy, spectral flux/centroid/flatness/rolloff, ZCR, chroma, MFCC와 7개 주파수 대역을 유지합니다. FFT 대역의 bin 범위는 sample rate와 FFT 크기가 정해질 때 한 번만 계산합니다.

이전의 `push + splice` 기록은 `RingBuffer`로 교체했습니다. 통계는 각 버퍼의 버전별로 캐시되며 median/p10/p90은 한 번 정렬한 결과를 공유합니다.

## ML 경로

`MusicModelBridge`는 다음 상태를 가집니다.

```text
idle → loading → ready
                ↘ fallback
```

현재 manifest는 실제 사전학습 모델 3개를 활성화합니다. 로딩/규격 검사가 실패하면 fallback으로 전환합니다. AudioWorklet은 4096샘플 PCM 블록을 전송하고 메인 스레드는 최근 native-rate 구간만 복사합니다. 워커가 sinc 리샘플링, mel 전처리와 ONNX 실행을 담당하며 동시에 한 요청만 처리합니다. 실행 중 새 창이 도착하면 중간 요청을 쌓지 않고 가장 최신 요청 하나만 남깁니다. WebGPU에서 공유 임베딩을 만든 뒤 악기·무드 head는 ORT 동시 세션 충돌을 피하도록 순차 실행합니다.

## 시간 집계와 장르 추적

각 추론에서 나온 실제 genre, instrument, mood, 1280차원 embedding 관측을 bounded queue에 저장합니다. 빠름/중간/장기 창은 이 실측 관측을 각각 다른 반감기로 recency-weighted mean하고, novelty에 따라 융합 비율을 조절합니다. 진단값은 창별 표본 수와 문맥 길이, genre agreement, embedding agreement를 포함합니다.

GenreTracker는 집계된 실제 Top-K만 입력으로 받고 switch margin과 persistence로 작은 흔들림을 억제합니다. raw top-1은 다중 레이블 활성값이므로 사용자 확률로 직접 표시하지 않습니다. `ConfidenceCalibrator`가 margin, normalized entropy, temporal agreement, tracker stability, broad-family consistency를 결합해 보정 신뢰도와 `certain / probable / hybrid / uncertain / unknown` 상태를 만듭니다. 근접한 두 후보가 강하면 복합 장르로, 세부 장르 증거가 약하지만 계열은 일관되면 broad-family fallback으로 표시합니다.

## Novelty

RMS, flux, centroid, BPM, onset rate, 저·중·고역, chroma, MFCC의 정규화 거리와 실제 1280차원 모델 임베딩 cosine distance를 결합해 0–1 변화 점수를 만듭니다. 강한 변화에서는 genre tracker의 fast 비중을 높이고 오래된 장르 관성을 낮춥니다.

## 의미 융합

빠르게 변하는 arousal, tension, brightness는 로컬 DSP 비중이 78%입니다. valence, warmth, spaciousness는 로컬 66%와 모델 34%를 융합합니다. ML이 준비되지 않으면 로컬 값을 그대로 사용합니다.

Track Character는 이미 존재하는 DSP/temporal history에서 리듬, 화성, 음색, 질감, 다이내믹, 공간, 프로덕션, 구조 proxy를 만듭니다. 세부 장르 neighborhood 검색과 언어·배경은 장르 이름보다 이 곡별 특성을 더 강하게 사용합니다.

단어 엔진은 특정 몇 장르만 처리하는 조건문 대신 `genre family`, `genreState`, `instrumentGroups`, `moodTagGroups` 데이터 테이블을 사용합니다. 설치된 악기 40종과 mood/theme 56종이 모두 적어도 하나의 의미 그룹에 연결됩니다. 분석 후에는 neutral 단독 단어를 제거하고 Track Character semantic seed로 phrase batch를 만든 뒤 중복·literal label·상투 표현을 필터링합니다. semantic epoch가 바뀌면 이전 단어를 빠르게 fade합니다.

## 절차적 배경과 성능 거버너

배경은 별도 WEBGL 버퍼에서 domain-warped noise와 등고선 필드를 만들고, 열감 그라디언트·RGB triad·scanline·grain을 합성합니다. 배경 입력은 전경 파라미터를 그대로 공유하지 않고 `BackgroundAudioMapper`를 거칩니다. bass는 macro deformation, mid는 contour, highs는 shimmer, beat는 pulse, novelty/tension은 turbulence, semantic family는 패턴의 규칙성과 방향으로 매핑됩니다. 중앙 감쇠와 제한된 명도로 오브·입자·단어의 대비를 보존합니다.

`BackgroundPerformance.Governor`는 지속적인 FPS, long task, 추론 지연과 배경 비용을 관찰해 high/medium/low 프로필을 선택합니다. 배경 렌더 스케일·frame stride, ML/언어 주기, zero-shot 허용을 순서대로 조정합니다. WebGPU 추론 중에는 WebGL 배경이 직전 텍스처를 한 프레임 재사용합니다. 셰이더 컴파일이나 WEBGL 경로가 실패하면 CPU 열감 그라디언트로 전환합니다.

## 세션과 동시성

새 소스마다 세션 ID를 증가시키고 DSP, beat, genre, novelty, rolling embedding, Track Character, semantic epoch, phrase pool, 단어/입자 상태를 초기화합니다. 비동기 모델·언어 결과의 세션 ID가 현재 값과 다르면 적용하지 않습니다.

## OpenAI 경계

기본 `CONFIG.semantic.useLLM=false`이며 스케줄러는 API를 호출하지 않습니다. 기존 서버 경로는 선택형 보강을 위해 남아 있지만 장르, 비트, 분위기, 악기, 단어, 화면 반응의 필수 경로가 아닙니다.
