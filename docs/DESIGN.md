# 설계: NOL 취소표 알리미 (`nol-cancel-alert`)

- 상태: 초안 r2 (2026-11-16, 설계 검토 15건 반영)
- 요구사항: [README.md](../README.md) (FR/NFR 번호는 README 기준)
- 근거 자료: [research/](../research/README.md)

이 설계는 **사전 조사(README 8절) 전**에 작성되었습니다. 조사 결과에 따라 바뀌는 부분은 `[조사 의존]`으로 표시합니다.

---

## 1. 설계 원칙

1. **이미 받은 데이터를 읽는다.** 사이트에 요청을 더 만들지 않는다 (NFR-1).
2. **조용히 실패하지 않는다.** 읽지 못하면 "감시 불능"으로 알린다 (FR-11).
3. **사람이 확정한다.** 도구는 좌석을 찾아 보여주는 데까지만 한다 (README 3.1).
4. **사이트별 지식은 설정에 둔다.** 셀렉터·URL 패턴·응답 경로는 코드에 하드코딩하지 않는다 (NFR-3).
5. **오프라인으로 테스트한다.** 어댑터는 저장된 fixture로 검증한다 (NFR-4).
6. **service worker는 언제든 죽는다고 가정한다.** 상태는 메모리가 아니라 storage에 둔다.

## 2. 기술 선택

| 항목 | 선택 | 이유 |
|---|---|---|
| 런타임 | Chrome MV3 확장, `minimum_chrome_version: "120"` | 로그인된 사용자 크롬에서 동작. 120+에서 `chrome.alarms` 30초 주기, 매니페스트 `world: "MAIN"`(111+) 사용 가능 |
| 언어 | JavaScript + JSDoc 타입 (`// @ts-check`) | 빌드 단계 없이 `chrome://extensions`에서 바로 로드 |
| 모듈 방식 | SW: ES module (`"type": "module"`)<br>content script: **classic script** | 매니페스트 content script는 `import`를 쓸 수 없다. 파일을 `content_scripts[].js`에 순서대로 나열하고 전역 네임스페이스 `globalThis.NCA`를 공유한다 |
| 테스트 | `node --test` (Node 24 내장) | 의존성 없음. 순수 로직만 테스트 |
| 외부 의존성 | 없음 | dom 어댑터 fixture 테스트에 `linkedom`이 필요해지면 그때 `package.json`(devDependency)을 추가한다 |

### 2.1 SW·content·Node가 같은 코드를 쓰는 방법

순수 모듈(`shared/`)은 다음 형식으로 작성해 세 환경에서 모두 불러온다.

```js
// shared/detector.js
(function (root) {
  function detect(prev, curr, filter, alerted) { /* … */ }
  const api = { detect };
  if (typeof module === "object" && module.exports) module.exports = api;   // node --test
  else (root.NCA ??= {}).detector = api;                                    // content script / SW
})(globalThis);
```

- content script: 매니페스트에 `shared/*.js` → `content/*.js` 순서로 나열
- SW(ES module): `import "./shared/detector.js"`(부수효과 import) 후 `globalThis.NCA.detector` 사용
- Node: `require("../extension/shared/detector.js")` (`test/`는 CommonJS)

## 3. 전체 구조

```
┌─────────── NOL 탭: top frame + 좌석맵 iframe [조사 의존: 도메인·팝업 여부] ───────────┐
│  각 frame마다 (all_frames: true, run_at: document_start)                              │
│                                                                                       │
│  [MAIN world]  content/net-tap.js                                                     │
│     fetch / XHR 감싸기 → URL 패턴 일치 시에만 응답 복제 → postMessage(NCA_NET)          │
│     패턴 수신 전에는 제한된 버퍼에 보관 (3.1)                                          │
│                     ▲ NCA_CONFIG            │ NCA_NET                                 │
│  [ISOLATED world]  shared/*.js + content/*.js                                         │
│     ├─ adapters/net.js, adapters/dom.js  : → Snapshot                                 │
│     ├─ page-state.js     : frame 단위 상태 판정, 1분마다 HEARTBEAT                     │
│     ├─ assist/highlight.js, assist/autofill.js                                        │
│     └─ refresh-banner.js : 자동 새로고침 ON 배너 (FR-6)                               │
│                     │ chrome.runtime.Port (끊기면 재연결)                              │
└─────────────────────┼─────────────────────────────────────────────────────────────────┘
                      ▼
┌──────────── service worker (background.js, ES module) ───────────────────────────────┐
│  모든 리스너는 최상위에서 동기 등록 (onConnect, alarms, notifications.onClicked …)       │
│  매 이벤트마다 chrome.storage.session에서 상태 복원 → 처리 → 저장                     │
│                                                                                       │
│  tab-registry.js  : frameId별 상태 → 탭 단위로 합침, 좌석맵 frame 식별 (5.2)          │
│  watcher-state.js : 탭별 상태 머신 (5.1)                                              │
│  detector         : shared/detector.js                                                │
│  scheduler.js     : 새로고침 알람 (WATCHING에서만)                                    │
│  health.js        : 1분 주기 알람, stale 판정 (새로고침 설정과 무관)                   │
│  notifier.js      : chrome.notifications / offscreen 소리 / 텔레그램                  │
│  focus.js         : 창·탭 포커스                                                       │
│  log.js           : 좌석 이벤트 일별 로그 + 내보내기                                   │
└───────────────────────────────────────────────────────────────────────────────────────┘
         │                                       │
   offscreen/ (소리 재생)                  options/ (설정 UI, 로그 내보내기)
```

