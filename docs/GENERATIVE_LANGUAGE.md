# Music Shower — Generative Language 구현 보고서

이전 버전의 기록입니다. 2026-09-04부터 시적 생성 중심 경로는 [실시간 음악 언어 엔진](MUSIC_LANGUAGE_UPGRADE.md)으로 대체되었습니다. 이 문서의 과거 API 결과·비용은 새 버전의 검증 결과가 아닙니다.

2026-09-03. 언어 생성에만 집중한 개조이며 기존 AudioWorklet, DSP, 음악 ML, 배경 셰이더는 보존했다.

## 구조

```text
Music Analysis (local DSP + ML + Track Character)
 → Semantic Snapshot
 → OpenAI Sol Generator (80 candidates + self-ratings + evidence anchors)
 → independent Critic Worker (filters + diversity reranking)
 → curated Phrase Pool (25–36)
 → local weighted Floating Words
```

주 예술 언어 경로는 실제 생성형 모델이다. 기존 사전·조합 생성은 시작/대기/실패/비활성 때의 대체 경로다. 모델에 오디오, PCM, 파형, MFCC 배열, 임베딩을 보내지 않는다. 서버는 스냅샷 내부도 필드 목록으로 제한한다.

## Provider와 비용 제어

- 기본 `gpt-5.6-sol`, reasoning `medium`. 기존 Sol 모델·추론 설정의 품질 기준을 유지한다. `OPENAI_LANGUAGE_MODEL`로 별도 모델을 지정할 수 있다.
- Responses API의 strict JSON schema를 사용한다. 한 API 호출에서 다양한 후보와 자기평가를 함께 얻고, 별도 로컬 Critic으로 재검증한다. 두 번째 LLM 비평 호출은 하지 않는다.
- 유효한 음악 증거와 5초의 epoch 안정화 후 최초 생성. 이후 의미 있는 epoch 변화, 새 세션, 미사용 문구 10개 미만이 조건이다. 시간 경과만으로 재생성하지 않는다.
- 브라우저와 서버 각각 최소 45초 간격. 한 요청만 실행, 동일 서버 요청은 중복 합류, SDK 자동 재시도는 0. 실패도 쿨다운을 따른다.
- 브라우저는 의미 fingerprint 기준 16개 LRU 캐시. 새 세션에서 track cache와 풀을 초기화한다. 서버는 스냅샷 + 최근 문구/아트 디렉션이 같은 요청을 15분/24개 이내에서 재사용한다.
- 최근 표시 문구는 최대 32개, 전송은 24개. 최근 world 이력은 12개, 전송은 6개. 이력은 무한히 늘어나지 않는다.
- 생성 프롬프트의 정적 접두부에 명시적 캐시 경계를 사용한다. 실제 평가의 두 번째·세 번째 요청에서 각각 1,246 input tokens가 캐시됐다.

실측 API 3회(통제 프로필) 결과:

| 프로필 | 후보 → 선별 | 입력 토큰 | 출력 토큰(추론 포함) | 캐시 입력 | 지연 |
|---|---:|---:|---:|---:|---:|
| 차갑고 거친 Techno | 80 → 36 | 1,567 | 5,516 | 0 | 55.596초 |
| 따뜻하고 깊은 Techno | 80 → 36 | 1,798 | 5,005 | 1,246 | 48.919초 |
| 복잡하고 조성적인 Hard Bop | 80 → 36 | 1,793 | 5,266 | 1,246 | 52.721초 |

3회 총 입력 5,158 / 출력 15,787 / 전체 20,945 tokens. 출력 중 추론 토큰은 각각 1,967 / 1,546 / 1,618이며 출력 수치에 이미 포함된다. 실제 금액은 계정의 모델 요율과 cache-write 요율을 적용해야 한다. 이를 저렴한 로컬 생성이나 0토큰이라고 표시하지 않는다.

일반 재생은 약 1.6–2초마다 1개 문구를 표시한다. 풀 소진 속도와 실제 약 50초 API 지연을 함께 고려하면 안정적인 4분 곡은 대략 2–3회 요청을 예상할 수 있으나, 장르/구간 변화·네트워크·캐시·재생 길이에 따라 달라진다. 이는 장기 실청 측정값이나 비용 보장이 아니다. 생성 대기에는 이미 본 문구가 재사용될 수 있다.

