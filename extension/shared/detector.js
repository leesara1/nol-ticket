// @ts-check
// 좌석 감지 로직 (DESIGN 6절). 순수 함수, chrome API 의존 없음.

(function (root) {
  "use strict";

  /** @type {{ seatLabel: (seat: import("./types.js").Seat) => string }} */
  const types =
    typeof module === "object" && module.exports ? require("./types.js") : root.NCA.types;

  /**
   * @typedef {import("./types.js").Seat} Seat
   * @typedef {import("./types.js").Snapshot} Snapshot
   * @typedef {import("./types.js").SeatEvent} SeatEvent
   * @typedef {import("./types.js").Filter} Filter
   */

  /**
   * 누락된 필터 항목에 기본값을 채운다.
   * @param {Filter | undefined} filter
   * @returns {Required<Filter>}
   */
  function normalizeFilter(filter) {
    const f = filter ?? {};
    const adjacent = Number.isInteger(f.adjacent) && /** @type {number} */ (f.adjacent) >= 1 ? /** @type {number} */ (f.adjacent) : 1;
    return {
      grades: f.grades ?? [],
      zones: f.zones ?? [],
      rowRange: f.rowRange ?? null,
      rows: f.rows ?? null,
      adjacent,
      regex: f.regex ?? null,
      alertOnFirst: f.alertOnFirst ?? false,
    };
  }

  /**
   * 등급 일치: 같거나, 좌석 등급이 "{입력}석"으로 시작 (DESIGN 6). 예 "R" → "R석(현장수령)"
   * @param {string} grade @param {string} want
   */
  function gradeMatches(grade, want) {
    return grade === want || grade.startsWith(`${want}석`);
  }

  /**
   * 구역 일치: 같거나, 공백으로 나눈 조각 중 하나와 같음 (DESIGN 6). 예 "A구역" → "FLOOR A구역", "1층" → "1층 9구역"
   * @param {string} zone @param {string} want
   */
  function zoneMatches(zone, want) {
    return zone === want || zone.split(/\s+/).includes(want);
  }

  /**
   * 좌석 하나가 필터 조건을 만족하는지.
   * @param {Seat} seat
   * @param {Required<Filter>} f
   * @param {RegExp | null} re
   */
  function passesFilter(seat, f, re) {
    if (f.grades.length > 0 && !f.grades.some((g) => gradeMatches(seat.grade, g))) return false;
    if (f.zones.length > 0 && !f.zones.some((z) => zoneMatches(seat.zone, z))) return false;
    if (f.rows && f.rows.length > 0 && !f.rows.includes(seat.row)) return false;
    if (f.rowRange) {
      if (!/^\d+$/.test(seat.row)) return false;
      const n = Number(seat.row);
      if (n < f.rowRange.from || n > f.rowRange.to) return false;
    }
    if (re && !re.test(types.seatLabel(seat))) return false;
    return true;
  }

  /**
   * 같은 (playSeq, zone, block, row)에서 번호가 연속인 묶음으로 나눈다.
   * @param {Seat[]} seats
   * @returns {Seat[][]}
   */
  function buildRuns(seats) {
    /** @type {Map<string, Seat[]>} */
    const groups = new Map();
    for (const s of seats) {
      const g = `${s.playSeq}\u0000${s.zone}\u0000${s.block}\u0000${s.row}`;
      const list = groups.get(g);
      if (list) list.push(s);
      else groups.set(g, [s]);
    }

    /** @type {Seat[][]} */
    const runs = [];
    for (const list of groups.values()) {
      list.sort((a, b) => a.col - b.col);
      /** @type {Seat[]} */
      let run = [];
      for (const s of list) {
        const last = run[run.length - 1];
        if (last && s.col === last.col) continue; // 같은 번호 중복 데이터는 무시
        if (last && s.col !== last.col + 1) {
          runs.push(run);
          run = [];
        }
        run.push(s);
      }
      if (run.length > 0) runs.push(run);
    }
    return runs;
  }

  /**
   * 이전 스냅샷과 비교해 좌석 이벤트를 만든다.
   *
   * @param {Snapshot | null} prev     직전 정상 스냅샷 (실패 스냅샷은 넘기지 않는다)
   * @param {Snapshot} curr
   * @param {Filter | undefined} filter
   * @param {Iterable<string>} alerted 이미 알린 좌석 key
   * @returns {{ events: SeatEvent[], alerted: Set<string> }}
   */
  function detect(prev, curr, filter, alerted) {
    const f = normalizeFilter(filter);
    const re = f.regex ? new RegExp(f.regex) : null;
    const nextAlerted = new Set(alerted);
    /** @type {SeatEvent[]} */
    const events = [];

    const base = prev && prev.playSeq === curr.playSeq ? prev : null;
    const currKeys = new Set(curr.available.map((s) => s.key));

    // 사라짐: 이전에 알린 좌석 중 현재 없는 것
    if (base) {
      const gone = base.available.filter((s) => !currKeys.has(s.key) && nextAlerted.has(s.key));
      if (gone.length > 0) events.push({ kind: "disappeared", seats: gone, matched: true });
    }
    // 같은 회차에서 지금 없는 좌석은 alerted에서 뺀다 (다시 생기면 다시 알리도록). 다른 회차 key는 건드리지 않는다.
    const prefix = `${curr.playSeq}|`;
    for (const k of [...nextAlerted]) {
      if (k.startsWith(prefix) && !currKeys.has(k)) nextAlerted.delete(k);
    }

    // 첫 스냅샷: alertOnFirst가 아니면 기준으로만 쓴다
    if (!base && !f.alertOnFirst) return { events, alerted: nextAlerted };

    /** @type {Set<string>} */
    const appearedKeys = base
      ? (() => {
          const prevKeys = new Set(base.available.map((s) => s.key));
          return new Set(curr.available.filter((s) => !prevKeys.has(s.key)).map((s) => s.key));
        })()
      : new Set(currKeys);

    if (appearedKeys.size === 0) return { events, alerted: nextAlerted };

    // 조건 일치 묶음
    const candidates = curr.available.filter((s) => passesFilter(s, f, re));
    /** @type {Set<string>} */
    const inMatchedRun = new Set();
    for (const run of buildRuns(candidates)) {
      if (run.length < f.adjacent) continue;
      if (!run.some((s) => appearedKeys.has(s.key))) continue;
      for (const s of run) inMatchedRun.add(s.key);
      if (run.every((s) => nextAlerted.has(s.key))) continue; // 이미 알린 묶음
      for (const s of run) nextAlerted.add(s.key);
      events.push({ kind: "appeared", seats: run, matched: true });
    }

    // 조건 불일치 새 좌석 (로그용)
    const unmatched = curr.available.filter((s) => appearedKeys.has(s.key) && !inMatchedRun.has(s.key));
    if (unmatched.length > 0) events.push({ kind: "appeared", seats: unmatched, matched: false });

    return { events, alerted: nextAlerted };
  }

  const api = { detect, normalizeFilter, passesFilter, buildRuns, gradeMatches, zoneMatches };

  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.NCA ??= {}).detector = api;
})(globalThis);
