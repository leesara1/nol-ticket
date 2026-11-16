// shared/seat-parse.js 테스트 (DESIGN 7.1). 실제 응답에서 잘라낸 fixtures/seat-*.json을 쓴다.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const sp = require("../extension/shared/seat-parse.js");
const { detect } = require("../extension/shared/detector.js");
const { formatSeatEvent } = require("../extension/shared/format.js");

const musical = require(path.join(__dirname, "../fixtures/seat-musical.json"));
const soldout = require(path.join(__dirname, "../fixtures/seat-soldout.json"));

/** fixture를 누적기에 넣고 첫 상태 응답 결과를 돌려준다 */
function feed(fx, statusIndex = 0) {
  const acc = sp.createAccumulator();
  for (const m of fx.meta) assert.ok("ok" in acc.addMeta(m.url, JSON.stringify(m.body)));
  const r = acc.addStatus(fx.status[statusIndex].url, JSON.stringify(fx.status[statusIndex].body), 1000);
  return { acc, r };
}

/** 구역·열별 예매 가능 번호 */
function byRow(seats) {
  const out = {};
  for (const s of seats) (out[`${s.zone} ${s.row}`] ??= []).push(s.col);
  for (const k in out) out[k].sort((a, b) => a - b);
  return out;
}

// ── 작은 함수들 ──────────────────────────────────────────

test("splitRowNo: 공백 있음·없음, 특수 열", () => {
  assert.deepEqual(sp.splitRowNo("A구역 10열"), { area: "A구역", row: "10" });
  assert.deepEqual(sp.splitRowNo("B구역10열"), { area: "B구역", row: "10" });
  assert.deepEqual(sp.splitRowNo("9구역 12열"), { area: "9구역", row: "12" });
  assert.deepEqual(sp.splitRowNo("가열"), { area: "", row: "가" });
  assert.deepEqual(sp.splitRowNo("차액"), { area: "", row: "차액" });
  assert.deepEqual(sp.splitRowNo(""), { area: "", row: "" });
});

test("decodeBits: 상위 비트부터, 패딩 제거, 길이·형식 오류는 null", () => {
  assert.deepEqual(sp.decodeBits("a", 4), [1, 0, 1, 0]);
  assert.deepEqual(sp.decodeBits("F8", 5), [1, 1, 1, 1, 1]);
  assert.deepEqual(sp.decodeBits("0", 3), [0, 0, 0]);
  assert.equal(sp.decodeBits("00", 3), null); // ceil(3/4) = 1자리여야 함
  assert.equal(sp.decodeBits("zz", 8), null);
});

test("parseQuery: blockKeys 여러 개", () => {
  const q = sp.parseQuery(musical.status[0].url);
  assert.deepEqual(q, { goodsCode: "26013198", playSeq: "010", blockKeys: ["010:001", "010:002", "010:003"] });
});

// ── 실제 데이터: 뮤지컬 (빈 좌석 있음) ───────────────────

test("뮤지컬 B구역: 해석 결과가 화면(research/03 대조)과 같다", () => {
  const { r } = feed(musical);
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.equal(r.goodsCode, "26013198");
  assert.equal(r.snapshot.playSeq, "010");
  assert.equal(r.snapshot.totalSeats, 222);
  const rows = byRow(r.snapshot.available);
  assert.deepEqual(rows["B구역 1"], [7, 8, 9, 10]);
  assert.deepEqual(rows["B구역 2"], [5, 6, 7, 8, 9, 10]);
  assert.deepEqual(rows["B구역 3"], [4, 5, 6, 7, 8, 9, 10]);
  assert.equal(rows["B구역 7"].length, 10);
  assert.deepEqual(rows["B구역 10"], [2, 3, 4, 5, 6, 7]);
  assert.equal(rows["B구역 11"], undefined);
  assert.equal(Object.keys(rows).some((k) => k.startsWith("A구역")), false);
  assert.equal(r.snapshot.available.length, 74);
  // 모든 예매 가능 좌석은 등급이 있다 (비노출 좌석 제외)
  assert.ok(r.snapshot.available.every((s) => s.grade === "전석"));
});

test("뮤지컬: 첫 응답에서 세 구역 모두 newBlocks, 반복 응답에서는 없음", () => {
  const { acc, r } = feed(musical);
  assert.deepEqual(r.newBlocks, ["010:001", "010:002", "010:003"]);
  const r2 = acc.addStatus(musical.status[1].url, JSON.stringify(musical.status[1].body), 5000);
  assert.deepEqual(r2.newBlocks, []);
  assert.equal(r2.snapshot.available.length, 74);
  assert.equal(r2.snapshot.takenAt, 5000);
});

// ── 실제 데이터: 성시경 (전석 매진) ──────────────────────

test("성시경 매진: 예매 가능 0석이지만 정상(매진)으로 본다", () => {
  const { r } = feed(soldout);
  assert.ok(!("error" in r));
  assert.equal(r.snapshot.available.length, 0);
  assert.equal(r.snapshot.totalSeats, 511);
});