공식 호출 규격: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). OpenAI Docs를 사용해 구조화 출력·접두부 캐시 형식을 확인했다.

## 실제 Semantic Snapshot schema

`level`은 `very low | low | medium | high | very high | unknown`. 없는 측정은 `unknown`으로 남긴다. 아래는 구현된 필드 구조이며 측정값을 꾸민 예시가 아니다.

```text
{
  genreFamily: string,
  primaryGenre: string | null,
  subgenreCandidates: string[0..4],
  confidence: number,
  rhythm: { tempo, pulseRegularity, onsetDensity, complexity, brokenPulse },
  harmony: { tonalFocus, harmonicMotion, pitchUncertainty },
  timbre: { brightness, warmth, roughness, noisiness, transientEdge },
  texture: { density, sustain, granularity, layeredness },
  dynamics: { range, compression, pumping },
  space: { spaciousness, depth },
  production: { subWeight, saturation, cleanVsLoFi, masterBrightness },
  mood: string[],
  currentSection: { state, novelty, buildup, breakdown, repetition },
  distinctive: { basis, genreRelativeAvailable: false, statements: string[0..8] },
  fingerprint: string // browser cache/debug only; omitted from model input
}
```

실제 전송한 스냅샷은 [검증 JSON](language-live-report.json)의 각 `results[].snapshot`에서 확인할 수 있다. `spaciousness`와 `depth`를 비롯한 Track Character 값은 기존 DSP/ML 기반 proxy이며, stereo width나 reverb type을 새로 측정한 것이 아니다.

## Distinctive Track Analysis

검증된 장르별 통계 기준선은 없다. 따라서 ‘일반적인 Jungle보다 따뜻하다’ 같은 주장은 생성하지 않는다. 현재 특성의 강한/약한 축을 절대적 두드러짐으로 기술하고, 관측 8개 이상일 때만 이 세션의 최근 36개 관측 평균과 비교한다. 상대 문장에는 `this session's recent baseline`을 명시한다. 새 곡에서 이 비교 이력은 초기화한다. 장르 상대 distinctiveness가 구현됐다고 주장하지 않는다.

## Generator prompt

Track Character → 정직한 distinctive 특징 → 현재 구간 → subgenre → mood → broad genre 순으로 중요도를 둔다. 장르별 사전에서 단어를 꺼내지 않는다.

관습적인 시 대신 물체·재질·공간·운동·온도·압력·광학·신체·환경의 순간적 이미지를 요청한다. 음악 해설, 장르명, 상투적 음악 어휘, 감성적인 AI 시구, 최근 문구의 형용사 교체, 무작위 연상을 금지한다. 음악적 근거에 맞는 2–4개 world를 스스로 고르고 최근 world도 고려한다.

9개 perspective, 약 28 single / 30 fragment / 14 nominal / 8 micro 후보를 요청한다. 후보마다 5개 rating과 실제 스냅샷 필드 경로 1–2개를 받는다. reasoning이나 설명문은 UI에 표시하지 않는다.

## Critic

서버에서 응답 전체와 후보 shape를 검증한 뒤 브라우저의 별도 Web Worker가 선별한다.

- 자기평가의 musical fit, specificity, originality, image strength, Korean naturalness와 간단한 semantic richness를 가중 평가한다.
- 근거 경로가 실제 스냅샷에 존재하는지 확인한다. 이는 의미적 인과를 증명하는 평가기는 아니다.
- 상투어, 일반 기본어, 음악 해설, 장르/악기 literal, 너무 긴 문구, 깨진 문자열, 최근 exact/near duplicate를 거른다.
- 한글 bigram 유사도, 문법 패턴, 반복 명사 어간, perspective/type 분포에 따라 탐욕적으로 다양성을 재정렬한다.
- `의/속의/너머/아래/위의` 패턴과 micro-line 상한을 적용한다. 25개 미만이면 약한 배치를 억지로 채택하지 않고 현재 풀을 유지한다.

독립적인 언어 이해 모델로 점수를 검증한 것은 아니다. 자기평가 + 투명한 로컬 휴리스틱이므로 심미적 품질과 미묘한 한국어 어색함은 `L` 패널의 사람 평가가 필요하다.

## 실제 생성 출력

아래는 코드에 하드코딩한 문구가 아니라 실제 Sol 응답을 현재 Critic에 통과시킨 결과에서 그대로 발췌했다. 입력은 실곡이 아닌 통제된 의미 프로필이다.