### 3.1 MAIN world 응답 읽기 (net-tap.js)

MV3 `webRequest`는 응답 본문을 주지 않는다. 그래서 페이지 컨텍스트(MAIN world)에서 `fetch`와 `XMLHttpRequest`를 감싸 **응답을 읽기만** 한다.

- 요청을 바꾸거나 다시 보내지 않는다.
- MAIN world에는 `chrome.*` API가 없다. URL 패턴은 ISOLATED가 `NCA_CONFIG` 메시지로 전달한다.
- **패턴 도착 전 버퍼:** 첫 좌석 응답을 놓치지 않도록 `NCA_CONFIG`가 올 때까지 다음 조건의 응답만 보관한다.
  - 최대 20개 또는 페이지 로드 후 5초까지
  - `Content-Type`이 JSON 또는 HTML인 것, 본문 1MB 이하
  - 패턴이 오면 일치하는 것만 전달하고 나머지는 버린다.
- 패턴을 받은 뒤에는 **URL이 일치할 때만** `response.clone()`한다. 스트리밍 응답을 불필요하게 버퍼링하지 않기 위해서다.
- `postMessage`는 `targetOrigin = location.origin`으로 보낸다. 받는 쪽은 `event.source === window`, 타입 접두사 `NCA_`, **payload 형식**(필드·타입)을 검증한다. 페이지 스크립트가 같은 메시지를 위조할 수 있으므로 형식이 맞지 않으면 버린다.
- 로그인 토큰 같은 다른 응답은 확장으로 넘기지 않는다.

### 3.2 offscreen 문서 (소리)

MV3 service worker는 오디오를 재생할 수 없다. `chrome.offscreen.createDocument({reasons: ["AUDIO_PLAYBACK"]})`로 연 문서에서 재생한다. offscreen 문서는 하나만 만들 수 있으므로, 만들기 전에 `chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"]})`로 이미 있는지 확인한다.

### 3.3 service worker 생명주기

SW는 약 30초 동안 이벤트가 없으면 종료되고, 포트가 있어도 무기한 살아 있지 않다. 그래서 다음을 지킨다.

- **상태는 `chrome.storage.session`에 둔다.** 대상: 탭·frame 레지스트리, 탭별 watcher 상태, `(tabId, playSeq)`별 `prev` 스냅샷, 알림 보낸 좌석 ID 집합, BLIND 사유 중복 방지
- 모든 이벤트 처리기는 시작할 때 storage에서 복원하고 끝날 때 저장한다.
- 리스너는 최상위에서 동기적으로 등록한다.
- content script는 `port.onDisconnect`와 `pageshow`(bfcache 복원) 때 포트를 다시 연결하고 `HELLO`를 보낸다.

## 4. 데이터 모델

