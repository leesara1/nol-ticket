# CLAUDE.md

## 프로젝트

**NOL 취소표 알리미 (`nol-cancel-alert`)**: NOL 티켓(야놀자, 구 인터파크 티켓)에서 공연 취소표를 감지해 알리고, 사람이 빠르게 예매하도록 돕는 개인용 도구.

- 요구사항과 범위: [README.md](README.md)가 기준이다. 기능을 추가·변경하면 README의 FR/NFR 번호와 맞춘다.
- 설계: [docs/DESIGN.md](docs/DESIGN.md). 구현은 이 문서를 따르고, 설계가 바뀌면 문서를 먼저 고친다.
- 조사 자료: [research/](research/README.md). 새로 조사한 내용은 해당 파일에 추가하고, 날짜는 `YYYY-MM-DD` 절대 날짜로 쓴다.
- 첫 대상 공연: 상품코드 `26015783` (상세: [research/03-target-26015783.md](research/03-target-26015783.md))

## 범위 규칙

- README 3.1의 구현 범위 안에서 작업한다.
- 좌석 클릭·'선택완료'·보안문자·결제는 사용자가 한다. 자동 클릭(README R-X1)은 미구현 항목이다.
- 만들지 않는 것은 README 3.3을 따른다 (보안문자 우회, 봇 탐지 회피, 짧은 간격 새로고침, 대기열 자동 통과, 다중 계정).

## 환경

- 개발: WSL2 (Linux), Python 3.14
- 실행: Windows의 Chrome (사용자 프로필, 로그인 상태)
- 주 구성요소: Chrome MV3 확장 (JavaScript). Python은 예비 수단(픽셀 감시)과 오프라인 분석용
- 기존 픽셀 감시 스크립트 `nol_screen_alert.py`는 작업 폴더에서 삭제됨, git 기록에 있음. Windows 전용(`winsound`)

## 디렉터리 (계획)

```
extension/      MV3 확장 (manifest.json, content script, service worker, options)
extension/config/  셀렉터·엔드포인트 (확장은 자기 폴더 밖 파일을 못 읽으므로 extension 안에 둠)
fixtures/       사전 조사에서 저장한 HAR / HTML / 스크린샷 (오프라인 테스트용)
research/       조사 자료 (raw/ 는 원본 응답)
```

## 작업 규칙

- **실제 사이트에 반복 요청하지 않는다.** 개발과 테스트는 `fixtures/`로 오프라인으로 한다. 실사이트 확인이 필요하면 사용자에게 먼저 묻고 1회만 요청한다.
- 감지는 페이지가 이미 받은 데이터(네트워크 응답 → DOM)를 우선 쓴다. 추가 요청을 만들지 않는다.
- 자동 새로고침은 기본 꺼짐, 고정 간격 최소 30초 (README FR-6~9).
- 좌석은 `Seat {key, id, playSeq, grade, zone, block, row, col, seenAt}` 하나의 형식으로 다룬다 (docs/DESIGN.md 4절).
- 비공식 API·셀렉터는 바뀔 수 있으므로 `extension/config/`에 두고, 파싱 실패는 조용히 넘기지 말고 "감시 불능" 알림으로 올린다 (FR-11).
- 문서와 주석은 한국어로 쓴다. 코드 식별자는 영어.

## 보안·개인정보

- 아이디·비밀번호를 저장하거나 인자로 받지 않는다. 로그인은 사용자의 Chrome 세션을 쓴다.
- 텔레그램 토큰, 예매자 정보, HAR 파일의 쿠키·토큰은 커밋하지 않는다. HAR은 `fixtures/`에 넣기 전에 `Cookie`, `Set-Cookie`, `Authorization` 헤더를 지운다.
- 비밀값은 `.env` 또는 확장 storage에 두고 `.gitignore`에 포함한다.

## Git

- 커밋 메시지에 `Co-Authored-By` 등 트레일러를 넣지 않는다.

## 명령어

아직 없음. 확장과 테스트가 생기면 빌드·로드·테스트 방법을 여기에 추가한다.
