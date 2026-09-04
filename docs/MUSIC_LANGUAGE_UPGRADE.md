# Music Shower — Music Language Engine 업그레이드

2026-09-04 · Build: 2026.09.04.music-language.2

## 1. 발견한 기존 문제

- MusicExpressionEngine 초안에 과열된 긴장, 저중력 부유, 압착된 밀도 같은 조어가 존재했지만 HTML에서 모듈을 로드하지 않았습니다.
- 실제 화면은 PhrasePool의 시적 로컬 조합기와 AI 후보를 사용했습니다. AI는 80개 후보를 요구하며 음악 용어와 장르명을 금지했습니다.
- Critic은 영문 장르명·직접적인 음악 설명을 거부하고 독창성과 이미지 강도에 점수를 주었습니다.
- 무음에 가까운 RMS 샘플을 버려 조용해진 뒤에도 과거 큰 음량의 통계가 남았습니다.
- 스펙트럼 crest를 시간영역 crest factor처럼 사용했습니다. 안정된 신호를 압축으로 과도하게 추정했습니다.
- 스펙트럼 밝기에 시각화용 로그 스케일 byte FFT를 사용했습니다. 이를 물리적인 선형 대역 에너지와 구분하지 않았습니다.
- AI 요약은 정성적 수준 위주여서 현재 피크·RMS·변화량·관측 기간을 전달하지 않았습니다.

## 2. 변경한 구조

기존 AudioWorklet / Meyda / 로컬 ML / 다중 주기 스케줄러를 유지했습니다.

Audio Capture → 현재 파형·선형 스펙트럼 측정 → 500ms FeatureHistory

- 실시간 경로: MusicExpressionEngine → LIVE / DYNAMICS / 일부 MOOD
- 선택적 AI 경로: 20~45초 의미 요약 → GENRE / MOOD 및 현상 후보
- 합류: PhrasePool(표현 관리자) → 현재 상태 Critic → 카테고리별 선택 → FloatingWord

AI는 화면의 시작 조건이 아닙니다. 시적 사전·기존 생성기 파일은 호환성과 이전 기록을 위해 남겨 두었지만 FloatingWord의 단어 공급원에서 제외했습니다.

## 3. 변경한 파일

- 분석: js/audio/audioFeatures.js, js/audio/beatDetector.js, js/semantic/trackCharacterEngine.js
- 실시간 엔진·연결: js/semantic/musicExpressionEngine.js, js/semantic/semanticEngine.js
- 단어 관리·평가: js/semantic/phrasePoolEngine.js, js/semantic/languageCritic.js, js/semantic/languageWorker.js
- AI 연결: js/semantic/semanticSnapshot.js, lib/languageService.js, server.js
- 표시·진단: js/visual/phraseSelection.js, js/visual/visualEngine.js, js/ai/aiProfiler.js, js/semantic/languageInspector.js, index.html
- 테스트: test/realtimeLanguage.test.js, test/audioExpressionIntegration.test.js, test/languagePipeline.test.js, test/musicExpressionEngine.test.js, test/phrasePool.test.js, test/serverRequest.test.js, test/fixtures/languageProfiles.js
- 검증 도구·문서: scripts/language-smoke.cjs, README.md 및 이 보고서와 이전 언어 문서의 버전 안내

배경 셰이더·파티클·오브·FloatingWord 이동 애니메이션·캡처 시작 흐름은 재작성하지 않았습니다. 기존 stale fade를 사용해 더 이상 맞지 않는 단어만 퇴장시킵니다. 화면 안내 문구와 평가 패널 설명은 새 동작에 맞게 고쳤습니다.

## 4. 단어 생성 방식 변화

- 네 카테고리만 사용합니다. LIVE/DYNAMICS/MOOD는 검토된 짧은 표현 목록에서 관측 조건에 맞는 항목을 선택합니다. 무작위 형용사·명사 합성을 하지 않습니다.
- 차분함, 긴장감, 차가움, 몽환적 같은 일반적인 표현을 허용합니다. 서로 다른 성질은 독립적으로 표시합니다.
- Jersey Club, UK Garage, 2-Step, IDM, Footwork, Neo Soul, Drum & Bass, Art Pop 같은 영문 장르 표기를 허용합니다.
- 장르의 이웃 검색 점수는 확신도로 승격하지 않습니다. AI가 새 장르를 보강하려면 충분한 관측 기간·확신도·서로 다른 분석 축의 유효한 근거 필드가 필요합니다.
- AI 응답 스키마는 genre/live/dynamics/mood 배열입니다. genre에는 confidence, primary/secondary/adjacent 역할, 근거 필드를 포함합니다.
- Critic은 음악 관련성·현재 상태·명료성·자연스러움·구체성을 우선합니다. 독창성 점수나 후보 최소 개수는 요구하지 않습니다.
- 높은 음압/큰 음압, 긴장감/긴장됨/긴장된 분위기는 같은 의미로 정규화합니다. 이미 화면에 있는 동의어는 다시 띄우지 않으며 최근 사용은 확률만 낮춥니다.
- 기본 선택 비율은 GENRE 18%, LIVE 37%, DYNAMICS 22%, MOOD 23%입니다. 변화가 크면 각각 10%, 43%, 29%, 18%로 조정합니다. 빈 카테고리는 제외합니다.
- AI 결과 중 LIVE/DYNAMICS는 표시 시점의 실측이 우선합니다. 늦게 도착한 높은 에너지 묘사가 현재의 조용한 구간을 덮어쓰지 못합니다.