test("성시경: 구역은 'FLOOR A구역', 열 '10', 통로에서 block 조각이 나뉜다", () => {
  const meta = soldout.meta[0].body.data[0];
  const layout = sp.layoutBlock(meta.blockKey, "001", meta.seats);
  const s = layout.seats.find((x) => x.id === "26015783:26001381:001:66233");
  assert.equal(s.zone, "FLOOR A구역");
  assert.equal(s.row, "10");
  assert.equal(s.col, 10);
  assert.equal(s.grade, "VIP석(현장수령)");
  assert.equal(s.key, "001|26015783:26001381:001:66233");
  // colIdx 틈이 있는 열은 조각이 2개 이상
  const segs = new Set(layout.seats.map((x) => x.block));
  assert.ok([...segs].every((b) => b.startsWith("001:001#")));
});

// ── 누적기 동작 ──────────────────────────────────────────

test("누적: 다음 응답에 없는 구역은 마지막 상태를 유지한다 (화면 이동)", () => {
  const { acc } = feed(musical);
  // B구역(010:002)만 담긴 응답: 다른 구역 상태는 그대로
  const url = musical.status[0].url.replace(/blockKeys=010%3A001&/, "").replace(/&blockKeys=010%3A003/, "");
  const onlyB = { data: [musical.status[0].body.data[1]] };
  const r = acc.addStatus(url, JSON.stringify(onlyB), 9000);
  assert.equal(r.snapshot.available.length, 74);
  assert.equal(r.snapshot.totalSeats, 222);
});

test("누적: 배치를 아직 못 받은 구역은 건너뛴다", () => {
  const acc = sp.createAccumulator();
  const r = acc.addStatus(musical.status[0].url, JSON.stringify(musical.status[0].body));
  assert.deepEqual(r.skipped, ["010:001", "010:002", "010:003"]);
  assert.equal(r.snapshot.available.length, 0);
});

test("누적: 회차가 바뀌면 비운다", () => {
  const { acc } = feed(musical);
  acc.addMeta(soldout.meta[0].url, soldout.meta[0].body);
  const r = acc.addStatus(soldout.status[0].url, soldout.status[0].body);
  assert.equal(r.snapshot.playSeq, "001");
  assert.equal(r.snapshot.totalSeats, 511); // 뮤지컬 222석이 섞이지 않음
});

test("누적: 형식 오류는 selector_mismatch", () => {
  const { acc } = feed(musical);
  const bad = { data: ["0", "0", "0"] };
  assert.equal(acc.addStatus(musical.status[0].url, JSON.stringify(bad)).error, "selector_mismatch");
  assert.equal(acc.addStatus(musical.status[0].url, "not json").error, "selector_mismatch");
  assert.equal(acc.addMeta(musical.meta[0].url, "{}").error, "selector_mismatch");
});

// ── 감지까지 이어서 (취소표 시뮬레이션) ─────────────────

/** 구역 상태 문자열에서 i번째 좌석 비트를 1로 */
function setBit(hex, i) {
  const chars = hex.split("");
  const c = Math.floor(i / 4);
  chars[c] = (parseInt(chars[c], 16) | (8 >> (i % 4))).toString(16);
  return chars.join("");
}

test("취소표 시뮬레이션: 매진 구역에 두 좌석이 풀리면 2연석 생김으로 알린다", () => {
  const { acc, r: first } = feed(soldout);
  const meta = soldout.meta[0].body.data[0].seats;
  // FLOOR A구역 10열 10·11번 (seatInfoId 66233, 66234)
  const i10 = meta.findIndex((s) => s.seatInfoId.endsWith(":66233"));
  const i11 = meta.findIndex((s) => s.seatInfoId.endsWith(":66234"));
  const body = structuredClone(soldout.status[0].body);
  body.data[0] = setBit(setBit(body.data[0], i10), i11);
  const second = acc.addStatus(soldout.status[0].url, JSON.stringify(body), 2000);
  assert.deepEqual(second.newBlocks, []);

  const prev = sp.withBaseline(first.snapshot, second.snapshot, second.newBlocks);
  const { events } = detect(prev, second.snapshot, { grades: ["VIP"], adjacent: 2 }, []);
  const found = events.filter((e) => e.matched && e.kind === "appeared");
  assert.equal(found.length, 1);
  assert.equal(formatSeatEvent(found[0]), "VIP석(현장수령) FLOOR A구역 10열 10·11번 (2연석) 생김");
});

test("처음 보는 구역의 기존 빈 좌석은 생김으로 알리지 않는다 (withBaseline)", () => {
  // 매진 공연을 보다가 → 빈 좌석이 있는 구역이 처음 화면에 들어온 상황을 같은 회차로 흉내
  const acc = sp.createAccumulator();
  const m = musical.meta;
  acc.addMeta(m[0].url, m[0].body); // 010:001, 010:002
  acc.addMeta(m[1].url, m[1].body); // 010:003
  const urlA = musical.status[0].url.replace(/&blockKeys=010%3A002&blockKeys=010%3A003/, "");
  const first = acc.addStatus(urlA, { data: [musical.status[0].body.data[0]] }, 1000); // A구역만 (전부 0)
  const second = acc.addStatus(musical.status[0].url, musical.status[0].body, 2000); // B구역 처음 등장 (74석)
  assert.deepEqual(second.newBlocks, ["010:002", "010:003"]);
  const prev = sp.withBaseline(first.snapshot, second.snapshot, second.newBlocks);
  const { events } = detect(prev, second.snapshot, {}, []);
  assert.deepEqual(events, []);
});
