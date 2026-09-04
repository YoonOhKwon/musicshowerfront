# Music Shower — Focus 4 Language Upgrade

이 문서는 이전 설계 초안입니다. 현재 구현과 검증 결과는 [Music Language Engine 업그레이드 보고서](MUSIC_LANGUAGE_UPGRADE.md)를 참고하세요. 아래의 80개 후보·시적 보조 표현 설계는 더 이상 사용하지 않습니다.

단어 생성은 네 개의 음악적 축에 집중한다.

1. `genre`: 현재 장르/서브장르 정체성
2. `live`: 현재 구간에서 실제로 변하는 리듬·어택·서스테인·화성 이동·밀도·전환
3. `dynamics`: 체감 음압·다이내믹 레인지·압축·펌핑·피크·드롭 강도
4. `mood`: arousal/valence/tension/warmth/spaciousness 조합으로 만든 분위기

## 구조

- `MusicExpressionEngine`: 브라우저에서 500ms semantic tick마다 즉시 갱신되는 로컬 표현층. AI API 응답을 기다리지 않는다.
- `languageService`: Sol이 80개 후보를 만들 때 모든 후보에 `category`를 강제하고 네 축에 맞는 비율로 생성한다.
- `LanguageCritic`: 네 카테고리를 보존하며 다양성을 조절한다. `genre`에 한해 Techno/Jersey Club 같은 표준 영문 장르명을 허용한다.
- `PhraseSelection`: genre/live/dynamics/mood를 우선 노출하고 동일 카테고리 연속 출현은 완만하게 억제한다.
- `SemanticSnapshot`: dynamics에 `loudness`, `impact`, `drop`을 추가해 생성형 언어에도 체감 세기 정보가 전달된다.

## 목적

기존의 재료·건축·광학 중심 시적 이미지 생성은 보조 수단으로 낮추고, 화면에 나타나는 언어가 곡의 장르와 현재 음악 상태를 즉시 읽을 수 있게 한다.