## 5. 실시간 반응 방식과 한계

- 렌더 루프와 분리된 500ms 작업에서 Float32 파형과 FFT를 측정합니다. typed array를 재사용합니다.
- 시간영역 RMS, sample peak, crest factor dB를 계산합니다. FFT의 dB를 선형 진폭으로 바꿔 centroid, flatness, 저/중/고역 에너지 비중을 계산합니다.
- 최근 2.5초 기준으로 RMS·peak·centroid·flux·각 대역·트랜지언트 밀도·에너지 변화량을 계산합니다. 단기 다이내믹 범위 변화도 유지합니다.
- 음압·에너지 상승/하강, 저역 유입/감소, 촘촘해진 리듬, 드롭 진입을 현재 조건으로 선택합니다. 무음에서는 과거 장르·강한 에너지·분위기 단어를 제거합니다.
- 이력은 최대 45초/90개, 화면 풀은 최대 40개, 최근 단어는 최대 32개, 사용 기록은 최대 96개, 클라이언트 캐시는 16개입니다.
- API는 20초 관측 후 시작하고 최소 45초 간격, 단일 요청, 세션/구간 ID, 60초 신선도 검사 및 표시 직전 현재 상태 재평가를 적용합니다.
- 실측 숫자와 변화량, chroma, 템포 안정도, 20~45초 요약, 8개 분위기 축을 AI 입력 검증을 거쳐 전달합니다. 원본 PCM과 임베딩은 이 경로로 전송하지 않습니다.

주의: 음압은 캡처된 디지털 레벨에 대한 설명이며 실제 청취 SPL이 아닙니다. shortTermLoudnessDb는 최근 최대 6초 RMS 기반의 비가중 dBFS proxy이며 LUFS 측정이 아닙니다. 압축·펌핑·공간감·화성·분위기는 휴리스틱/모델 추정입니다. 압축 근거가 부족하면 unknown으로 유지하며 저 crest의 정현파를 강한 압축으로 단정하지 않습니다. 킥 위치·하이햇·정확한 스윙·세부 장르를 BPM만으로 생성하지 않습니다.

## 6. 테스트 결과

- npm install --ignore-scripts --no-audit --no-fund: 성공, 기존 의존성 최신 상태. 새 패키지 추가 없음.
- npm test: 90개 통과, 0개 실패.
- npm run check: 애플리케이션/스크립트 53개 문법 검사와 전체 테스트 통과.
- npm start: 성공. /api/health에서 ok=true 및 새 빌드 번호 확인.
- npm run test:model: 실제 outfoxing.mp3, horns.mp3, drums.mp3 세 파일에서 모델 출력의 유한성·형태·입력별 차이 확인.
- 새 실제 음원 통합 테스트: 세 MP3를 디코딩하여 RMS/peak → 이력 → 단어 풀 경로를 AI 없이 검증했습니다.
- 브라우저: 로컬 전용 모드에서 outfoxing.mp3와 drums.mp3를 선택·재생했습니다. 단어/평가 패널 표시, 영문 장르 표기, 측정값 전달, 재생 종료 후 초기화와 오류 로그 없음 확인.
- 합성 상태 테스트: 한 샘플 안의 에너지 상승·하강·저역 유입·드롭, 무음, 조용한 구간, 20초 전 로컬 출력, API 지연·실패·다른 세션·늦은 같은 구간 응답, 오래된 응답 거부, 범주 비율·동의어·정확한 반복·기록 상한 검증.

검증하지 않은 범위: 새 스키마의 실제 유료 AI 호출은 실행하지 않았습니다(서비스/응답/실패 처리는 모의 응답으로 검사). 브라우저 디버그의 한 시점 60 FPS 표시는 확인했지만 장시간 FPS 비교나 여러 장비의 부하 검증은 하지 않았습니다. 모델 테스트는 장르 정답률이나 분위기의 청감 적합성을 보증하지 않습니다. 필요하면 선택적 npm run test:language:live로 유료 AI 왕복을 별도로 검증할 수 있습니다.
