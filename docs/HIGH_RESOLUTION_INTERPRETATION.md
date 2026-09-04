# Music Shower — High Resolution Music Interpretation Upgrade

## 1. 현재 분석 한계

Music Shower는 짧은 혼합 음원에서 스펙트럼, 온셋, 리듬, 임베딩, 넓은 악기 클래스와 장르 확률을 읽는다. 스템 분리, 개별 연주자 추적, 녹음 연도·장소·아티스트 식별은 하지 않는다. 따라서 세션 악기의 개별 음정 궤적, 정확한 연주자 수, 실제 제작 기법, 실제 문화권은 확정할 수 없다. 화면 언어는 관측, 조건부 스타일 연상, 확인 불가를 구분한다.

## 2. 14개 음악 의미 축

기존 네 축을 `genre, lineage, rhythm, instrumentation, performance, arrangement, production, dynamics, mood, era, scene, culture, association, live`의 열린 체계로 확장했다.

AI 스키마에서 고정 형용사 enum을 제거했다. 각 후보는 `text/category/confidence/kind/role/anchors`를 가지며, 짧고 실제로 쓰이는 음악·문화 용어만 허용한다. 빈 배열은 정상 결과다.

## 3. 장르 맥락 엔진

장르 지식은 코드의 조건문이 아니라 [genreContextKnowledge.json](../data/genreContextKnowledge.json)에 둔다. 현재 장르 확신도 0.75 이상, 가청 신호, 서로 다른 두 종류 이상의 현재 음향 근거가 모두 맞아야 후보가 열린다. 장르 이름만으로 관련 태그를 전부 붙이지 않는다.

Future Funk, City Pop, UK Garage는 회귀 fixture일 뿐 특례 구현이 아니다. 21개가 넘는 다른 장르에도 같은 규칙 엔진을 쓰며, 데이터에 없는 새 장르는 열린 AI 스키마와 동일한 critic을 통과할 수 있다.

