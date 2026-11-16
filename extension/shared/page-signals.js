// @ts-check
// 페이지 상태 신호 해석 (DESIGN 8). 순수 모듈 (2.1 형식): net-tap이 넘긴 GraphQL 응답을 해석한다.
// 요청이 왔다는 사실이 아니라 응답 값으로 판정한다 (ExpiredSession은 입장 때마다 확인 질의로 호출됨).

(function (root) {
  "use strict";

  /**
   * GraphQL 요청 본문에서 operationName만 꺼낸다. 다른 값(변수 등)은 보지 않는다.
   * 배열(일괄 요청)이면 첫 번째 것.
   * @param {unknown} body  문자열 또는 객체
   * @returns {string | null}
   */
  function opName(body) {
    let j = body;
    if (typeof body === "string") {
      try { j = JSON.parse(body); } catch { return null; }
    }
    const first = Array.isArray(j) ? j[0] : j;
    const op = /** @type {any} */ (first)?.operationName;
    return typeof op === "string" && op ? op : null;
  }

  /**
   * ExpiredSession 응답 `{data: {isExpiredSession: bool}}` → true/false. 형식이 다르면 null.
   * @param {unknown} body
   * @returns {boolean | null}
   */
  function parseExpired(body) {
    let j = body;
    if (typeof body === "string") {
      try { j = JSON.parse(body); } catch { return null; }
    }
    const v = /** @type {any} */ (j)?.data?.isExpiredSession;
    return typeof v === "boolean" ? v : null;
  }

  const api = { opName, parseExpired };

  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.NCA ??= {}).pageSignals = api;
})(globalThis);
