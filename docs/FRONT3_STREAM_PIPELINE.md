# front3 실시간 최종 단어풀

front3의 `탭 오디오 연결`에서 SoundCloud 탭과 오디오 공유를 선택한다.
프론트는 mono Float32 PCM(16 kHz)을 `/ws/music-shower`에 전송한다.
Music Shower의 별도 페이지나 iframe을 열어 둘 필요가 없다.

백엔드는 연결마다 `RealtimeMusicSession`을 만든다. 실제 PCM의 RMS·스펙트럼·시간 변화를
기존 MusicExpressionEngine에 전달하고, 실제 청취 12초 뒤 첫인상 분석을 요청한다.
이후 45초 청취 간격으로 최신 30초를 Flamingo에 보낸다. 한 요청이 진행 중이면
최신 대기 창 하나만 유지한다. 무음은 청취시간과 캡처에 누적하지 않는다.

Flamingo 응답은 DirectAudioReview와 FlamingoWordReservoir를 거친다. 한국어 표현이
준비되는 시점에도 재선별한다. 프론트에 전달하는 값은 간이 PCM 분석기의 문구가 아니라
공유 SemanticCandidatePipeline → SemanticFacetManager → LanguageCritic → PhrasePool.Engine.snapshot()의 최종 결과다.
서버는 설치된 ONNX 장르·악기 모델도 별도 작업 스레드에서 실행한다. 3초 청취 간격으로
최신 2.1초를 분석하고 기존 시간 집계·확신 보정·악기 이벤트 엔진을 적용한다.
분류 라벨은 모델 메타데이터를 사용한다. Flamingo는 분류 결과를 보지 않고 독립적으로 듣고,
이후 기존 GenreHypotheses가 두 출처를 대조한다. 브라우저 전용 고급 MIR 전체를 이식한 것은 아니다.

## 소켓 계약

- 서버 `ready` → 클라이언트 `start`(sampleRate, channels:1, format:f32le) → 서버 `started`.
- `started` 이후 PCM 전송. 재접속하면 새 세션으로 협상하고 이전 화면 풀을 비운다.
- 서버 `features`: streamId, trackEpoch, live, features. 배경 효과용 수치는 의미 근거와 분리한다.
- 서버 `word_pool`: poolSource:`music-shower-final`, streamId, trackEpoch, revision,
  live, tokens, analysis(status, localModel, activeAudioMs, captures, concepts, error).
- 각 토큰은 text, layer, type, glow와 가능한 출처 정보를 포함한다.
- front3는 풀 전체를 교체한다. 기존 메시의 이동은 완주하지만 다음 생성에는 새 풀만 사용한다.
- 실제 표시 후 `word_used`(text, trackEpoch)를 보내 반복 페널티와 한국어 표현 순환에 반영한다.
- `playback`의 event는 TRACK(identity), PLAY, PAUSE, FINISH, RESTART를 받는다.
  명시적 `track_changed`도 지원한다. TRACK의 identity 변경은 새 trackEpoch와 빈 풀을 보낸다.
- PAUSE/FINISH/무음은 풀을 보존하고 생성을 멈춘다. RESTART는 같은 곡의 풀을 보존하고
  캡처 버퍼와 진행 중 요청만 새로 시작한다. 이전 곡의 지연 응답은 폐기한다.

탭 오디오 공유 자체에는 곡 ID·재생 이벤트가 없다. 해당 탭에 연결된 기존 확장 프로그램의
SOUNDCLOUD_EVENT를 front3가 받으면 서버로 전달한다. 이벤트 연결이 없는 일반 탭 공유에서
정확한 곡 변경을 알아낸다고 가정하지 않는다. 이 경우 다른 곡으로 바꿀 때 탭 연결을 다시 시작한다.

기존 `/api/live-word-pool`은 구 Music Shower 페이지용 진단 스냅샷이다. 여러 방문자의 풀이
섞이지 않도록 front3의 실시간 세션은 이 전역 스냅샷을 구독하지 않는다.