City Pop의 1970–80년대 일본, AOR/R&B/jazz fusion/funk/boogie/disco 맥락은 [Light in the Attic의 일본 아카이브 설명](https://lightintheattic.net/products/pacific-breeze-2-japanese-city-pop-aor-boogie-1972-1986)을 참고했다. Future Funk의 French House/nu-disco/vaporwave 계열 표기는 [Coraspect의 실제 Future Funk 컴필레이션](https://coraspect.bandcamp.com/album/this-is-future-funk-vol-1)을 근거로 했다. UK Garage의 런던 클럽·pirate-radio 맥락은 [Plastician의 Red Bull Music Academy 인터뷰](https://www.redbullmusicacademy.com/lectures/plastician-plasticman-grime-virtuoso/)를 참고했다. 이 자료는 후보 지식의 출처이지, 현재 재생 곡의 증거가 아니다.

## 4. 악기·솔로·연주 방식

모델 악기 결과는 짧은 시간 이력으로 저장하고 7초 뒤 만료한다. 이전 곡이나 오래된 구간의 악기가 누적되던 문제를 제거했다. 넓은 클래스가 0.35 이상일 때만 악기명, 0.65 이상이고 다음 후보와 충분히 벌어질 때만 “중심” 표현을 낸다. DSP 추측은 화면의 확정 악기 표현에 쓰지 않는다.

“등장/유입”은 낮은 과거 기준선 뒤 두 번 연속 높은 관측이 필요하다. “솔로”는 악기 확신도·우세 상승·반주 밀도 감소·멜로디 활동·음정 활동·온셋 활동이 함께 맞고 0.8 이상이어야 한다. “워킹 베이스”는 베이스 전용 음정 이동과 온셋 규칙성이 필요하다. 현재 혼합 음원 분석기는 베이스 전용 음정 궤적을 만들지 않으므로 이를 임의 생성하지 않는다. 정확한 trio/4인조 표기는 `verifiedEnsembleSize`가 없는 한 거절한다.

## 5. 시대·씬·아티스트 연상

시대는 녹음 연도가 아니라 “1970s–1980s 스타일”처럼 표시한다. 씬과 문화는 현재 장르 확신도와 다축 음향 근거를 필요로 한다. 아티스트 이름은 `kind=artist`, 0.82 이상의 별도 확신도, 장르·악기·프로덕션 근거가 있어야 하며 반드시 “연상/계열”로 끝난다. 이는 식별 결과가 아니다.

Anime/Y2K/Kawaii/마법소녀처럼 실제 문화 개념은 직접적인 `aestheticEvidence`가 0.75 이상일 때만 허용한다. 밝기나 장르 이름만으로 그런 미학을 만들지 않는다. 현재 오디오 분석만으로 직접 미학 근거가 없으면 비어 있다.

## 6. 환각 억제

- 모든 열린 용어는 2–6개 실제 스냅샷 경로와 독립 근거 그룹을 검사한다.
- null, 만료 이벤트, 바뀐 악기 인덱스, 다른 장르의 캐시를 재사용하지 않는다.
- live/production/performance 등 변동 축의 원격 후보는 12초 뒤 만료하며 현재 값과 다시 비교한다.
- sidechain, sample-based, vocal chop, stereo width, reverb는 전용 근거 0.7 미만이면 거절한다.
- pumping은 sidechain으로 승격하지 않는다.
- “필터 스윕”은 반복적인 중심 주파수 이동 조건을 만족해도 “필터 스윕 가능성”으로만 말한다.
- 임의의 시적 조합, UI 상태 문구, 실제 연도·장소·제작자 단정은 거절한다.

## 7. 수정한 핵심 파일

- `js/semantic/semanticFacets.js`: 열린 14축 계약과 증거 정책
- `js/semantic/semanticEvidence.js`: 작고 안전한 확장 스냅샷
- `js/semantic/instrumentationEventEngine.js`: 악기 이력·등장·우세·솔로 조건
- `js/semantic/rhythmicGrammar.js`: 4/4 킥·스윙·싱코페이션·브레이크비트 근거
- `js/semantic/genreContextEngine.js`: 일반화된 맥락 규칙 실행
- `js/semantic/semanticFacetManager.js`: 축별 중요도 순환과 중복 억제
- `js/semantic/semanticSnapshot.js`, `semanticEngine.js`, `languageCritic.js`, `phrasePoolEngine.js`
- `lib/languageService.js`: 열린 구조화 출력 v3
- `js/visual/backgroundAudioMapper.js`, `background.js`, `visualEngine.js`, `main.js`
- `test/highResolutionInterpretation.test.js`

## 8. 새 데이터

`data/genreContextKnowledge.json`은 출처, 별칭, 후보, 필요한 현재 근거, 확신도 상한을 담는다. Future Funk/City Pop/UK Garage 외 House, Techno, French House, Vaporwave, Jazz Funk, Jazz Fusion, Neo Soul, IDM, Drum & Bass, Jungle, Footwork, Trap, Dubstep, Ambient, Synthpop, Shoegaze, Folk, Metal, Bossa Nova, Classical 등을 포함한다.

이 목록은 완전한 음악 백과사전이 아니다. 새로운 장르를 막는 whitelist가 아니며, 로컬 prior가 없는 장르는 AI가 같은 근거 계약으로 제안한다.

## 9. 제거한 UI

최종 재생 장면의 구체 오브, 파형, 비트 전경 파티클을 제거했다. 일반 모드에서는 배경과 떠다니는 음악 용어만 보인다. HUD, 모델 상태, 장르 패널은 `D` 디버그 모드에서만 그린다. 중지 버튼은 접근성을 위해 유지하되 평소에는 낮은 불투명도이고 hover/focus/mobile에서 분명히 보인다.

## 10. 배경 반응

기존 radial sine beat ripple을 삭제했다. 킥/저역 트랜지언트는 noise field의 비대칭 방향 벡터를 밀어 유기적인 deformation을 만든다. impact envelope는 약 28ms로 빠르게 상승하고 약 520ms로 천천히 풀려 점성 있는 반응을 만든다. 저역은 큰 변형, 중역은 윤곽, 고역은 미세 shimmer를 계속 담당한다. WebGL 실패 시에도 전경 이펙트가 아니라 느린 유기 배경만 표시한다.

## 11. 테스트

`npm run check` 기준 166개 자동 테스트가 통과한다. 새 테스트는 열린 14축, 세 핵심 장르의 조건부 맥락, 약한 근거의 빈 결과, 미등록 장르 일반 경로, 악기 이력·등장·솔로 조건, walking bass/synth lead 억제, 시간적 4/4 킥, 원형·관용어, Shared PCM fallback, Floating Word 완주, 확장 스냅샷, 전경 UI 제거, radial ripple 제거와 킥 deformation을 검증한다.

실제 MP3 3개를 해석하는 기존 통합 테스트도 유지한다. 유료 원격 AI 호출은 테스트에서 실행하지 않는다.

## 12. 조건별 예상 출력

| 조건 | 가능한 출력 | 억제되는 출력 |
|---|---|---|
| Future Funk + 안정 4/4 + 신스 | Future Funk, French House 계열, 4/4 킥, 신스 중심 | 마법소녀 미학 |
| Future Funk + sample 근거 + 따뜻한 정서 | Vaporwave 계열, 인터넷 리바이벌 씬 | 특정 곡·아티스트 식별 |
| City Pop + 피아노 + syncopation | City Pop, Jazz Funk 계열, 일본 City Pop 씬 | 정확한 발매 연도 |
| UK Garage + broken beat + 저역 | UK Garage, 2-Step 계열, UK 클럽 씬 | 조건이 안 맞는 문화 태그 |
| 피아노 우세만 있음 | 피아노, 피아노 중심 | 피아노 솔로, 피아노 트리오 |
| 우세 상승 + 반주 감소 + 멜로디/음정/온셋 근거 | 피아노 솔로 | 연주자 이름 |
| 베이스 존재만 있음 | 베이스 | 워킹 베이스 |
| 펌핑만 있음 | 강한 펌핑 | 사이드체인 |
| 중심 주파수가 일관되게 움직임 | 필터 스윕 가능성 | 실제 필터 장비 단정 |
| 장르 확신도 낮음 | 현재 리듬·음색·다이내믹 | 시대·씬·문화·아티스트 연상 |

핵심 원칙은 “쓸 수 있는 용어를 늘리되, 출력할 수 있는 순간은 더 엄격하게 제한한다”이다.