- 차갑고 거친 Techno: `압연`, `방폭문`, `과노출 윤곽`, `갈비뼈 압박`, `형광관이 한 장면만 되풀이한다`
- 따뜻하고 깊은 Techno: `수온약층`, `환류`, `온기가 고인 석조 홀`, `해저에 보관된 오후`, `벽은 멀어져도 기척을 되돌린다`
- Hard Bop: `열구배`, `반사궁`, `정교한 혼잡`, `셔터마다 달라지는 각도`, `작은 바퀴들이 서로 앞질러 붙는다`

두 Techno 프로필의 선별 문구 near-duplicate 중복률은 0%, 첫 Techno와 Hard Bop은 2.8%였다. 이전 출력 회피 이력도 입력했으므로 이 결과만으로 Track Character의 순수 인과 효과나 실제 음악 적합도를 입증하지 않는다. [원본 기록](language-live-report.json)에 전체 선별 문구, 점수, 유형, 근거, 토큰 사용량이 있다.

## 세션 안전과 화면

새 세션은 현재 풀·아트 디렉션·track cache를 초기화한다. 이전 요청이 끝나도 session/epoch를 재검사하고 버린다. 응답 후 Worker 선별 중 바뀐 세션도 다시 검사한다. 이전 세션의 네트워크 슬롯이 끝나기 전 새 요청을 겹치지 않는다.

epoch 변경 시 기존 화면 단어는 0.5–1.5초 fade. 새 생성에 시간이 걸리면 이전 풀을 잠시 유지하되 5초 이후에는 현재 Track Character의 대체 풀로 전환한다. 이미 유용한 분석이 있을 때 중립 기본 단어로 되돌아가지 않는다.

미사용 문구 우선, 점수·최근 사용·perspective·길이·형태에 따른 가중 선택을 사용한다. single은 조금 크게, micro는 작고 느리고 드물게 표시한다. 속도는 각 문구가 생성될 때 결정되고 이동 중 일정하다. 긴 문구는 viewport 너비를 넘지 않도록 축소하며 화면 통과 시간을 최대 수명에 반영한다.

## 성능과 테스트

오디오/DSP/draw/music ML은 언어 응답을 기다리지 않는다. 네트워크는 비동기이고 생성 후보의 주요 비평 작업은 별도 Worker에서 실행한다. 작은 시작·실패 대체 풀은 메인 스레드에서 한 번 계산된다. 기존 PCM batching/ML Worker 경로는 변경하지 않았다.

- `npm test`: **72/72 통과**.
- `npm run check`: application/script 52개 파일 구문 검사 + **72/72 테스트 통과**.
- `npm run test:model`: 실제 MP3 3개, encoder/악기/무드 출력 shape·finite·입력 의존성 통과.
- `npm run test:language:live`: 네트워크 허용 환경에서 실제 Sol 3회, 각 80→36 선별, 중복률 검사 통과. 이 명령은 유료이며 명시적으로 실행해야 한다.
- 브라우저: 시작 화면의 모드 선택, `L` 평가 패널 표시, 👍 저장·취소 확인(시험용 평가를 취소해 정리). 음원 선택 작업은 긴 대기와 사용자 화면 변화가 있어 성공 판정하지 않았다. 별도 화면 공유 시도에는 오디오 트랙 없음/사용자 권한 거부 로그가 있었다.

## 남은 제한과 다음 검증

1. 실제 같은 장르의 서로 다른 두 곡, 여러 장르 실청, 장시간 미학적 반복 여부는 아직 사람 평가가 필요하다. 자동 fixture 비교를 이 수용시험의 완료로 포장하지 않는다.
2. 첫 생성 지연 약 49–56초. 대체 문구로 재생은 유지하지만 짧은 곡/빠른 전환에서는 생성 결과가 늦거나 폐기될 수 있다.
3. 장르 상대 기준선, 신뢰도 검증된 언어 임베딩 Critic, 완벽한 한국어 문법 판정은 없다.
4. API 오류/키 부재/권한 문제에는 로컬 템플릿 대체 경로가 보인다. `L` 패널이 실제 provider를 명시한다.
5. `.env.example`에 있던 실제 키 형태의 값을 예시값으로 교체했다. 실행용 `.env`는 변경하지 않았다. 예제 파일이 외부에 공유된 적 있다면 해당 키를 교체하는 것이 좋다.
