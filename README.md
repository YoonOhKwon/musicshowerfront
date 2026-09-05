# Music Shower · Music Language Engine

Music Shower는 음악에서 관측한 정보를 **장르·계보·리듬·악기·연주·편곡·프로덕션·다이내믹·분위기·시대·씬·문화·연상·현재 변화**의 14개 관점으로 보여줍니다. 실시간 분석은 브라우저에서 무료로 실행되고, 선택한 AI 모드는 20~45초 분석 요약을 근거가 있는 열린 음악 용어로 보강합니다. 원본 오디오는 전송하지 않습니다. API를 기다리거나 호출에 실패해도 실시간 단어와 시각화는 계속됩니다. 전체 구현·성능·장르별 경로는 [V2 재건축 보고서](docs/MUSIC_INTELLIGENCE_V2.md)에 정리했습니다.

## 실행

```powershell
npm install
npm start
```

`http://localhost:3000`을 열고 탭/시스템 오디오 또는 음원 파일을 선택합니다. AI 보강에는 `.env`의 `OPENAI_API_KEY`가 필요합니다. 비용 없는 실행은 시작 화면의 `실시간 분석 · 비용 없음` 또는 `?language=local`을 선택합니다.

## V2 음악 지능 파이프라인

```text
Audio Input → AudioWorklet → Shared PCM Ring (or transferable fallback)
├─ Fast DSP → background deformation / live words
├─ MIR + Essentia frontend → tempo / chroma / rhythm / tonal evidence
├─ ONNX music models → genre / instruments / mood / 1280-D embedding
└─ Musical primitives → neutral idiom lexicon → evidence fusion
   → 200ms / 5s / 30s temporal evidence + hysteresis + track memory
   → Semantic State V2 → optional AI specialization → Floating Words
```

- 파형·FFT·비트는 화면 주기로 반응합니다.
- 분위기는 125ms, 악기 단서는 450ms, 느린 의미 상태는 900ms 간격으로 갱신됩니다.
- 모든 오디오 기록은 고정 크기 링버퍼라 장시간 실행해도 계속 커지지 않습니다.
- 장르 모델이 없으면 `미확정 장르`를 표시하며 임의 확률을 만들지 않습니다.
- 모델 출력은 빠름/중간/장기 실측 창으로 누적되며, 최근 관측에 더 큰 가중치를 줍니다.
- UI의 장르 신뢰도는 raw top-1 값을 그대로 확률처럼 보여주지 않고 margin, entropy, 시간 합의도, 안정성, 계열 일관성을 함께 반영한 `보정 신뢰도`입니다. 디버그 패널에는 raw 값도 함께 표시합니다.
- 곡/소스 변경 시 세션 ID가 바뀌어 이전 비동기 결과를 거부합니다.

## 오디오 성능 경로

AudioWorklet은 raw mono, RMS, peak와 기본 bass/mid/high energy를 계산합니다. 서버가 COOP/COEP 격리 헤더를 제공하고 브라우저가 지원하면 4096샘플 블록을 `SharedArrayBuffer` 고정 링에 직접 기록합니다. 격리를 지원하지 않는 환경에서는 동일 블록을 transferable buffer로 전달하므로 앱이 멈추지 않습니다. 48kHz에서 메시지 압력은 128샘플 단위 약 375회/초가 아니라 약 11.7회/초입니다.

Shared 경로에서는 ML Worker가 링의 일관된 최신 구간을 직접 읽습니다. fallback 경로에서만 메인 스레드가 필요한 native-rate PCM 구간을 연속 복사합니다. sinc 리샘플링, Essentia MusiCNN mel 생성과 ONNX 추론은 모두 ML Worker 안에서 실행됩니다. 실행 중 새 요청이 오면 중간 요청을 누적하지 않고 최신 요청 하나만 유지하며, `sessionId/requestId/analysisWindowId`가 오래된 결과를 차단합니다.

## 음악 원형과 관용어