```js
/** @typedef {Object} Seat
 *  @property {string} key     // `${playSeq}|${id}` — 회차 간 충돌 방지. 중복 방지 집합의 키
 *  @property {string} id      // 사이트 좌석 ID. 없으면 `${zone}|${row}|${col}`
 *  @property {string} playSeq // 회차
 *  @property {string} grade   // "R", "S", "VIP" …
 *  @property {string} zone    // "1층 A구역" 등. 모르면 ""
 *  @property {string} block   // 통로로 나뉜 블록. 모르면 "" [조사 의존]
 *  @property {string} row     // 열. 문자열 (예: "7", "가")
 *  @property {number} col     // 번호. 연석 계산용 숫자
 *  @property {number} seenAt  // epoch ms
 */

/** @typedef {Object} Snapshot
 *  @property {string} playSeq
 *  @property {"net"|"dom"} source
 *  @property {Seat[]} available   // 예매 가능 좌석
 *  @property {number} totalSeats  // 예매 가능 + 불가 좌석 전체 수 (파싱 성공 판정용)
 *  @property {number} takenAt
 */

/** @typedef {Object} SeatEvent
 *  @property {"appeared"|"disappeared"} kind
 *  @property {Seat[]} seats        // 연석 묶음이면 2개 이상
 *  @property {boolean} matched     // 사용자 조건 일치 여부
 */

/** @typedef {"ok"|"logged_out"|"queue"|"expired"|"no_seat_map"|"selector_mismatch"|"parse_failed"|"stale"} PageState */
```

README FR-2의 필드 이름은 이 정의를 따른다 (`seenAt`, `playSeq`, `block`).

## 5. 상태 관리

### 5.1 감시 상태 머신 (탭 단위)

```
            사용자가 "감시 시작"
  IDLE ─────────────────────────────▶ WATCHING ◀──────────────┐
                                        │  ▲                   │
           탭 상태 ≠ ok                  │  │ 탭 상태 = ok        │ 사용자가 "감시 재개"
           또는 stale (5.3)              ▼  │                   │ 또는 좌석 사라짐
                                      BLIND(reason)            │
                                        → 사유별 알림 1회        │
                                                               │
           조건 일치 좌석 appeared                              │
  WATCHING ───────────────────────▶ FOUND ─────────────────────┤
                                     → 알림 + 포커스 + 강조      │
                                     → 새로고침 일시정지         │
                                        │                      │
           사용자가 좌석 클릭             ▼                      │
                                    ASSISTING ─────────────────┘
                                     → (예매자 정보 화면이면 autofill)

  탭 닫힘 → 어느 상태에서든 IDLE, 해당 탭의 storage 정리
```

- **새로고침은 WATCHING에서만** 실행한다. FOUND·ASSISTING·BLIND에서는 멈춘다. 사용자가 좌석을 고르는 중에 화면이 새로고침되지 않게 하기 위해서다.
- BLIND는 같은 사유로 한 번만 알린다. `ok`로 돌아오면 "감시 복구" 알림.
- FOUND에서 해당 좌석이 `disappeared`되면 "사라짐" 알림 후 WATCHING.

### 5.2 frame 합치기 (tab-registry.js)

`all_frames`라서 frame마다 상태를 따로 보고한다 (예: top frame은 `no_seat_map`, iframe은 `ok`). SW가 `port.sender.frameId`로 frame을 구분해 탭 상태 하나로 합친다.

| 항목 | 규칙 |
|---|---|
| 좌석맵 frame | 설정의 `seatMapFrame.urlPattern`에 맞는 frame. 스냅샷은 이 frame에서 온 것만 받는다 |
| `logged_out`, `queue`, `expired` | 어느 frame에서든 먼저 보고되면 탭 상태로 채택 |
| `no_seat_map` | 좌석맵 frame이 하나도 없을 때만 |
| `selector_mismatch`, `parse_failed` | 좌석맵 frame의 보고만 반영 |
| `HIGHLIGHT`, `REFRESH` | 좌석맵 frame의 포트로만 보낸다 |

### 5.3 생존 확인 (health.js, FR-12)

- 좌석맵이 저절로 갱신되지 않고 새로고침도 꺼져 있으면 스냅샷이 계속 오지 않는다. 이걸 "감시 불능"으로 보면 기본 설정에서 10분마다 잘못된 알림이 뜬다.
- 그래서 **"정상적으로 읽음" = 스냅샷 수신 또는 `HEARTBEAT {state: "ok"}` 수신**으로 정의한다.
- content script(page-state.js)는 1분마다 HEARTBEAT를 보낸다. 백그라운드 탭에서 타이머가 1분 주기로 제한돼도 동작한다.
- `health.js`는 새로고침 설정과 무관한 1분 주기 `chrome.alarms`로 탭마다 마지막 수신 시각을 확인하고, 10분을 넘으면 `stale`로 BLIND 처리한다.

## 6. 감지 로직 (shared/detector.js)

순수 함수로 작성해 Node에서 테스트한다.

```js
detect(prev: Snapshot | null, curr: Snapshot, filter: Filter, alerted: Set<string>)
  → { events: SeatEvent[], alerted: Set<string> }
```

