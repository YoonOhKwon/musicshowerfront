# Music Shower V2.1 Procedural Background

## 시각 언어

참조 이미지의 정적 픽셀을 복제하지 않고 다음 규칙을 실시간 그래픽 문법으로 해석합니다.

1. 작은 RGB triad와 scanline으로 CRT/디더링 표면을 만든다.
2. domain-warped noise와 반복 등고선으로 liquid/topographic 깊이를 만든다.
3. 상단은 검은 자주색, 하단은 자홍·적색·주황으로 상승하는 열감 축을 둔다.
4. 중앙 오브와 텍스트 영역은 luminance를 눌러 전경 레이어의 대비를 확보한다.
5. 모든 오디오 입력은 시간 상수 기반 smoothing을 거쳐 급격한 플리커를 막는다.

## 오디오 매핑

| 입력 | 배경 반응 | 의도 |
|---|---|---|
| bass | 저주파 domain warp와 하부 displacement | 큰 질량과 압력 |
| mid | contour 밀도와 경계 강도 | 음악적 구조 |
| highs | RGB phase와 micro shimmer | 고역의 섬세한 광택 |
| beat | 짧은 전역 pulse와 원형 ripple | 박자의 순간성 |
| novelty | turbulence와 흐름 속도 | 구간 변화와 예측 불가능성 |
| tension | warp의 불규칙성 | 긴장과 마찰 |
| warmth/arousal | 열감·발광량 | 곡의 정서적 온도 |
| spaciousness | haze와 깊이 | 공간감 |
| genre family | 규칙성·운동 방향·왜곡 비율 | 장르별 움직임 문법 |
| Track Character | roughness·granularness·breakbeat·depth·compression | 같은 장르 안의 곡별 차이 |

## 레이어와 충돌 방지

배경은 가장 낮은 레이어이며 오브, 파티클, 파형, 구름 채팅 단어보다 명도와 선명도가 낮습니다. 셰이더의 center mask가 중앙을 감쇠하고 가장자리와 화면 하부에 열감을 집중시킵니다. 따라서 배경이 살아 움직이면서도 의미 정보와 경쟁하지 않습니다.

## 적응형 품질

거버너는 짧은 순간의 프레임 흔들림에는 반응하지 않고 지속적인 FPS 저하 또는 높은 모델 지연에서만 한 단계씩 낮춥니다.

| 단계 | 내부 렌더 스케일 | 프레임 간격 | 의미 분석 영향 |
|---|---:|---:|---|
| high | 0.80 | 매 프레임 | 선택한 품질 모드 유지 |
| medium | 0.64 | 매 프레임 | 모델·단어 갱신 간격 완화 |
| low | 0.50 | 2프레임마다 | 느린 의미 작업 추가 완화 |

성능이 충분한 시간 동안 회복되면 단계적으로 원래 품질로 돌아갑니다. WEBGL 셰이더가 실패하면 CPU 기반 열감 그라디언트를 사용하며 오디오·단어·오브 파이프라인은 계속 실행됩니다.

WebGPU 음악 추론이 진행 중인 짧은 구간에는 내부 품질 단계를 계속 resize하지 않고 배경을 매 2프레임 갱신하며 직전 텍스처를 재사용합니다. 오브·파형·단어 등 전경 반응은 이 제한을 받지 않습니다.

## 디버그 관측값

`D` 키로 `shader/fallback`, 품질 단계, heat, turbulence, shimmer와 FPS·모델 지연을 함께 확인할 수 있습니다. 이 값은 시각 효과가 실제 DSP/semantic 상태에 연결되었는지 검증하는 용도이며 기본 화면에서는 숨겨집니다.