장르를 모르는 경우에도 DSP 문장만 남지 않도록 박 조직, 짜임새, 역할, 화성·선율, 발음, 형식, 프로덕션의 7개 장르 중립 원형을 계산합니다. [musicalLexicon.json](data/musicalLexicon.json)은 모든 규칙에 중립 음악 용어를 두며, 장르 확신도가 충분할 때만 같은 원형을 가리키는 전문 용어로 바꿉니다. 계산할 수 없는 음정 장식·미분음·정확한 반복 마디 같은 값은 0으로 꾸미지 않고 `null`입니다.

Floating Word는 생성 순간의 의미 토큰을 소유합니다. 이후 의미 epoch나 후보 풀이 바뀌어도 흐려지거나 제거되지 않으며, 짧은 진입 fade 뒤 화면을 완전히 벗어날 때까지 같은 불투명도를 유지합니다. 최대 개수에 도달하면 새 생성을 늦출 뿐 기존 단어를 밀어내지 않습니다. 오디오 중지·새 트랙 시작은 명시적 전체 초기화입니다.

## Track Character와 언어

장르 외에도 실제 DSP·ML 시간 이력을 이용해 다음의 책임 있게 추정 가능한 proxy를 유지합니다.

- rhythm: BPM, pulse regularity, onset density, rhythmic complexity, breakbeat likelihood
- harmony: tonalness, dominant pitch class, chroma entropy, harmonic motion
- timbre/texture: brightness, warmth, roughness, noisiness, transient sharpness, density, sustainedness, granularness, layeredness
- dynamics/space/production: dynamic range, crest factor, compression density, pumping, spaciousness, perceived depth, saturation, sub weight
- structure: repetition, section novelty, buildup/breakdown/drop likelihood

이 값은 정밀한 음악학적 측정치가 아니라 현재 관측에서 얻은 비교용 proxy입니다. 신뢰할 수 없는 key/mode, stereo width, reverb type은 임의로 채우지 않습니다.

실시간 표현 엔진은 500ms 간격으로 시간영역 RMS·peak·crest factor와 선형 스펙트럼의 centroid·대역 비중을 측정합니다. 최근 2.5초 대비 변화와 최대 45초/90개 관측을 유지합니다. 높은 음압, 저역 유입, 에너지 하강, 차분함처럼 짧고 직접적인 단어를 사용하며, 시적 조어나 후보 개수 할당량을 채우는 합성을 하지 않습니다.

20초 이상 관측 후 선택적 AI 해석을 요청합니다. 최소 API 간격 45초, 중복 요청 금지, 세션·의미 구간 검증, 현재 상태 재평가를 적용합니다. 변동성이 높은 표현은 12초 뒤 폐기하고 장르 맥락도 60초 뒤 만료합니다. 열린 어휘를 허용하지만 모든 표현에 현재 근거와 확신도를 요구합니다. 14개 관점을 순환하되 현재 변화의 비중을 가장 높이고, 후보가 없는 관점은 건너뜁니다.

음압 표현은 캡처된 디지털 신호 레벨에 대한 상대적 설명이지 실제 청취 음압(SPL)이 아닙니다. shortTermLoudnessDb는 6초 RMS 기반 dBFS proxy이며 LUFS가 아닙니다. 압축·펌핑·분위기·장르는 추정값입니다. 드럼 종류·스윙·세부 장르를 BPM만으로 단정하지 않습니다. 변경 사항과 검증 범위는 [업그레이드 보고서](docs/MUSIC_LANGUAGE_UPGRADE.md)를 참고하세요. 이전 생성형 언어 문서는 역사적 기록입니다.

## 사운드 인터랙티브 배경

V2.1 배경은 정적 이미지가 아니라 GPU 절차적 셰이더입니다. 유기적 contour/liquid/topographic 필드 위에 RGB 도트, CRT scanline, 미세 grain을 합성하고 위쪽은 어둡게, 아래쪽은 분홍·자홍·적색·주황의 열감이 높아지도록 설계했습니다.