1. **비교:** `curr.available`과 `prev.available`의 `key` 집합 차이 → `appeared`, `disappeared`
2. **필터:** `curr.available` **전체**에 등급·구역·열 범위·정규식 적용
3. **연석:** 필터를 통과한 좌석을 `(playSeq, zone, block, row)`로 묶고 `col`이 연속인 묶음을 만든다. 길이 ≥ `filter.adjacent`이고 **appeared 좌석을 하나 이상 포함**한 묶음만 `matched`
   - 예: 12번이 이미 비어 있었고 13번이 새로 생기면 12·13번 2연석으로 알린다
   - `block`을 모르면(`""`) `col` 연속만 본다 `[조사 의존]`
4. **중복 방지:** `alerted`에 있는 `key`로만 이뤄진 묶음은 다시 알리지 않는다. 좌석이 `disappeared`되면 `alerted`에서 뺀다 (FR-4)
5. **확정:** `net`/`dom` 스냅샷은 즉시 확정. 2회 연속 확인은 하지 않는다 (FR-5)
6. **첫 스냅샷:** `prev = null`이면 기준으로만 저장한다. 단 `filter.alertOnFirst = true`면 조건 일치 묶음을 바로 알린다
   - SW가 재시작돼도 `prev`는 storage에서 복원되므로 첫 스냅샷으로 오인하지 않는다 (3.3)

**열 범위(`rowRange`):** 열이 숫자면 `{from, to}` 숫자 비교. "가", "AA" 같은 문자 열은 `rowRange` 대신 `rows: ["가", "나"]` 목록이나 정규식으로 지정한다.

**필터 세부 규칙**
- 빈 배열·`null`인 조건은 제한 없음으로 본다.
- `rowRange`가 있으면 숫자가 아닌 열은 통과하지 못한다.
- `regex`는 좌석 라벨 `"{grade}|{zone}|{block}|{row}|{col}"`과 비교한다. 예: `"^R\\|1층 A구역\\|"`, `"\\|(7|8|9)\\|\\d+$"`
- `adjacent` 기본값은 1 (단일 좌석도 알림).

**이벤트 생성 규칙**
- `appeared` + `matched: true`: 조건 일치 연석 묶음마다 하나. 묶음 전체(이미 비어 있던 좌석 포함)를 담는다.
- `appeared` + `matched: false`: 조건 일치 묶음에 들지 않은 새 좌석 전체를 하나로 묶는다. 알림에는 쓰지 않고 로그(NFR-5)에만 쓴다.
- `disappeared`: **이전에 알린 좌석(`alerted`) 중 사라진 것**만 하나로 묶는다. 알리지 않은 좌석이 사라진 건 알릴 필요가 없다.
- `prev.playSeq !== curr.playSeq`이면 `prev = null`로 취급한다.
- 입력(`prev`, `curr`, `alerted`)은 변경하지 않고 새 `alerted`를 반환한다.

## 7. 소스 어댑터

모든 어댑터는 같은 계약을 따른다.

```js
/** @param {unknown} input  (net: {url, body}, dom: Document)
 *  @param {SiteConfig} site
 *  @returns {{ snapshot: Snapshot } | { error: "selector_mismatch" | "parse_failed", detail: string }} */
parse(input, site)
```

| 어댑터 | 입력 | 언제 쓰나 | 상태 |
|---|---|---|---|
| `net` | 페이지가 받은 좌석 응답 본문 | 좌석 상태가 JSON/HTML 응답에 있을 때 | **1순위** `[조사 의존]` |
| `dom` | 좌석맵 DOM | 응답 형식을 못 쓰고 좌석이 DOM 요소일 때 | 예비 `[조사 의존]` |
| 픽셀 | 화면 캡처 | 좌석맵이 캔버스일 때 | 설계 보류. 기존 `nol_screen_alert.py`(git 기록) 참고 |

**실패 판정**
- `totalSeats === 0` → `parse_failed`. 좌석맵에 좌석이 하나도 없다는 건 파싱 실패로 본다
- 예매 가능 좌석이 0개여도 `totalSeats > 0`이면 **정상(매진)**이다
- 필수 셀렉터나 응답 필드가 없으면 → `selector_mismatch`
- **실패한 스냅샷은 `prev`를 덮어쓰지 않는다.** 덮어쓰면 복구 직후 모든 좌석이 "생김"으로 쏟아진다

## 8. 페이지 상태 판정 (page-state.js)

설정의 `pageState` 규칙(URL 패턴 + 셀렉터 + 텍스트)을 위에서부터 평가한다. frame 단위로 판정하고 SW가 합친다 (5.2).

