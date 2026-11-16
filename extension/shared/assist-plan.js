// @ts-check
// 강조 계획 (DESIGN 11.1.1). 감지 이벤트 → 화면에 표시할 좌석·지울 좌석·안내 문구.
// 순수 모듈 (2.1 형식): SW와 Node 테스트에서 쓴다.

(function (root) {
  "use strict";

  /** @type {{ formatSeatEvent: (e: any, o?: any) => string }} */
  const format =
    typeof module === "object" && module.exports ? require("./format.js") : root.NCA?.format;
  if (!format) throw new Error("[nca] assist-plan.js보다 shared/format.js를 먼저 불러와야 합니다");

  /**
   * @typedef {import("./types.js").SeatEvent} SeatEvent
   * @typedef {{ key: string, x: number, y: number, best: boolean }} Target
   * @typedef {{ add: Target[], remove: string[], banner: string | null }} HighlightPlan
   */

  /** 열을 숫자로 (문자 열은 뒤로) @param {string} row */
  const rowNum = (row) => (/^\d+$/.test(row) ? Number(row) : Number.MAX_SAFE_INTEGER);

  /**
   * 1순위 정렬: 연석이 긴 것 → 앞 열(숫자 작은 열) → 번호 작은 것.
   * @param {SeatEvent} a @param {SeatEvent} b
   */
  function compareEvents(a, b) {
    if (b.seats.length !== a.seats.length) return b.seats.length - a.seats.length;
    const ra = Math.min(...a.seats.map((s) => rowNum(s.row)));
    const rb = Math.min(...b.seats.map((s) => rowNum(s.row)));
    if (ra !== rb) return ra - rb;
    return Math.min(...a.seats.map((s) => s.col)) - Math.min(...b.seats.map((s) => s.col));
  }

  /**
   * @param {SeatEvent[]} events  detector 결과
   * @returns {HighlightPlan}
   */
  function planHighlight(events) {
    const found = events.filter((e) => e.kind === "appeared" && e.matched).sort(compareEvents);
    const remove = events.filter((e) => e.kind === "disappeared").flatMap((e) => e.seats.map((s) => s.key));
    /** @type {Target[]} */
    const add = found.flatMap((e, i) =>
      e.seats.map((s) => ({ key: s.key, x: Number(s.x) || 0, y: Number(s.y) || 0, best: i === 0 })),
    );
    let banner = null;
    if (found.length > 0) {
      const rest = found.length - 1;
      banner = `취소표: ${format.formatSeatEvent(found[0]).replace(/ 생김$/, "")}${rest > 0 ? ` 외 ${rest}곳` : ""} — 깜빡이는 곳을 누르세요`;
    }
    return { add, remove, banner };
  }

  const api = { planHighlight, compareEvents };

  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.NCA ??= {}).assistPlan = api;
})(globalThis);
