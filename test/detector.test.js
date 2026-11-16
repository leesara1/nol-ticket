// detector 단위 테스트 (DESIGN 6절, 17절)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detect, normalizeFilter, buildRuns } = require("../extension/shared/detector.js");
const { makeSeatKey, fallbackSeatId, seatLabel } = require("../extension/shared/types.js");

/**
 * 테스트용 좌석. id를 주지 않으면 대체 ID를 쓴다.
 * @param {Partial<import("../extension/shared/types.js").Seat> & {col: number}} p
 */
function seat(p) {
  const playSeq = p.playSeq ?? "001";
  const zone = p.zone ?? "1층 A구역";
  const row = p.row ?? "7";
  const id = p.id ?? fallbackSeatId(zone, row, p.col);
  return {
    key: makeSeatKey(playSeq, id),
    id,
    playSeq,
    grade: p.grade ?? "R",
    zone,
    block: p.block ?? "",
    row,
    col: p.col,
    seenAt: 0,
  };
}

/** @param {ReturnType<typeof seat>[]} available */
function snap(available, playSeq = "001") {
  return { playSeq, source: /** @type {const} */ ("net"), available, totalSeats: 100, takenAt: 0 };
}

const cols = (/** @type {{seats: {col: number}[]}} */ e) => e.seats.map((s) => s.col);

// ── types ────────────────────────────────────────────────

test("types: key는 회차를 포함해 회차 간 충돌하지 않는다", () => {
  const a = seat({ col: 1, playSeq: "001" });
  const b = seat({ col: 1, playSeq: "002" });
  assert.equal(a.id, b.id);
  assert.notEqual(a.key, b.key);
});

test("types: seatLabel 형식", () => {
  assert.equal(seatLabel(seat({ col: 12, block: "B1" })), "R|1층 A구역|B1|7|12");
});

// ── normalizeFilter ──────────────────────────────────────

test("normalizeFilter: 기본값", () => {
  assert.deepEqual(normalizeFilter(undefined), {
    grades: [], zones: [], rowRange: null, rows: null, adjacent: 1, regex: null, alertOnFirst: false,
  });
});

test("normalizeFilter: adjacent가 0·음수·소수면 1", () => {
  for (const v of [0, -2, 1.5]) assert.equal(normalizeFilter({ adjacent: v }).adjacent, 1);
  assert.equal(normalizeFilter({ adjacent: 3 }).adjacent, 3);
});

// ── buildRuns ────────────────────────────────────────────

test("buildRuns: 번호 연속끼리 묶고, 열·구역·블록이 다르면 나눈다", () => {
  const runs = buildRuns([
    seat({ col: 3 }), seat({ col: 1 }), seat({ col: 2 }), seat({ col: 5 }),
    seat({ col: 4, row: "8" }),
    seat({ col: 6, block: "B2" }),
  ]);
  const shape = runs.map((r) => r.map((s) => `${s.row}${s.block}:${s.col}`)).sort();
  assert.deepEqual(shape, [["7:1", "7:2", "7:3"], ["7:5"], ["7B2:6"], ["8:4"]].sort());
});

// ── detect: 기본 비교 ────────────────────────────────────

test("첫 스냅샷은 기준으로만 저장하고 알리지 않는다", () => {
  const r = detect(null, snap([seat({ col: 1 })]), {}, []);
  assert.deepEqual(r.events, []);
  assert.equal(r.alerted.size, 0);
});

test("alertOnFirst면 첫 스냅샷에서도 조건 일치 좌석을 알린다", () => {
  const r = detect(null, snap([seat({ col: 1 }), seat({ col: 2, grade: "S" })]), { grades: ["R"], alertOnFirst: true }, []);
  const matched = r.events.filter((e) => e.matched);
  assert.equal(matched.length, 1);
  assert.deepEqual(cols(matched[0]), [1]);
});

test("새 좌석이 생기면 appeared + matched", () => {
  const prev = snap([]);
  const r = detect(prev, snap([seat({ col: 12 })]), {}, []);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "appeared");
  assert.equal(r.events[0].matched, true);
  assert.ok(r.alerted.has(seat({ col: 12 }).key));
});

test("변화가 없으면 이벤트 없음", () => {
  const s = snap([seat({ col: 1 })]);
  const r = detect(s, snap([seat({ col: 1 })]), {}, [seat({ col: 1 }).key]);
  assert.deepEqual(r.events, []);
});

test("회차가 다르면 prev를 무시하고 첫 스냅샷처럼 처리", () => {
  const r = detect(snap([], "001"), snap([seat({ col: 1, playSeq: "002" })], "002"), {}, []);
  assert.deepEqual(r.events, []);
});