| 상태 | 판정 예 `[조사 의존]` |
|---|---|
| `logged_out` | 로그인 페이지 URL, 로그인 버튼 존재 |
| `queue` | 대기열(NetFunnel 등) 화면 요소 |
| `expired` | "세션이 만료" / "시간이 초과" 팝업 |
| `no_seat_map` | 좌석맵 frame 없음 (SW 판정) |
| `selector_mismatch` | 어댑터의 필수 셀렉터·필드 없음 |
| `parse_failed` | `totalSeats === 0` |
| `stale` | 10분간 스냅샷·HEARTBEAT 없음 (SW 판정, 5.3) |
| `ok` | 위에 해당하지 않음 |

## 9. 새로고침 스케줄러 (scheduler.js)

`[조사 의존]` 좌석맵이 저절로 갱신되면 이 모듈은 만들지 않는다. 생존 확인은 별도 모듈(5.3)이 맡는다.

- 기본 **꺼짐**. 옵션에서 켜야 동작한다 (FR-6)
- 켜져 있으면 두 곳에 표시한다
  - 페이지 상단 고정 배너 "자동 새로고침 ON · 60초" (`refresh-banner.js`)
  - 확장 배지 `R`
- `chrome.alarms` 사용. 간격은 고정, **최소 30초** (FR-7). 무작위 지연은 넣지 않는다
- `windows`(시간대) 밖에서는 동작하지 않는다
- **실행 조건:** 탭 상태 `ok` **그리고** watcher 상태 `WATCHING`. 그 외에는 건너뛴다
- `queue`가 감지되면 스케줄러를 끄고 알린다 (FR-9)
- 동작은 설정의 `refresh.action`을 따른다. 그 외 요소는 클릭하지 않는다 (FR-8)
  - `"button"`: 페이지의 좌석 새로고침 버튼 클릭
  - `"reload"`: 좌석맵 frame 다시 불러오기

## 10. 알림 (notifier.js)

| 이벤트 | 소리 | 크롬 알림 | 텔레그램 |
|---|---|---|---|
| 조건 일치 좌석 생김 | ✅ 3회 | ✅ `requireInteraction: true` | ✅ |
| 좌석 사라짐 | | ✅ | ✅ |
| 감시 불능 / 복구 | ✅ 1회 (다른 음) | ✅ | ✅ |
| 생존 신호 (선택) | | | ✅ 하루 1회 요약 |

- 메시지 형식: `[12/31 19:00] R석 1층 A구역 7열 12·13번 (2연석) 생김`
- **알림 ID에 `tabId`와 `windowId`를 넣는다** (예: `found:123:45:<시각>`). SW가 재시작된 뒤에도 알림 클릭으로 올바른 탭을 찾기 위해서다
- 텔레그램: Bot API `sendMessage`. 토큰·chat_id는 `chrome.storage.local`
- 같은 좌석 묶음 알림은 30초 안에 반복하지 않는다

## 11. 보조 (assist)

### 11.1 포커스·강조 (FR-13, FR-14)

1. 좌석이 생기면 `chrome.windows.update(winId, {focused: true, drawAttention: true})`, `chrome.tabs.update(tabId, {active: true})`
   - Windows는 백그라운드에서 창을 앞으로 가져오는 것을 막는 경우가 많다. 그러면 작업표시줄 깜빡임으로 대신한다
   - **알림을 클릭하면** 다시 포커스한다. 사용자 동작에서 나온 포커스는 대부분 허용된다
2. 좌석맵 frame에 `HIGHLIGHT {seatKeys}` 전달
3. 해당 좌석 요소로 `scrollIntoView({block: "center"})`, 굵은 외곽선 + 깜빡임 CSS
4. '선택완료' 버튼에도 외곽선. **클릭 이벤트는 발생시키지 않는다**
5. 캔버스 좌석맵이면 좌석 좌표에 오버레이 표시 `[조사 의존]`

### 11.2 예매자 정보 채우기 (FR-15)

- `[조사 의존]` NOL이 미리 채우면 이 모듈은 만들지 않는다
- 동작 조건: 예매자 정보 화면 URL/셀렉터 일치 **그리고** 같은 탭에서 사용자가 좌석을 클릭한 기록(ASSISTING 상태)
- 비어 있는 칸만 채우고 `input` 이벤트를 발생시킨다. 제출 버튼은 누르지 않는다

## 12. 설정

### 12.1 사이트 설정 — `extension/config/site.nol.json` (커밋함)

