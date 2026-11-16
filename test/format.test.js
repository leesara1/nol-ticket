// shared/format.js 테스트 (DESIGN 10.1, 16.1)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("../extension/shared/format.js");

const seat = (col, o = {}) => ({ grade: "R", zone: "1층 A구역", row: "7", col, ...o });

test("연석: R석 1층 A구역 7열 12·13번 (2연석) 생김", () => {
  const text = f.formatSeatEvent({ kind: "appeared", matched: true, seats: [seat(13), seat(12)] });
  assert.equal(text, "R석 1층 A구역 7열 12·13번 (2연석) 생김");
});

test("단일 좌석, 회차 라벨, 사라짐", () => {
  const text = f.formatSeatEvent({ kind: "disappeared", matched: true, seats: [seat(5)] }, { playLabel: "12/31 21:00" });
  assert.equal(text, "[12/31 21:00] R석 1층 A구역 7열 5번 사라짐");
});

test("연속이 아닌 번호는 연석 표시 없음", () => {
  assert.equal(f.seatsText([seat(3), seat(7)]), "R석 1층 A구역 7열 3·7번");
});

test("다른 열·구역은 묶음을 나눠 쉼표로 잇는다", () => {
  const text = f.seatsText([seat(1), seat(2), seat(9, { row: "8" })]);
  assert.equal(text, "R석 1층 A구역 7열 1·2번 (2연석), R석 1층 A구역 8열 9번");
});

test("묶음이 4개를 넘으면 '외 N석'", () => {
  const seats = [1, 2, 3, 4, 5, 6].map((r) => seat(1, { row: String(r) }));
  seats.push(seat(2, { row: "6" }));
  const text = f.seatsText(seats);
  assert.match(text, / 외 3석$/); // 5열 1석 + 6열 2석
  assert.equal(text.split(", ").length, 4);
});

test("등급·구역·열이 비어 있으면 생략", () => {
  assert.equal(f.seatsText([{ grade: "", zone: "", row: "", col: 4 }]), "4번");
});

test("같은 번호 중복은 한 번만", () => {
  assert.equal(f.seatsText([seat(1), seat(1)]), "R석 1층 A구역 7열 1번");
});

test("감시 불능 문구: 알려진 사유와 모르는 사유", () => {
  assert.match(f.formatBlind("queue"), /^감시 불능: 대기열/);
  assert.match(f.formatBlind("expired"), /좌석 선택 시간/);
  assert.equal(f.formatBlind("weird"), "감시 불능: 알 수 없는 상태 (weird)");
  assert.match(f.formatRecovered(), /^감시 복구/);
});

test("dayKey·localTime은 현지 시간 기준", () => {
  const ts = new Date(2026, 11, 31, 9, 5, 7).getTime(); // 현지 2026-12-31 09:05:07
  assert.equal(f.dayKey(ts), "2026-12-31");
  assert.equal(f.localTime(ts), "2026-12-31 09:05:07");
});

test("logToCsv: 헤더, 좌석 연결, 따옴표·쉼표·줄바꿈 처리", () => {
  const ts = new Date(2026, 10, 16, 9, 0, 0).getTime();
  const csv = f.logToCsv([
    { t: ts, kind: "appeared", goodsCode: "26015783", playSeq: "001", matched: true, seats: [seat(12), seat(13)] },
    { t: ts, kind: "blind", goodsCode: "26015783", playSeq: "001", matched: false, seats: [], reason: 'a,b "c"\nd' },
  ]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "time,kind,goodsCode,playSeq,matched,seats,reason");
  assert.equal(lines[1], "2026-11-16 09:00:00,appeared,26015783,001,true,R/1층 A구역/7/12;R/1층 A구역/7/13,");
  // 칸 안의 \n은 그대로 두고 따옴표로 감싼다 (행 구분은 \r\n)
  assert.equal(lines[2], '2026-11-16 09:00:00,blind,26015783,001,false,,"a,b ""c""\nd"');
  assert.ok(csv.endsWith("\r\n"));
});

test("logToCsv: =, +, -, @로 시작하는 칸은 엑셀 수식으로 실행되지 않게 ' 를 붙인다", () => {
  const csv = f.logToCsv([
    { t: 0, kind: "blind", goodsCode: "1", playSeq: "1", matched: false, seats: [{ grade: "=HYPERLINK(1)", zone: "z", row: "1", col: 1 }], reason: "@cmd" },
  ]);
  const row = csv.split("\r\n")[1];
  assert.ok(row.includes(",'=HYPERLINK(1)/z/1/1,"), row);
  assert.ok(row.endsWith(",'@cmd"), row);
});

test("blindText: 사유만", () => {
  assert.match(f.blindText("expired"), /^좌석 선택 시간/);
  assert.equal(f.blindText("x"), "알 수 없는 상태 (x)");
});

test("logToCsv: 빈 로그는 헤더만", () => {
  assert.equal(f.logToCsv([]), "time,kind,goodsCode,playSeq,matched,seats,reason\r\n");
});