front3 오디오 패널의 **단어 생성 상태 · 최종 풀**에서 청취 시간, Flamingo 캡처·개념 수,
장르·악기 모델 상태, 최종 선택된 문구와 레이어를 확인한다. 🦩는 Flamingo 출처이다.

## 검증

`node --test test/realtimeMusicSession.test.js test/realtimeAudioSocket.test.js`는 PCM 입력,
모델/번역 모의 응답, 실제 최종 선별기, 소켓 전송, 정지/재시작/곡 변경/지연 응답을 검사한다.
실제 모델의 청감 품질은 이 테스트로 평가하지 않는다.

`node --test test/streamModelService.test.js`는 설치된 ONNX 모델을 실제 실행한다.
`node scripts/smoke-front3-stream.cjs`는 front3 프록시를 통해 실제 테스트 음원을 보내고
Flamingo·한국어 실현·최종 선별이 완료되는지 검사한다(두 백엔드 실행 필요).

개발 화면 `http://localhost:5173/?audioFixture=1`의 오디오 탭에는 전체 연결 검증 버튼이
추가된다. 저장된 실제 테스트 음원을 같은 소켓과 화면에 흘려보내며 단어 응답을 모의하지 않는다.
검증 종료 버튼으로 중지한다. 이 제어는 개발 모드에서만 존재하고 배포 빌드에는 포함되지 않는다.

2026-09-09 로컬 브라우저 검증: 실제 테스트 음원으로 Flamingo 캡처 1회·개념 10개,
한국어 AESTHETIC/IMPRESSION/FACT 및 실시간 최종 풀 15개 수신과 3D 단어 표시를 확인했다.
SoundCloud 공유 권한 선택창 자체를 자동화한 검증은 아니다.

## 근거 기반 연상 단어 (문화 · 시대 · 시각 이미지 · 미학)

원칙은 `docs/SEMANTIC_OWNERSHIP.md`의 "근거 기반 외부 연상"을 따른다.

1. Flamingo 프롬프트는 `styleCues`(시대·장면을 연상시키는 소리 특징 자체)를 받는다. 생성 한도는
   1024토큰이다. 512토큰에서는 로그상 전체 청취 21회 중 14회가 JSON이 닫히기 전에 끊겼다.
2. 캡처가 한국어로 실현된 뒤, 또는 장르 해상도 단계가 바뀔 때 `lib/groundedAssociation.js`가
   외부 언어 모델을 한 번 호출한다. 입력은 장르 가설·분류기 예측·Flamingo 개념·스타일 단서뿐이며,
   모든 단어는 근거 ID를 인용하고 서버가 검증한다.
3. `analysis.association`에 해상도 단계, 호출·제안·채택·탈락 사유, 스타일 단서, 분류별 단어가 실린다.
   front3 상태 패널이 분류별로 보여준다.
4. 화면 풀에는 `family` 이상 구체성이고, 인용한 장르가 아직 현재 가설에 남아 있는 단어만 들어간다.
   `MUSIC_SHOWER_ASSOCIATIONS_ON_SCREEN=0`이면 상태 패널에만 남는다. 토큰에는 `category`와
   `textEn`이 실리고, front3의 "분류 이름 표시"를 켜면 단어 아래에 분류 이름이 표시된다.

평가(2026-09-13, 트랙 4개 · 캡처 3회씩, `scripts/measure-word-diversity.cjs` →
`scripts/evaluate-associations.cjs`): 근거 유효율 97–100%, 서로 다른 트랙 간 단어 겹침(Jaccard)
0–0.04, 블라인드 LLM 범용성 점수(0=장르 특정, 1=어디에나 맞음)는 `family` 단어 0.12–0.32,
`broad` 단어 0.58–0.71. 네 트랙 모두 분류기와 Flamingo가 같은 장르로 수렴하지 않아 `specific`
단계에는 도달하지 않았다.