확장은 자기 폴더 밖의 파일을 읽을 수 없으므로 `extension/` 안에 둔다. content script 주입 대상 도메인은 **매니페스트가 기준**이다. 이 파일에는 넣지 않는다.

```json
{
  "site": "nol",
  "seatMapFrame": { "urlPattern": "TODO: 좌석맵 frame URL 정규식" },
  "net": {
    "urlPatterns": ["TODO: 좌석 상태 응답 URL 정규식"],
    "seatPath": "TODO",
    "fields": { "id": "TODO", "grade": "TODO", "zone": "TODO", "block": "TODO", "row": "TODO", "col": "TODO", "available": "TODO" }
  },
  "dom": { "seatSelector": "TODO", "availableSelector": "TODO" },
  "pageState": [
    { "state": "queue", "selector": "TODO" },
    { "state": "logged_out", "urlPattern": "TODO" },
    { "state": "expired", "text": "TODO" }
  ],
  "refresh": { "action": "button", "selector": "TODO" },
  "assist": { "confirmButtonSelector": "TODO" }
}
```

### 12.2 사용자 설정 — 옵션 페이지 → `chrome.storage.local` (커밋 안 함)

```json
{
  "targets": [{
    "goodsCode": "26015783",
    "playSeq": ["TODO"],
    "filter": {
      "grades": ["R", "VIP"], "zones": [],
      "rowRange": null, "rows": null,
      "adjacent": 2, "regex": null, "alertOnFirst": false
    }
  }],
  "refresh": { "enabled": false, "intervalSec": 60, "windows": [{ "from": "08:55", "to": "09:30" }] },
  "notify": { "sound": true, "desktop": true, "telegram": { "enabled": false, "token": "", "chatId": "" } },
  "profile": { "name": "", "phone": "", "email": "" }
}
```

설정 로드 시 검증한다: `intervalSec < 30`이면 30으로 올리고 옵션 화면에 경고.

### 12.3 설정 검증 (`shared/config-validate.js`)

순수 모듈 (2.1 형식, `globalThis.NCA.configValidate`). 잘못된 값은 **오류로 막지 않고 안전한 값으로 고친 뒤 경고**를 돌려준다. 옵션 페이지는 경고를 그대로 보여준다.

```js
defaultUserConfig() → UserConfig
validateUserConfig(input: unknown) → { config: UserConfig, warnings: string[] }
validateSiteConfig(site: unknown) → { missing: string[] }   // 비었거나 "TODO"로 시작하는 필수 항목 경로
```

| 항목 | 규칙 |
|---|---|
| 입력 전체 | 객체가 아니면 기본값 + 경고 |
| `targets` | 배열 아니면 `[]`. `goodsCode`가 숫자 문자열이 아니면 그 target 제거 + 경고. `playSeq`는 문자열 배열(빈 문자열 제거). `filter`는 detector의 `normalizeFilter` 규칙 + `regex`가 컴파일되지 않으면 `null` + 경고, `rowRange`는 `from ≤ to`인 정수가 아니면 `null` + 경고 |
| `refresh.intervalSec` | 정수 아니면 60. 30 미만이면 30 + 경고 (FR-7) |
| `refresh.windows` | `"HH:MM"` 형식이 아닌 항목 제거 + 경고. `from > to`면 자정을 넘는 구간으로 인정 |
| `refresh.enabled` | boolean 아니면 `false` |
| `notify.telegram` | `enabled`인데 `token`·`chatId`가 비면 `enabled: false` + 경고 |
| `profile` | 문자열 필드만 유지, 앞뒤 공백 제거 |
| 모르는 키 | 버린다 |

### 12.4 상태 저장 (`sw/store.js`, 3.3)

ES module. `chrome.storage.session`을 감싸는 `createStore(area)` — `area`를 주입받아 Node에서 가짜 저장소로 테스트한다.

| 키 | 값 |
|---|---|
| `tab:{tabId}` | `{ watch: "IDLE"\|"WATCHING"\|"BLIND"\|"FOUND"\|"ASSISTING", blindReason, frames: {[frameId]: {url, state, lastSeenAt}}, seatMapFrameId, lastOkAt }` |
| `prev:{tabId}:{playSeq}` | 직전 정상 `Snapshot` |
| `alerted:{tabId}:{playSeq}` | 알린 좌석 key 배열 |

`clearTab(tabId)`는 `tab:`, `prev:`, `alerted:` 중 해당 탭 키를 모두 지운다 (`chrome.tabs.onRemoved`에서 호출).

### 12.5 옵션 페이지