// ── detect: 필터 ─────────────────────────────────────────

test("필터: 등급·구역", () => {
  const curr = snap([
    seat({ col: 1, grade: "R" }),
    seat({ col: 5, grade: "S" }),
    seat({ col: 9, grade: "R", zone: "2층" }),
  ]);
  const r = detect(snap([]), curr, { grades: ["R"], zones: ["1층 A구역"] }, []);
  const matched = r.events.filter((e) => e.matched);
  assert.equal(matched.length, 1);
  assert.deepEqual(cols(matched[0]), [1]);
  const unmatched = r.events.find((e) => !e.matched);
  assert.deepEqual(unmatched && cols(unmatched).sort((a, b) => a - b), [5, 9]);
});

test("필터: rowRange는 숫자 열만 통과, 문자 열은 제외", () => {
  const curr = snap([seat({ col: 1, row: "3" }), seat({ col: 1, row: "10" }), seat({ col: 1, row: "가" })]);
  const r = detect(snap([]), curr, { rowRange: { from: 1, to: 5 } }, []);
  const matched = r.events.filter((e) => e.matched);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].seats[0].row, "3");
});

test("필터: rows 목록으로 문자 열 지정", () => {
  const curr = snap([seat({ col: 1, row: "가" }), seat({ col: 1, row: "다" })]);
  const r = detect(snap([]), curr, { rows: ["가", "나"] }, []);
  const matched = r.events.filter((e) => e.matched);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].seats[0].row, "가");
});

test("필터: regex는 좌석 라벨과 비교", () => {
  const curr = snap([seat({ col: 1, row: "7" }), seat({ col: 1, row: "20" })]);
  const r = detect(snap([]), curr, { regex: "\\|(7|8|9)\\|\\d+$" }, []);
  const matched = r.events.filter((e) => e.matched);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].seats[0].row, "7");
});

// ── detect: 연석 ─────────────────────────────────────────

test("연석: 이미 비어 있던 12번 옆에 13번이 생기면 12·13번 2연석으로 알린다", () => {
  const prev = snap([seat({ col: 12 })]);
  const curr = snap([seat({ col: 12 }), seat({ col: 13 })]);
  const r = detect(prev, curr, { adjacent: 2 }, []);
  const matched = r.events.filter((e) => e.matched && e.kind === "appeared");
  assert.equal(matched.length, 1);
  assert.deepEqual(cols(matched[0]), [12, 13]);
});

test("연석: 새 좌석이 없는 기존 묶음은 알리지 않는다", () => {
  const prev = snap([seat({ col: 1 }), seat({ col: 2 })]);
  const curr = snap([seat({ col: 1 }), seat({ col: 2 }), seat({ col: 30 })]);
  const r = detect(prev, curr, { adjacent: 2 }, []);
  assert.equal(r.events.filter((e) => e.matched).length, 0);
  const unmatched = r.events.find((e) => !e.matched);
  assert.deepEqual(unmatched && cols(unmatched), [30]);
});

test("연석: 묶음 길이가 adjacent보다 짧으면 matched 아님", () => {
  const r = detect(snap([]), snap([seat({ col: 1 }), seat({ col: 3 })]), { adjacent: 2 }, []);
  assert.equal(r.events.filter((e) => e.matched).length, 0);
});

test("연석: 블록(통로)이 다르면 번호가 이어져도 연석 아님", () => {
  const curr = snap([seat({ col: 10, block: "L" }), seat({ col: 11, block: "R" })]);
  const r = detect(snap([]), curr, { adjacent: 2 }, []);
  assert.equal(r.events.filter((e) => e.matched).length, 0);
});

test("연석: 필터에 걸린 좌석은 연석 계산에서 빠진다", () => {
  const curr = snap([seat({ col: 1, grade: "R" }), seat({ col: 2, grade: "S" }), seat({ col: 3, grade: "R" })]);
  const r = detect(snap([]), curr, { grades: ["R"], adjacent: 2 }, []);
  assert.equal(r.events.filter((e) => e.matched).length, 0);
});

// ── detect: 중복 방지 ────────────────────────────────────

test("중복 방지: 이미 알린 좌석만으로 된 묶음은 다시 알리지 않는다", () => {
  const a = seat({ col: 1 });
  const prev = snap([]);
  const first = detect(prev, snap([a]), {}, []);
  assert.equal(first.events.length, 1);
  // prev가 유실돼 같은 좌석이 다시 '생김'으로 보이는 경우
  const again = detect(snap([]), snap([a]), {}, first.alerted);
  assert.equal(again.events.filter((e) => e.matched).length, 0);
});

