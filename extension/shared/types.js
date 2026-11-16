// @ts-check
// 공용 타입 정의와 좌석 식별 유틸. chrome API에 의존하지 않는다.
// SW(ES module 부수효과 import), content script(classic), Node(require)에서 모두 쓴다. (DESIGN 2.1)

/**
 * @typedef {Object} Seat
 * @property {string} key      `${playSeq}|${id}` — 회차 간 충돌 방지, 중복 방지 집합의 키
 * @property {string} id       사이트 좌석 ID. 없으면 `${zone}|${row}|${col}`
 * @property {string} playSeq  회차
 * @property {string} grade    "R", "S", "VIP" …
 * @property {string} zone     "1층 A구역" 등. 모르면 ""
 * @property {string} block    통로로 나뉜 블록. 모르면 ""
 * @property {string} row      열 (예: "7", "가")
 * @property {number} col      번호
 * @property {number} seenAt   epoch ms
 */

/**
 * @typedef {Object} Snapshot
 * @property {string} playSeq
 * @property {"net"|"dom"} source
 * @property {Seat[]} available   예매 가능 좌석
 * @property {number} totalSeats  예매 가능 + 불가 좌석 전체 수
 * @property {number} takenAt
 */

/**
 * @typedef {Object} SeatEvent
 * @property {"appeared"|"disappeared"} kind
 * @property {Seat[]} seats
 * @property {boolean} matched
 */

/**
 * @typedef {Object} Filter
 * @property {string[]} [grades]
 * @property {string[]} [zones]
 * @property {{from: number, to: number} | null} [rowRange]
 * @property {string[] | null} [rows]
 * @property {number} [adjacent]       기본 1
 * @property {string | null} [regex]   좌석 라벨 "{grade}|{zone}|{block}|{row}|{col}"과 비교
 * @property {boolean} [alertOnFirst]
 */

/**
 * @typedef {"ok"|"logged_out"|"queue"|"expired"|"no_seat_map"|"selector_mismatch"|"parse_failed"|"stale"} PageState
 */

(function (root) {
  "use strict";

  /**
   * 사이트 좌석 ID가 없을 때 쓰는 대체 ID.
   * @param {string} zone @param {string} row @param {number} col
   */
  function fallbackSeatId(zone, row, col) {
    return `${zone}|${row}|${col}`;
  }

  /** @param {string} playSeq @param {string} id */
  function makeSeatKey(playSeq, id) {
    return `${playSeq}|${id}`;
  }

  /**
   * 정규식 필터와 비교하는 좌석 라벨.
   * @param {Seat} seat
   */
  function seatLabel(seat) {
    return `${seat.grade}|${seat.zone}|${seat.block}|${seat.row}|${seat.col}`;
  }

  const api = { fallbackSeatId, makeSeatKey, seatLabel };

  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.NCA ??= {}).types = api;
})(globalThis);