- bass: 화면 하부의 큰 변형과 깊이
- mid: 등고선 밀도와 구조
- highs: RGB shimmer와 미세 반짝임
- kick/transient: 노이즈 장의 비대칭 변형과 점성 있는 복원
- novelty/tension: 흐름의 turbulence
- warmth/arousal: 열감과 발광 강도
- 장르 계열: 패턴의 규칙성, 방향, 움직임 문법

재생 화면에는 별도 오브·파형·비트 파티클 없이 생성 배경과 음악 용어만 남습니다. HUD는 `D` 디버그 모드에서만 보입니다. 지속적인 FPS 저하나 모델 지연이 감지되면 렌더 해상도·업데이트 빈도와 의미 분석 주기를 단계적으로 낮춥니다. 상세 변경과 한계는 [고해상도 음악 해석 보고서](docs/HIGH_RESOLUTION_INTERPRETATION.md)를 참고하세요.

## 로컬 음악 모델

공개 사전학습 모델 3개가 실제 ONNX 파일로 설치되어 있습니다.

- `discogs-effnet-bsdynamic-1`: Discogs 400개 스타일과 1280차원 공용 임베딩
- `mtg_jamendo_instrument-discogs-effnet-1`: 공용 임베딩 기반 악기 40종
- `mtg_jamendo_moodtheme-discogs-effnet-1`: 공용 임베딩 기반 무드·테마 56종

오디오는 AudioWorklet에서 native-rate mono PCM 블록으로 수집합니다. Web Worker가 16kHz sinc 리샘플링과 Essentia 호환 128×96 mel patch 생성을 담당합니다. 추론은 WebGPU를 먼저 시도하고 실패하면 WASM으로 자동 전환합니다. 두 백엔드 모두 실패해도 시각화는 DSP 모드로 계속 동작합니다. 세부 규격과 라이선스는 [docs/MODELS.md](docs/MODELS.md)를 참고하세요.

## 언어 API와 기존 분석 API의 분리

`js/config.js`의 다음 설정은 기본적으로 꺼져 있습니다.

```javascript
CONFIG.semantic.useLLM = false;
CONFIG.ai.autoEnrich = false;
```

따라서 `/api/music-analysis`는 자동 호출되지 않습니다. 새 `/api/language-pool`은 별도 설정인 `CONFIG.language.remote.enabled`에 의해 동작하며 기본 활성입니다. 모델은 `OPENAI_LANGUAGE_MODEL` → `OPENAI_MODEL` → `gpt-5.6-sol` 순서로 선택합니다. 기존 음악 분석 API를 켤 필요가 없습니다.

## 조작

- `D`: 숨겨진 디버그 패널 표시/숨김
- `L`: 언어/프롬프트 평가 패널. 의미 스냅샷, 후보·점수·선별 결과, provider, epoch, 캐시, 남은 문구, 실패 상태와 **마지막 호출·언어 세션·프로젝트 누적 LLM 토큰**을 확인합니다. 입력 캐시·출력·추론 토큰을 분리하며 서버/로컬 캐시 재사용은 새 사용량으로 계산하지 않습니다. 👍/👎는 로컬에 최대 200개 저장하고 JSON으로 내보낼 수 있습니다.
- 디버그 패널: FPS, Worklet 메시지율·블록 크기, main-thread 전달 시간·long task, 리샘플링/mel/encoder/head별 지연, 장르 보정·raw 신뢰도, Track Character, semantic epoch, phrase pool, 배경 렌더 상태, zero-shot 상태

## 품질 모드

시작 화면의 `분석 품질`에서 선택합니다. 세 모드는 같은 검증된 EffNet을 사용하되 실제 추론 주기와 시간 문맥이 다릅니다.

- 가볍게: 3.2초마다 추론, 최대 20초 문맥
- 균형(기본): 2.2초마다 추론, 최대 30초 문맥
- 정밀: 1.4초마다 추론, 최대 45초 문맥

