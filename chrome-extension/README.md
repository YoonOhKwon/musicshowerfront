# Music Shower · SoundCloud Tab Bridge

## 설치

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 오른쪽 위 `개발자 모드`를 켭니다.
3. `압축해제된 확장 프로그램을 로드합니다`를 누릅니다.
4. 이 `chrome-extension` 폴더를 선택합니다.

## 사용

1. `http://localhost:3000`에서 Music Shower를 열어 둡니다.
2. 별도 SoundCloud 탭에서 공개 트랙을 엽니다.
3. SoundCloud 탭에서 확장 프로그램 아이콘을 누릅니다.
4. 아이콘의 `…`는 연결 확인 중, `ON`은 오디오 스트림 연결 완료, 초록색 `LIVE`는 실제 음원 신호가 Music Shower에 도착했다는 뜻입니다.
5. `ERR`가 보이면 SoundCloud와 Music Shower 탭을 모두 새로고침한 뒤 다시 누르세요. Music Shower 화면에는 실제 연결 실패 원인이 표시됩니다.

확장 파일을 수정한 뒤에는 `chrome://extensions`에서 이 확장 프로그램의 새로고침 버튼을 누르고, SoundCloud와 Music Shower 탭도 각각 새로고침해야 새 코드가 적용됩니다.

확장 프로그램은 사용자가 아이콘을 누른 SoundCloud 탭의 오디오만 캡처합니다. 재생 이벤트와 현재 곡 메타데이터는 SoundCloud 탭에서 읽어 로컬 Music Shower 탭으로만 전달합니다.