- classic script: `shared/types.js` → `shared/detector.js` → `shared/config-validate.js` → `options.js`
- 사용자 설정은 `chrome.storage.local`의 `userConfig` 키 하나에 저장
- 저장 시 `validateUserConfig` → 고쳐진 값으로 저장하고 경고 목록 표시
- 대상 공연은 우선 1개만 편집 (UI). 데이터 구조는 배열 유지

## 13. 메시지 프로토콜

| 방향 | 타입 | 내용 |
|---|---|---|
| ISOLATED → MAIN | `NCA_CONFIG` (`postMessage`) | `{urlPatterns}` |
| MAIN → ISOLATED | `NCA_NET` (`postMessage`) | `{url, status, body}` (패턴 일치분만) |
| content → SW | `HELLO` | `{frameUrl}` (연결·재연결 시) |
| content → SW | `SNAPSHOT` | `Snapshot` |
| content → SW | `PAGE_STATE` | `{state, detail}` |
| content → SW | `HEARTBEAT` | `{state}` (1분마다) |
| content → SW | `USER_SEAT_CLICK` | `{seatKey}` (ASSISTING 전환·autofill 조건) |
| SW → content | `HIGHLIGHT` | `{seatKeys}` |
| SW → content | `REFRESH` | `{}` |
| SW → content | `REFRESH_BANNER` | `{enabled, intervalSec}` |
| SW → content | `AUTOFILL` | `{profile}` |
| SW → offscreen | `PLAY` | `{pattern: "found" \| "blind"}` |

`postMessage` 검증 규칙은 3.1을 따른다.

## 14. 디렉터리

```
extension/                    # 확장 루트 (chrome://extensions에서 이 폴더를 로드)
  manifest.json
  background.js               # SW 진입점 (ES module)
  config/ site.nol.json
  shared/ types.js detector.js config-validate.js page-state-rules.js   # 순수 모듈 (2.1 형식)
  sw/ tab-registry.js watcher-state.js scheduler.js health.js notifier.js focus.js log.js store.js
  content/ net-tap.js         # MAIN world
  content/ adapters-net.js adapters-dom.js page-state.js highlight.js autofill.js refresh-banner.js content.js
  content/ highlight.css
  offscreen/ offscreen.html offscreen.js sounds/
  options/ options.html options.js
fixtures/                     # 조사 결과 (HAR는 쿠키·토큰 제거 후). 확장에 포함되지 않음
test/
  detector.test.js adapters-net.test.js adapters-dom.test.js page-state.test.js config-validate.test.js
```

- `shared/`와 `content/adapters-*.js`는 **chrome API에 의존하지 않는다.** `node --test`로 테스트한다.
- 매니페스트 content script 순서: `shared/*.js` → `content/adapters-*.js` → `page-state.js` → `highlight.js` → `autofill.js` → `refresh-banner.js` → `content.js`(진입점)

## 15. 매니페스트

```json
{
  "manifest_version": 3,
  "minimum_chrome_version": "120",
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["TODO"], "js": ["content/net-tap.js"], "world": "MAIN",
      "all_frames": true, "run_at": "document_start", "match_origin_as_fallback": true },
    { "matches": ["TODO"], "js": ["shared/…", "content/…", "content/content.js"], "css": ["content/highlight.css"],
      "all_frames": true, "run_at": "document_start", "match_origin_as_fallback": true }
  ]
}
```

| 권한 | 용도 |
|---|---|
| `storage` | 설정, 상태(session), 이벤트 로그(local) |
| `unlimitedStorage` | 이벤트 로그 장기 보관 (NFR-5) |
| `alarms` | 새로고침, 생존 확인 |
| `notifications` | 크롬 알림 |
| `offscreen` | 소리 재생 |
| host / `matches`: `https://nol.yanolja.com/*` + 좌석맵 iframe·예매 팝업 도메인 `[조사 의존]` | content script 주입. **iframe의 도메인도 직접 넣어야 한다** (부모 도메인만으로는 주입되지 않음) |
| host: `https://api.telegram.org/*` | 텔레그램 전송 |

- `tabs` 권한은 넣지 않는다. ID를 아는 탭·창의 `update`에는 필요 없고, NOL 탭의 URL은 host 권한으로 볼 수 있다.
- `match_origin_as_fallback`은 좌석맵이 `about:blank`/`srcdoc`/`blob:` frame일 때를 위한 것이다.

## 16. 이벤트 로그 (log.js, NFR-5)

