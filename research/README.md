# 조사 자료

2026-11-16에 조사한 내용입니다. 비공식 API와 사이트 구조에 관한 내용은 언제든 바뀔 수 있습니다.

| 파일 | 내용 |
|---|---|
| [01-similar-tools.md](01-similar-tools.md) | 비슷한 도구와 공식 기능 (NOL 예매대기, k-skill, interpark-ticket-watcher 등) |
| [02-design-review.md](02-design-review.md) | 설계 검토 결과와 반영 여부 |
| [03-target-26015783.md](03-target-26015783.md) | 대상 공연(성시경 연말 콘서트) 설정값과 API 조회 결과 |
| [04-legal.md](04-legal.md) | 공연법·약관 관련 자료 |
| [raw/](raw/) | 원본 응답 (playSeq API 응답. 상품 페이지 HTML은 로컬 전용) |

## raw/ 파일

| 파일 | 출처 |
|---|---|
| `nol-product-26015783_2026-11-16.html` | `https://nol.yanolja.com/ticket/products/26015783` 비로그인 GET 1회. **로컬 전용** (`.gitignore`, 공개 저장소에 올리지 않음) |
| `interpark-playSeq-26015783_2026-11-16.json` | `api-ticketfront.interpark.com/v1/goods/26015783/playSeq` GET 1회 (`data: null`) |
