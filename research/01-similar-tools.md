# 비슷한 도구와 공식 기능

## 요약

| 도구 | 하는 일 | 활용 |
|---|---|---|
| NOL 공식 예매대기 | 날짜·등급 신청 → 취소표 발생 시 자동 예매·결제, 알림톡 | **최우선.** 대상 공연이 지원함 |
| NomaDamas/k-skill `ticket-availability` | 인터파크·YES24 회차별·등급별 잔여석 수 조회 | 엔드포인트 참고. 좌석 단위 아님 |
| potados99/interpark-ticket-watcher | 좌석맵 조회 → 좌석 ID 비교 → 슬랙 알림, 조건 맞으면 API로 자동 선점 | 감지 방식만 참고 |
| ITP Ticket Helper | 좌석맵 자동 스캔, 보안문자 자동 풀이, 좌석 자동 선점 | 범위 밖. 참고하지 않음 |
| Distill.io 등 | 범용 웹페이지 변화 감시 | 좌석 단위 조건 불가 |

---

## NOL 공식 예매대기

- 공연 페이지의 '예매대기' 버튼 → 희망 날짜·좌석 등급 선택 → 신청
- 취소표가 생기면 자동으로 예매가 진행되고 알림톡으로 통보
- 무료. 자동 결제되므로 결제 수단을 미리 등록해야 함
- 출처는 블로그 글뿐이라 실제 동작은 신청 화면 안내로 확인 필요
- 같은 글: NOL 취소표는 2024-05-31 이전 새벽 2:10~2:20, 이후 **오전 9시**에 풀림. 무통장 미입금 취소분은 예매 이틀 뒤 오전 9시 무렵에 몰림

출처: [dnublog – 에픽하이 콘서트 취소표 풀리는 시간](https://dnublog.co.kr/2025/10/14/%EC%97%90%ED%94%BD%ED%95%98%EC%9D%B4-%EC%BD%98%EC%84%9C%ED%8A%B8-%EC%B7%A8%EC%86%8C%ED%91%9C-%ED%92%80%EB%A6%AC%EB%8A%94-%EC%8B%9C%EA%B0%84-%EB%B0%8F-%EC%98%88%EB%A7%A4-%EB%B0%A9%EB%B2%95-2025/)

---

## NomaDamas/k-skill — ticket-availability

- 저장소: <https://github.com/NomaDamas/k-skill> (MIT)
- 경로: `ticket-availability/` (`SKILL.md`, `scripts/ticket_availability.py`)
- 읽기 전용. 예매·결제·좌석 선택 기능 없음. 좌석 번호·위치는 의도적으로 제공하지 않음
- 로그인 불필요. 헤더는 `User-Agent`, `Referer`, `Accept`만 사용

### 인터파크 엔드포인트

```
GET https://api-ticketfront.interpark.com/v1/goods/{goods_code}/playSeq
    ?goodsCode=…&isBookableDate=true&page=1&pageSize=200
    &startDate=YYYYMMDD(오늘)&endDate=YYYYMMDD(+1년)
  → 회차 목록

GET https://api-ticketfront.interpark.com/v1/goods/{goods_code}/playSeq/PlaySeq/{play_seq}/REMAINSEAT
  → seatGradeName(또는 seatGrade), remainCnt
```

### YES24 엔드포인트

```
POST https://ticket.yes24.com/New/Perf/Sale/Ajax/axPerfDay.aspx
     pGetMode=days, pIdPerf, pPerfMonth=YYYY-MM, pIdCode="", pIsMania=0
POST https://ticket.yes24.com/NEw/Perf/Detail/Ajax/axPerfPlayTime.aspx
     IdPerf, PerfDay
POST https://ticket.yes24.com/New/Perf/Detail/Ajax/axPerfRemainSeat.aspx
     Type=calendar, IdTime, IdLock=0   → HTML에서 "(잔여:N석)" 정규식 추출
```

### 사용상 주의 (문서 기준)
- 회차마다 순차 호출, 인터파크 0.3초·YES24 0.4초 간격. 100회차 공연 ≈ 30~40초
- 짧은 간격의 감시 루프에 넣지 말 것. 차단·보안문자 우회, 대량 크롤링 금지
- 비공식 엔드포인트라 바뀔 수 있음

---

## potados99/interpark-ticket-watcher

- 저장소: <https://github.com/potados99/interpark-ticket-watcher>
- TypeScript/Node CLI. `package.json` 라이선스 `GPL-3.0-or-later` (LICENSE 파일은 없음). 31 commits, 22 stars (조회 시점)
- 의존성: axios, axios-cookiejar-support, cheerio, commander, iconv-lite, tough-cookie 등

### 실행

```
npm start -- --goods-code … --place-code … --play-seq … \
  --username … --password … --slack-webhook-url … \
  --poll-interval-millis … --capture-regex '^[ABC](7|8|9|10|11|12|13)$'
```

### 동작

1. **좌석맵 조회 (로그인 불필요)**
   ```
   GET https://aspseat-ticket.interpark.com/Booking/App/MOSeatDetail.asp
       ?GoodsCode=…&PlaceCode=…&PlaySeq=…&Block=RGN001&TmgsOrNot=D2006
   ```
   cheerio로 `#TmgsTable tr > td > img.stySeat`의 `onclick`을 읽어 좌석(열·번호) 단위로 파싱
2. **비교:** 좌석 ID로 직전 조회와 비교해 "생김/사라짐" 판정, 변화만 슬랙 웹훅으로 알림
3. **자동 선점 (정규식 일치 시):**
   - 로그인 `accounts.interpark.com/login/submit` → `moticket.interpark.com/OneStop/Session`
   - `POST moticket.interpark.com/OneStop/SaveSeatAjax`로 좌석 선점
   - 이어서 진행할 브라우저 콘솔 스크립트 출력. 보안문자·결제 코드는 없음

### 평가

| 참고함 | 채택하지 않음 |
|---|---|
| 좌석 단위 조회 방식 | 기본 0.5초(예시 0.2초) 조회, 백오프 없음 |
| 좌석 ID 비교, 생김/사라짐 구분 알림 | API 자동 선점 (약관상 매크로 핵심) |
| 정규식 조건 | 아이디·비밀번호를 명령줄 인자로 받음 |

- 예전 인터파크 도메인 사용. NOL 전환 후에도 동작하는지 미확인
- GPL이므로 코드는 가져오지 않고 아이디어만 참고

---

## ITP Ticket Helper

- 좌석맵 자동 스캔, 보안문자 자동 풀이, 빈 좌석 자동 선점, 성공 시 휴대폰 알림
- 보안문자 우회와 자동 선점은 범위 밖이라 참고하지 않음

출처: [ITP Ticket Helper guide](https://kevin-ticket-blog.pages.dev/posts/en/itp-ticket-helper-guide/)

## 범용 감시 도구

- [Distill.io – track tickets](https://distill.io/blog/track-tickets-on-ticketmaster/): 페이지 변화 감시·알림. 좌석 조건 필터는 불가
