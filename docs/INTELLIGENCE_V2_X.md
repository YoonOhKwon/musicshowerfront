# Music Shower V2.x Intelligence and Language

> 언어 부분은 2026-09-03 [Generative Language 보고서](GENERATIVE_LANGUAGE.md)로 대체되었습니다. 아래 structured/local-model 설명은 이전 구현 기록입니다. 현재 기본은 Sol API 생성 → Critic Worker → 36개 풀이고, structured 생성은 대체 경로입니다. 긴 문구의 최대 수명도 화면 통과 시간에 맞춰 조정됩니다.

## Critical audio path

```text
AudioWorklet
  4096-sample mono blocks (~11.7 messages/s at 48kHz)
        │ transferable buffer
        ▼
Native-rate bounded PCM ring
        │ one contiguous recent-window copy
        ▼
ML Worker
  sinc resample → mel → encoder → instrument/mood heads
```

이전 경로는 128샘플마다 새 배열을 전송하고 ML 요청 시 메인 스레드에서 sinc 리샘플링을 수행했습니다. 48kHz 2.048초 입력을 사용한 로컬 기준 측정에서 기존 sinc 작업은 요청당 평균 약 21.5ms였습니다. 변경 후 메인 스레드 작업은 native window 복사 약 0.11ms와 transferable dispatch이며 sinc 비용은 Worker 타이밍에 포함됩니다.

Meyda는 여전히 로컬 DSP 특징을 위해 메인 스레드의 기존 ScriptProcessor 기반 구현을 사용합니다. 현재 long-task 관측을 성능 거버너에 연결했지만, 향후 완전한 AudioWorklet/Worker 특징 추출기로 교체할 수 있습니다.

## Rolling track representation

`TemporalAggregator`는 실제 추론 관측을 fast/mid/long 시간창에 보존합니다. 각 창은 최근 관측에 더 높은 가중치를 주고 genre, instrument, mood, embedding을 재사용합니다.

추가 유지 항목:

- short-term embedding
- long rolling centroid
- centroid 대비 embedding variance
- 최대 12개의 시간 분리 section anchor
- genre/embedding temporal agreement

모든 배열은 시간 또는 개수로 제한됩니다.

## Track Character

`TrackCharacter.Engine`은 이미 계산된 DSP history와 temporal diagnostics를 재사용합니다. 새 FFT나 encoder 실행을 추가하지 않습니다.

실제 구현된 축:

- rhythm: BPM, pulse regularity, onset density, rhythmic complexity, breakbeat likelihood
- harmony: tonalness, dominant pitch class, chroma entropy, harmonic motion
- timbre: brightness, warmth, roughness, noisiness, spectral density, transient sharpness
- texture: density, sustainedness, granularness, acoustic/electronic proxy, layeredness
- dynamics: dynamic range, crest factor, compression density, pumping, drop intensity
- space: spaciousness, perceived depth
- production: clean/lo-fi proxy, saturation, sub weight, master brightness
- structure: repetition, section novelty, buildup/breakdown/drop likelihood

stereo width, 구체적 reverb 유형, 신뢰도 낮은 key/mode는 생성하지 않습니다. 각 값은 0–1 비교용 proxy이며 절대적인 음악학적 판정이 아닙니다.

## Coarse-to-fine genre

기본 Discogs-EffNet Top-K와 보정된 tracker가 authoritative base입니다. `genreNeighborhoods.json`은 base label이 가리키는 후보군을 선택하고 Track Character 적합도로 관련 microgenre 후보를 정렬합니다.

`fineCandidates`는 탐색 후보이므로 base classifier를 강제로 덮어쓰지 않습니다. Genuine zero-shot은 동일 CLAP audio/text 공간의 검증된 자산이 설치되기 전까지 비활성입니다.

## Semantic change and epochs

의미 변화 점수는 embedding distance, genre-distribution distance, Track Character distance, DSP novelty, section transition을 결합합니다. embedding/genre/character/section 중 적어도 두 축이 함께 변해야 epoch가 증가합니다. 단일 킥이나 novelty spike만으로 전체 어휘를 교체하지 않습니다.

첫 유효 음악 증거에서도 startup epoch를 종료합니다. 이전 epoch의 화면 단어는 각 단어별 0.5–1.5초 fade 시간을 적용하고, 모든 단어에는 14초 최대 수명이 있습니다.

## Phrase pool

분석 전에는 neutral vocabulary를 사용할 수 있습니다. Track Character confidence 또는 ML 결과가 생기면 neutral 단독 단어는 차단됩니다.

현재 기본 흐름:

```text
Track Character + mood + genre neighborhood
        ↓
compact semantic seed
        ↓
72 structured candidates
        ↓
cliché / literal label / generic / duplicate filter
        ↓
40 phrase pool
```

HUD의 장르·악기 표시는 artistic phrase pool에 자동 삽입하지 않습니다. 후보는 exact/near duplicate, AI cliché, 긴 문장, 깨진 문자열, literal label을 제거합니다. 새 세션이 시작되면 generation id와 phrase pool을 초기화하므로 이전 비동기 결과를 적용할 수 없습니다.

## Optional local model

`LocalLanguageModel.Adapter`는 시작을 막지 않는 lazy optional 계층입니다. 외부 어댑터가 명시적으로 설치되고 `CONFIG.language.localModel.enabled`가 활성화된 경우에만 60개 후보 batch 생성을 요청합니다. 결과는 동일 필터를 통과하고 충분한 후보가 있을 때만 structured pool을 교체합니다.

현재 검증된 텍스트 모델 가중치는 번들하지 않았으므로 기본 상태는 `disabled`, phrase source는 `structured`입니다. 약 483MB의 q4f16 0.5B 모델을 기본 탑재하면 음악 WebGPU·WebGL과 메모리/GPU를 경쟁하므로 오디오 우선순위에 맞지 않는다고 판단했습니다.

참고:

- https://huggingface.co/docs/transformers.js/en/guides/webgpu
- https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct/tree/main/onnx

## Performance policy

high/medium/low 단계는 DSP나 오디오 재생을 변경하지 않습니다.

- background resolution/frame stride
- music ML interval
- phrase regeneration interval
- zero-shot 허용 여부

순서로 비용을 줄입니다. 음악 추론이 실행 중이면 배경은 즉시 매 2프레임 렌더로 전환해 이전 텍스처를 재사용합니다. 장기간 FPS·long-task·worker latency·background cost가 회복되면 품질을 단계적으로 복구합니다.