test("중복 방지: 사라졌다가 다시 생기면 다시 알린다", () => {
  const a = seat({ col: 1 });
  const r1 = detect(snap([]), snap([a]), {}, []);
  const r2 = detect(snap([a]), snap([]), {}, r1.alerted);
  assert.equal(r2.alerted.has(a.key), false);
  const r3 = detect(snap([]), snap([a]), {}, r2.alerted);
  assert.equal(r3.events.filter((e) => e.matched).length, 1);
});

test("중복 방지: 알린 묶음에 새 좌석이 붙으면 묶음 전체를 다시 알린다", () => {
  const a = seat({ col: 1 });
  const b = seat({ col: 2 });
  const r1 = detect(snap([]), snap([a]), {}, []);
  const r2 = detect(snap([a]), snap([a, b]), {}, r1.alerted);
  const matched = r2.events.filter((e) => e.matched);
  assert.equal(matched.length, 1);
  assert.deepEqual(cols(matched[0]), [1, 2]);
});

test("중복 방지: 다른 회차의 alerted key는 지우지 않는다", () => {
  const other = seat({ col: 1, playSeq: "002" });
  const r = detect(snap([]), snap([]), {}, [other.key]);
  assert.ok(r.alerted.has(other.key));
});

// ── detect: 사라짐 ───────────────────────────────────────

test("사라짐: 알린 좌석이 사라지면 disappeared", () => {
  const a = seat({ col: 1 });
  const r1 = detect(snap([]), snap([a]), {}, []);
  const r2 = detect(snap([a]), snap([]), {}, r1.alerted);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].kind, "disappeared");
  assert.deepEqual(cols(r2.events[0]), [1]);
});

test("사라짐: 알리지 않은 좌석이 사라지면 이벤트 없음", () => {
  const r = detect(snap([seat({ col: 1, grade: "S" })]), snap([]), { grades: ["R"] }, []);
  assert.deepEqual(r.events, []);
});

// ── detect: 입력 불변 ────────────────────────────────────

test("입력을 변경하지 않는다", () => {
  const prev = snap([seat({ col: 1 })]);
  const curr = snap([seat({ col: 2 }), seat({ col: 1 })]);
  const alerted = new Set([seat({ col: 1 }).key]);
  const before = JSON.stringify({ prev, curr, alerted: [...alerted] });
  detect(prev, curr, { adjacent: 2 }, alerted);
  assert.equal(JSON.stringify({ prev, curr, alerted: [...alerted] }), before);
});

// ── 로딩 방식 (DESIGN 2.1) ───────────────────────────────

test("content script처럼 classic script로 순서대로 로드하면 globalThis.NCA에 붙는다", () => {
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const ctx = vm.createContext({});
  for (const f of ["types.js", "detector.js"]) {
    const code = fs.readFileSync(path.join(__dirname, "../extension/shared", f), "utf8");
    vm.runInContext(code, ctx, { filename: f });
  }
  const NCA = vm.runInContext("globalThis.NCA", ctx);
  assert.equal(typeof NCA.types.makeSeatKey, "function");
  assert.equal(typeof NCA.detector.detect, "function");
  const r = NCA.detector.detect(snap([]), snap([seat({ col: 1 })]), {}, []);
  assert.equal(r.events.length, 1);
});

// ── 등급·구역 일치 규칙 (DESIGN 6, 실제 데이터 형식) ──────

test("등급: 'R'은 'R석(현장수령)', 'S'는 'S석'과 일치, '시야제한석'은 그대로", () => {
  const { gradeMatches } = require("../extension/shared/detector.js");
  assert.equal(gradeMatches("R석(현장수령)", "R"), true);
  assert.equal(gradeMatches("VIP석(현장수령)", "VIP"), true);
  assert.equal(gradeMatches("S석", "S"), true);
  assert.equal(gradeMatches("시야제한석", "시야제한석"), true);
  assert.equal(gradeMatches("시야제한석", "S"), false);
  assert.equal(gradeMatches("VIP석(현장수령)", "V"), false);
});

test("구역: 'A구역'은 'FLOOR A구역', '1층'은 '1층 9구역'과 일치", () => {
  const { zoneMatches } = require("../extension/shared/detector.js");
  assert.equal(zoneMatches("FLOOR A구역", "A구역"), true);
  assert.equal(zoneMatches("1층 9구역", "1층"), true);
  assert.equal(zoneMatches("1층 9구역", "9구역"), true);
  assert.equal(zoneMatches("1층 19구역", "9구역"), false);
  assert.equal(zoneMatches("B구역", "B구역"), true);
});
