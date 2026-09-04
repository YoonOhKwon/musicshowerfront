# Browser Music Model Policy

## 현재 상태

`models/music-shower/manifest.json`은 `available:true`이며 공식 Essentia 배포처의 실제 모델 3개와 동일 버전 metadata를 로컬에서 읽습니다. 모델 SHA-256은 manifest에 고정되어 있고 `npm run test:model`이 실제 MP3 입력으로 세 모델의 입출력을 검증합니다.

| 모델 | 용도 | 크기 | 출력 |
|---|---:|---:|---:|
| `discogs-effnet-bsdynamic-1.onnx` | 장르 + 공유 임베딩 | 18,027,718 bytes | 400 + 1280 |
| `mtg_jamendo_instrument-discogs-effnet-1.onnx` | 악기 head | 2,706,492 bytes | 40 |
| `mtg_jamendo_moodtheme-discogs-effnet-1.onnx` | 무드·테마 head | 2,739,322 bytes | 56 |

## 선택한 런타임 경계

V2 어댑터는 ONNX Runtime Web 형식을 대상으로 합니다.

- WebGPU 우선
- WebGPU 미지원 또는 세션 생성 실패 시 WASM
- 모델 다운로드·규격 오류 시 DSP fallback
- Web Worker에서 추론
- 하나의 공유 encoder 출력에서 genre/instrument/mood head를 사용하도록 manifest 설계

ONNX Runtime은 MIT, Essentia.js는 AGPL-3.0입니다. 모델 가중치의 번들 라이선스 파일 제목은 `CC BY-NC-ND 4.0`이라고 쓰였지만, 같은 파일의 legal-code URL과 현재 공식 모델 문서는 `CC BY-NC-SA 4.0`을 가리킵니다. 보수적으로 비상업·저작자표시·동일조건을 지키고, 상업 사용 전에는 MTG의 별도 허가를 받아야 합니다.

## 검증된 입력 규격

1. AudioWorklet의 native-rate mono PCM 4096샘플 블록
2. ML Worker 안에서 16kHz windowed-sinc 리샘플링
3. Essentia `TensorflowInputMusiCNN` 호환 전처리
4. frame 512, hop 256, 128 frames, 96 mel bands
5. encoder input `[1,128,96]` float32
6. genre output `[1,400]`, embedding `[1,1280]`
7. instrument `[1,40]`, mood/theme `[1,56]`
8. 모델 출력은 이미 sigmoid activation이므로 합이 1이 되도록 재정규화하지 않음

## 브라우저 실행

런타임·모델 URL은 worker 위치가 아니라 서버 root에서 해석되도록 `/...` 절대경로로 고정했습니다. WebGPU 세션 생성이 실패하면 동일 worker에서 WASM 세션을 다시 만들고, 그것도 실패하면 DSP-only 상태로 전환합니다. PCM은 native rate transferable buffer로 넘기고 Worker 안에서 리샘플링하며, 실행 중에는 최신 요청 하나만 유지합니다. 디버그 상태는 resample, mel, encoder, instrument head, mood head와 round-trip을 분리해 기록합니다.

## 로컬 언어 모델

현재 저장소에는 텍스트 생성 가중치를 번들하지 않습니다. `LocalLanguageModel.Adapter`는 지연 로딩 가능한 연결점만 제공하며 기본 상태는 `disabled`입니다. 조사한 Transformers.js 호환 Qwen2.5-0.5B-Instruct ONNX의 q4f16 단일 가중치도 약 483MB이므로, 이미 WebGPU 음악 추론과 WebGL 배경을 함께 사용하는 기본 경로에 강제로 추가하지 않았습니다. 따라서 현재 언어 출력의 출처는 명확하게 `structured`이며 실제 로컬 모델이 연결되기 전에는 `local-model`로 표시되지 않습니다.

## Zero-shot

`data/genreEmbeddings.json`은 CLAP 호환 오디오 encoder와 동일한 공간에서 생성한 텍스트 embedding이 있을 때만 활성화합니다. 현재 Discogs-EffNet의 1280차원 임베딩은 CLAP 텍스트 임베딩과 같은 공간이 아니므로 `available:false`입니다. 조건부 호출과 cooldown은 연결되어 있으나, 호환 CLAP 오디오 encoder와 사전계산 텍스트 임베딩을 함께 설치하기 전까지는 실행되지 않습니다.
