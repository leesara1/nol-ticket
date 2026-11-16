// @ts-check
// 알림 문구·로그 변환 (DESIGN 10.1, 16.1). 순수 함수, chrome API 의존 없음.

(function (root) {
  "use strict";

  /**
   * @typedef {import("./types.js").Seat} Seat
   * @typedef {import("./types.js").SeatEvent} SeatEvent
   * @typedef {import("./types.js").PageState} PageState
   *
   * @typedef {Object} LogSeat
   * @property {string} grade
   * @property {string} zone
   * @property {string} row
   * @property {number} col
   *
   * @typedef {Object} LogEntry
   * @property {number} t
   * @property {"appeared"|"disappeared"|"blind"|"recovered"} kind
   * @property {string} goodsCode
   * @property {string} playSeq
   * @property {boolean} matched
   * @property {LogSeat[]} seats
   * @property {string} [reason]
   */

  const MAX_GROUPS = 4;

  /** @param {number} n */
  const pad2 = (n) => String(n).padStart(2, "0");

  /**
   * 번호 목록을 "12·13번 (2연석)" 또는 "12번" 또는 "3·7번"으로.
   * @param {number[]} cols 정렬된 번호
   */
  function colsText(cols) {
    const nums = cols.join("·") + "번";
    const consecutive = cols.length >= 2 && cols.every((c, i) => i === 0 || c === cols[i - 1] + 1);
    return consecutive ? `${nums} (${cols.length}연석)` : nums;
  }

  /**
   * 좌석 묶음 하나의 앞부분: "R석 1층 A구역 7열". 빈 항목은 생략.
   * @param {{grade: string, zone: string, row: string}} s
   */
  function placeText(s) {
    // 실제 등급 이름은 "VIP석(현장수령)"·"전석"처럼 이미 "석"을 포함한다. 없을 때만 붙인다 ("R" → "R석")
    const grade = !s.grade ? "" : s.grade.includes("석") ? s.grade : `${s.grade}석`;
    return [grade, s.zone, s.row ? `${s.row}열` : ""].filter(Boolean).join(" ");
  }

  /**
   * 좌석들을 사람이 읽는 문구로. 같은 (grade, zone, row)끼리 묶는다.
   * @param {Array<{grade: string, zone: string, row: string, col: number}>} seats
   */
  function seatsText(seats) {
    /** @type {Map<string, {grade: string, zone: string, row: string, cols: number[]}>} */
    const groups = new Map();
    for (const s of seats) {
      const k = `${s.grade}\u0000${s.zone}\u0000${s.row}`;
      const g = groups.get(k) ?? { grade: s.grade, zone: s.zone, row: s.row, cols: [] };
      g.cols.push(s.col);
      groups.set(k, g);
    }
    const parts = [...groups.values()].map((g) => {
      const cols = [...new Set(g.cols)].sort((a, b) => a - b);
      return { text: [placeText(g), colsText(cols)].filter(Boolean).join(" "), count: cols.length };
    });
    const shown = parts.slice(0, MAX_GROUPS).map((p) => p.text);
    const restCount = parts.slice(MAX_GROUPS).reduce((n, p) => n + p.count, 0);
    return shown.join(", ") + (restCount > 0 ? ` 외 ${restCount}석` : "");
  }

  /**
   * 좌석 이벤트 알림 문구.
   * 예: "[12/31 21:00] R석 1층 A구역 7열 12·13번 (2연석) 생김"
   * @param {SeatEvent} event
   * @param {{ playLabel?: string }} [opts]
   */
  function formatSeatEvent(event, opts = {}) {
    const head = opts.playLabel ? `[${opts.playLabel}] ` : "";
    const tail = event.kind === "appeared" ? "생김" : "사라짐";
    return `${head}${seatsText(event.seats)} ${tail}`;
  }

  /** @type {Record<string, string>} */
  const BLIND_TEXT = {
    logged_out: "로그아웃 상태입니다. 다시 로그인해 주세요",
    queue: "대기열 화면입니다. 좌석 화면에 들어가면 다시 감시합니다",
    expired: "좌석 선택 시간이 끝났습니다. 다시 들어가야 감시할 수 있습니다",
    no_seat_map: "좌석맵을 찾지 못했습니다. 좌석 선택 화면을 열어 주세요",
    selector_mismatch: "좌석맵 구조가 바뀐 것 같습니다. 사이트 설정 확인이 필요합니다",
    parse_failed: "좌석 정보를 읽지 못했습니다",
    stale: "30초 동안 좌석맵 응답이 없습니다. 좌석 선택 시간이 끝났거나, 탭이 뒤에 있어 갱신이 느려졌을 수 있습니다. 좌석 탭을 화면 앞에 두세요",
  };

  /**
   * 감시 불능 사유 문구.
   * @param {PageState | string} reason
   */
  function formatBlind(reason) {
    return `감시 불능: ${blindText(reason)}`;
  }

  /**
   * 감시 불능 사유만 (팝업 표시용).
   * @param {PageState | string} reason
   */
  function blindText(reason) {
    return BLIND_TEXT[reason] ?? `알 수 없는 상태 (${reason})`;
  }

  function formatRecovered() {
    return "감시 복구: 좌석맵을 다시 읽고 있습니다";
  }

  /**
   * 현지 시간 기준 날짜 키 "YYYY-MM-DD".
   * @param {number} ts epoch ms
   */
  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /**
   * 현지 시간 "YYYY-MM-DD HH:MM:SS".
   * @param {number} ts epoch ms
   */
  function localTime(ts) {
    const d = new Date(ts);
    return `${dayKey(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  /**
   * CSV 칸 하나. 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다.
   * 엑셀이 수식으로 실행하지 않도록 =, +, -, @, 탭, CR로 시작하면 앞에 '를 붙인다.
   * 구역 이름 등은 사이트에서 온 값이라 그대로 믿지 않는다.
   * @param {unknown} v
   */
  function csvCell(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /**
   * 로그 → CSV (DESIGN 16.1). 줄 끝은 \r\n (엑셀 호환).
   * @param {LogEntry[]} entries
   */
  function logToCsv(entries) {
    const header = ["time", "kind", "goodsCode", "playSeq", "matched", "seats", "reason"];
    const rows = entries.map((e) => [
      localTime(e.t),
      e.kind,
      e.goodsCode,
      e.playSeq,
      e.matched ? "true" : "false",
      (e.seats ?? []).map((s) => `${s.grade}/${s.zone}/${s.row}/${s.col}`).join(";"),
      e.reason ?? "",
    ]);
    return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  const api = { formatSeatEvent, formatBlind, blindText, formatRecovered, seatsText, dayKey, localTime, logToCsv };

  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.NCA ??= {}).format = api;
})(globalThis);