URL의 `?quality=performance|balanced|quality`로도 고정할 수 있습니다. 약 300MB급 MAEST는 기본 브라우저 경로의 초기 로드와 메모리 부담 때문에 강제로 포함하지 않았습니다.

백엔드 대체 경로를 직접 검사할 때는 `?backend=wasm`을 사용합니다. 일반 실행은 WebGPU → WASM 자동 전환입니다.

## Zero-shot 상태

고정 Discogs 400 분류기는 실제 동작합니다. 반면 CLAP 호환 오디오·텍스트 인코더와 동일 공간의 검증된 텍스트 임베딩은 아직 번들하지 않았으므로 zero-shot은 정직하게 `unavailable`입니다. 차원과 모델 출처가 정확히 일치하는 자산만 활성화되며, 다른 임베딩 공간의 값을 섞어 가짜 결과를 만들지 않습니다.

고정 분류기의 Top-K와 Track Character를 데이터 기반 microgenre neighborhood에 연결해 `fineCandidates`를 생성합니다. 이는 관련 후보 탐색이지 zero-shot 확정 판정이 아니며, HUD의 기본 장르를 강제로 덮어쓰지 않습니다.

## 검증

```powershell
npm run check
npm test
npm run test:model
# 선택: 최대 3회의 유료 API 평가
npm run test:language:live
```

`test:model`은 실제 MP3 세 개로 로컬 음악 모델을 검사합니다. `npm test`는 실제 MP3의 RMS/peak→단어 경로, 3단계 시간 증거, 원형·관용어, Shared/transferable 경로, Floating Word의 완주와 무음·드롭·지연·실패·중복을 검사합니다. `test:language:live`는 유료 API를 최대 세 번 호출하는 선택적 검증이며 이번 자동 검증에서는 실행하지 않습니다. 자동 테스트는 장르·분위기의 청감 정확도를 보증하지 않습니다.

### 지속 개선용 회귀 감사

`D` 패널에서 저장한 세션 기록은 이제 classifier, 악기 provenance, performance, MIR, genre-hypothesis를 함께 보존합니다. 실제 청취 경로의 변화를 확인하려면 기록을 다시 재생합니다.

```powershell
node scripts/replay.cjs --input <recordings-folder> --report
```

언어 패널에서 내보낸 👍/👎 파일은 학습 데이터로 자동 사용하지 않고, 현재 근거와 과거 memory 누수를 점검하는 읽기 전용 감사에 사용합니다.

```powershell
npm run audit:feedback -- --input <feedback.json>
```

감사 결과의 `manual-evaluation-only`, `evidenceCoverage`, `independentEvidenceFamilies`, `temporalLeaks`, `legacyPersistenceInflation`을 기준으로 규칙과 threshold를 보정합니다. 여러 classifier top-k label은 독립 근거 하나로 계산하고, Future Funk·French House·Nu Disco·Jazz Rap·Electro Swing·Liquid DnB는 서로 다른 구성 단서가 있을 때만 composite hypothesis가 됩니다.

## 문제 해결

- `로컬 DSP 분석`: 모델 로딩이 실패했지만 시각화는 계속 동작하는 대체 상태입니다.
- WebGPU 없음: WASM을 자동 선택합니다.
- 모델 로드 실패: 오류는 디버그 패널에 표시되고 DSP 모드가 유지됩니다.
- Meyda `ScriptProcessorNode` 경고: 현재 Meyda 5.x 내부 구현에서 발생하는 경고이며 V2 의미 스케줄러나 API 실패와는 무관합니다.
- OpenAI 오류: 현재 관측으로 만든 실시간 단어를 계속 사용합니다. `L`에서 오류를 확인합니다.
- AI 결과가 나타나지 않음: 최소 20초의 관측 후 요청합니다. 실시간 단어가 먼저 표시되는 것이 정상입니다. 키 설정, 서버 재시작, `L`의 provider/상태를 확인하세요.