- 링 버퍼가 아니라 **일별로 계속 쌓는다**: `chrome.storage.local`의 `log:YYYY-MM-DD` 키
- 항목: `{t, kind, goodsCode, playSeq, seats, matched}`, BLIND/복구도 기록
- 90일보다 오래된 날짜 키는 삭제
- 옵션 페이지에서 **JSON/CSV 내보내기**. 취소표가 풀리는 시간대 분석용

## 17. 테스트 전략

| 대상 | 방법 |
|---|---|
| detector | 표 기반 단위 테스트: 비교, 필터, 연석(기존 좌석 + 새 좌석 포함), 중복 방지, 첫 스냅샷, 회차 간 key 충돌 |
| net/dom 어댑터 | `fixtures/`의 실제 응답·HTML로 파싱 결과 검증. 필드 누락 → `selector_mismatch`, 좌석 0개 → `parse_failed`, 매진 → 정상 |
| page-state 규칙 | 대기열·만료·로그아웃 화면 fixture로 판정 검증 |
| tab-registry | frame 보고 조합 → 탭 상태 (순수 함수로 분리해 테스트) |
| config 검증 | 최소 간격 보정, 누락 필드 기본값 |
| 통합 (수동) | fixture HTML을 로컬에서 열고 확장을 로드해 확인. SW를 `chrome://serviceworker-internals`에서 강제 종료한 뒤에도 알림이 정상인지 확인 |

## 18. 결정 기록

| # | 결정 | 대안 | 이유 |
|---|---|---|---|
| D1 | 크롬 확장 | Playwright + CDP | 크롬 136 제약, 사용자 세션 그대로 사용, 탭·알림 API |
| D2 | 네트워크 응답 읽기 우선 | DOM 폴링, 픽셀 | 정확도, 캔버스 대응, 추가 요청 0 |
| D3 | 빌드 없는 JS + JSDoc, content는 classic script | TypeScript, 동적 import | 단순성. content script에서 `import` 불가, 동적 import는 `document_start`에서 경쟁 상태 위험 |
| D4 | 새로고침 기본 꺼짐, 고정 간격 ≥30초, WATCHING에서만 | 짧은 간격, 무작위 지연 | 서버 부하·약관. 무작위 지연은 탐지 회피라 제외. 좌석 고르는 중 새로고침 방지 |
| D5 | 좌석 클릭·선택완료는 사용자 | 자동 클릭 | README R-X1 |
| D6 | 픽셀 감시 보류 | 기존 스크립트 포팅 | 좌석맵이 저절로 안 바뀌면 효과 없음. 캔버스일 때만 재검토 |
| D7 | SW 상태는 `storage.session` | 메모리 | SW가 30초 유휴 후 종료되면 상태가 사라져 취소표를 놓침 |
| D8 | 생존 판정에 HEARTBEAT 포함 | 스냅샷만 | 새로고침이 꺼진 기본 설정에서 잘못된 감시 불능 알림 방지 |

## 19. 조사 후 확정할 것

| 질문 | 영향 받는 절 |
|---|---|
| 좌석맵이 저절로 갱신되는가 | 9 (스케줄러 필요 여부) |
| 좌석 상태 응답의 URL·형식 | 7, 12 (`net` 설정) |
| 좌석맵이 DOM인가 캔버스인가 | 7, 11.1 |
| 좌석맵 iframe 도메인, `about:blank`/`srcdoc` 여부 | 5.2, 15 |
| 예매 화면이 다른 도메인 팝업 창으로 열리는가 (예: `tickets.interpark.com`) | 5.2, 11.1, 15 |
| 좌석 ID·열·번호·블록(통로) 정보 유무 | 4, 6 |
| 대기열·만료·로그아웃 화면 모습 | 8 |
| 예매자 정보 미리 채움 여부 | 11.2 |
| 회차(`playSeq`) 식별 방법 | 4, 12 |

## 20. 구현 순서

1. `shared/types.js`, `shared/detector.js` + 테스트 (조사 없이 가능)
2. `shared/config-validate.js` + 테스트, `manifest.json` 뼈대, `sw/store.js`(storage.session 복원·저장), 옵션 페이지
3. notifier (크롬 알림, offscreen 소리, 텔레그램), focus, log + 내보내기
4. **사전 조사** → `extension/config/site.nol.json`·매니페스트 `matches` 채우기, fixture 저장
5. `net-tap.js` + `adapters-net.js` + 테스트 → tab-registry·watcher-state 연결
6. page-state + health + BLIND 처리
7. highlight → (필요 시) autofill
8. (필요 시) scheduler + refresh-banner
