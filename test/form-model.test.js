// 옵션 폼 ↔ 설정 왕복 테스트 (DESIGN 12.5)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { configToForm, formToConfig } = require("../extension/options/form-model.js");
const { defaultUserConfig, validateUserConfig } = require("../extension/shared/config-validate.js");

/** 폼 값을 저장하는 흐름 그대로: 폼 → 원본 → 검증 */
function save(values, prev) {
  const r = formToConfig(values, prev);
  if (r.error) return { error: r.error };
  return validateUserConfig(r.input);
}

const sample = () => validateUserConfig({
  targets: [
    {
      goodsCode: "26015783",
      playSeq: ["001", "002"],
      filter: { grades: ["R", "VIP"], zones: ["1층 A구역"], rowRange: { from: 1, to: 10 }, rows: null, adjacent: 2, regex: "\\|7\\|", alertOnFirst: true },
    },
    { goodsCode: "99999999", playSeq: [], filter: { grades: ["S"] } },
  ],
  notify: { sound: true, desktop: false, telegram: { enabled: true, token: "t", chatId: "c" } },
  profile: { name: "홍길동", phone: "010", email: "a@b.c" },
}).config;

test("기본 설정은 왕복해도 그대로", () => {
  const c = defaultUserConfig();
  const r = save(configToForm(c), c);
  assert.deepEqual(r.config, c);
  assert.deepEqual(r.warnings, []);
});

test("값이 채워진 설정도 왕복해도 그대로 (두 번째 대상 공연 보존 포함)", () => {
  const c = sample();
  const r = save(configToForm(c), c);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.config, c);
});

test("폼에서 첫 대상 공연을 지워도 나머지 대상 공연은 남는다", () => {
  const c = sample();
  const v = { ...configToForm(c), goodsCode: "", playSeq: "", grades: "", zones: "", rowFrom: "", rowTo: "", regex: "" };
  const r = save(v, c);
  assert.deepEqual(r.config.targets.map((t) => t.goodsCode), ["99999999"]);
});

test("상품코드 없이 조건만 입력하면 저장하지 않고 오류", () => {
  const v = { ...configToForm(defaultUserConfig()), grades: "R" };
  const r = save(v, defaultUserConfig());
  assert.match(r.error, /상품코드/);
});

test("열 범위를 한쪽만 입력하면 저장하지 않고 오류", () => {
  const v = { ...configToForm(defaultUserConfig()), goodsCode: "1", rowFrom: "3" };
  const r = save(v, defaultUserConfig());
  assert.match(r.error, /열 범위/);
});

test("잘못된 값은 고쳐서 저장되고 경고가 나온다 (연석 수 0 → 1)", () => {
  const v = { ...configToForm(defaultUserConfig()), goodsCode: "1", adjacent: "0" };
  const r = save(v, defaultUserConfig());
  assert.equal(r.config.targets[0].filter.adjacent, 1);
  assert.ok(r.warnings.some((w) => w.includes("adjacent")));
});

test("prevConfig가 없어도 동작한다", () => {
  const r = formToConfig(configToForm(defaultUserConfig()), undefined);
  assert.equal(r.error, null);
  assert.deepEqual(r.input.targets, []);
});
