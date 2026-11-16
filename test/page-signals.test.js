// shared/page-signals.js 테스트 (DESIGN 8). 응답 형식은 HAR에서 확인한 구조 (research/03).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { opName, parseExpired } = require("../extension/shared/page-signals.js");

test("opName: GraphQL 요청 본문에서 operationName만", () => {
  assert.equal(opName(JSON.stringify({ operationName: "ExpiredSession", query: "query { isExpiredSession }", variables: { x: 1 } })), "ExpiredSession");
  assert.equal(opName({ operationName: "InitSeat" }), "InitSeat");
  assert.equal(opName(JSON.stringify([{ operationName: "A" }, { operationName: "B" }])), "A");
  assert.equal(opName("not json"), null);
  assert.equal(opName(JSON.stringify({ query: "{ x }" })), null);
  assert.equal(opName(null), null);
});

test("parseExpired: true/false만 인정, 그 외는 null", () => {
  assert.equal(parseExpired(JSON.stringify({ data: { isExpiredSession: true } })), true);
  assert.equal(parseExpired(JSON.stringify({ data: { isExpiredSession: false } })), false); // 입장 때의 확인 질의
  assert.equal(parseExpired({ data: { isExpiredSession: "true" } }), null);
  assert.equal(parseExpired(JSON.stringify({ errors: [{ message: "x" }] })), null);
  assert.equal(parseExpired("<html>"), null);
});
