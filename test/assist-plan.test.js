// shared/assist-plan.js 테스트 (DESIGN 11.1.1)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { planHighlight } = require("../extension/shared/assist-plan.js");

const seat = (row, col, o = {}) => ({
  key: `001|${row}-${col}`, id: `${row}-${col}`, playSeq: "001", grade: "R석", zone: "1층 A구역", block: "b#0",
  row, col, seenAt: 0, x: col * 10, y: Number(row) * 10, ...o,
});
const ev = (kind, seats, matched = true) => ({ kind, seats, matched });

test("1순위: 연석이 긴 묶음", () => {
  const p = planHighlight([ev("appeared", [seat("3", 1)]), ev("appeared", [seat("9", 4), seat("9", 5)])]);
  assert.deepEqual(p.add.filter((t) => t.best).map((t) => t.key), ["001|9-4", "001|9-5"]);
  assert.equal(p.banner, "취소표: R석 1층 A구역 9열 4·5번 (2연석) 외 1곳 — 깜빡이는 곳을 누르세요");
});

test("연석 길이가 같으면 앞 열, 그다음 작은 번호", () => {
  const p = planHighlight([ev("appeared", [seat("7", 2)]), ev("appeared", [seat("3", 9)]), ev("appeared", [seat("3", 4)])]);
  assert.deepEqual(p.add.find((t) => t.best).key, "001|3-4");
});

test("좌표를 그대로 넘긴다", () => {
  const p = planHighlight([ev("appeared", [seat("2", 3, { x: 512.5, y: 300.25 })])]);
  assert.deepEqual(p.add, [{ key: "001|2-3", x: 512.5, y: 300.25, best: true }]);
});

test("조건 불일치 새 좌석은 표시하지 않고, 사라진 좌석은 지운다", () => {
  const p = planHighlight([ev("appeared", [seat("1", 1)], false), ev("disappeared", [seat("4", 4), seat("4", 5)])]);
  assert.deepEqual(p.add, []);
  assert.deepEqual(p.remove, ["001|4-4", "001|4-5"]);
  assert.equal(p.banner, null);
});

test("문자 열(가, 나)은 숫자 열 뒤로", () => {
  const p = planHighlight([ev("appeared", [seat("가", 1)]), ev("appeared", [seat("12", 1)])]);
  assert.equal(p.add.find((t) => t.best).key, "001|12-1");
});
