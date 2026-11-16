// config-validate 단위 테스트 (DESIGN 12.3)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultUserConfig,
  validateUserConfig,
  validateSiteConfig,
} = require("../extension/shared/config-validate.js");

// ── defaultUserConfig ────────────────────────────────────

test("defaultUserConfig: 12.2 구조, targets·windows는 빈 배열", () => {
  assert.deepEqual(defaultUserConfig(), {
    targets: [],
    refresh: { enabled: false, intervalSec: 60, windows: [] },
    notify: {
      sound: true,
      desktop: true,
      telegram: { enabled: false, token: "", chatId: "" },
    },
    profile: { name: "", phone: "", email: "" },
  });
});

// ── 입력 전체 ────────────────────────────────────────────

test("입력이 객체가 아니면 기본값 + 경고", () => {
  for (const bad of [null, undefined, 1, "x", []]) {
    const { config, warnings } = validateUserConfig(bad);
    assert.deepEqual(config, defaultUserConfig());
    assert.ok(warnings.length >= 1);
    assert.match(warnings[0], /객체가 아님/);
  }
});

// ── targets ──────────────────────────────────────────────

test("targets: 배열이 아니면 []", () => {
  const { config, warnings } = validateUserConfig({ targets: "nope" });
  assert.deepEqual(config.targets, []);
  assert.ok(warnings.some((w) => w.includes("targets")));
});

test("targets: goodsCode가 숫자 문자열이 아니면 그 target 제거", () => {
  const { config, warnings } = validateUserConfig({
    targets: [
      { goodsCode: "26015783", playSeq: ["001"], filter: {} },
      { goodsCode: "abc", playSeq: [], filter: {} },
      { goodsCode: 26015783, playSeq: [], filter: {} },
    ],
  });
  assert.equal(config.targets.length, 1);
  assert.equal(config.targets[0].goodsCode, "26015783");
  assert.ok(warnings.some((w) => w.includes("goodsCode") && w.includes("제거")));
});

test("targets: playSeq는 문자열 배열, 빈 문자열 제거", () => {
  const { config } = validateUserConfig({
    targets: [{ goodsCode: "1", playSeq: ["001", "", 2, null, "002"], filter: {} }],
  });
  assert.deepEqual(config.targets[0].playSeq, ["001", "002"]);
});

test("targets: filter는 normalizeFilter + regex 컴파일 실패 시 null", () => {
  const { config, warnings } = validateUserConfig({
    targets: [{ goodsCode: "1", playSeq: [], filter: { adjacent: 2, regex: "[" } }],
  });
  assert.equal(config.targets[0].filter.adjacent, 2);
  assert.equal(config.targets[0].filter.regex, null);
  assert.ok(warnings.some((w) => w.includes("regex") && w.includes("null")));
});

test("targets: rowRange가 from ≤ to인 정수가 아니면 null", () => {
  const cases = [
    { from: 5, to: 3 },
    { from: 1.5, to: 2 },
    { from: 1, to: "2" },
  ];
  for (const rowRange of cases) {
    const { config, warnings } = validateUserConfig({
      targets: [{ goodsCode: "1", playSeq: [], filter: { rowRange } }],
    });
    assert.equal(config.targets[0].filter.rowRange, null);
    assert.ok(warnings.some((w) => w.includes("rowRange")));
  }
  const ok = validateUserConfig({
    targets: [{ goodsCode: "1", playSeq: [], filter: { rowRange: { from: 1, to: 5 } } }],
  });
  assert.deepEqual(ok.config.targets[0].filter.rowRange, { from: 1, to: 5 });
  assert.equal(ok.warnings.filter((w) => w.includes("rowRange")).length, 0);
});

// ── refresh.intervalSec ──────────────────────────────────

test("refresh.intervalSec: 정수 아니면 60, 30 미만이면 30 + 경고", () => {
  const a = validateUserConfig({ refresh: { intervalSec: 10 } });
  assert.equal(a.config.refresh.intervalSec, 30);
  assert.ok(a.warnings.some((w) => w.includes("10 → 30")));

  const b = validateUserConfig({ refresh: { intervalSec: 1.5 } });
  assert.equal(b.config.refresh.intervalSec, 60);
  assert.ok(b.warnings.some((w) => w.includes("→ 60")));

  const c = validateUserConfig({ refresh: { intervalSec: 45 } });
  assert.equal(c.config.refresh.intervalSec, 45);
  assert.equal(c.warnings.filter((w) => w.includes("intervalSec")).length, 0);
});

// ── refresh.windows ──────────────────────────────────────

test("refresh.windows: HH:MM이 아닌 항목 제거, from > to는 자정 넘김으로 유지", () => {
  const { config, warnings } = validateUserConfig({
    refresh: {
      windows: [
        { from: "08:55", to: "09:30" },
        { from: "22:00", to: "01:00" },
        { from: "25:00", to: "09:00" },
        { from: "8:00", to: "09:00" },
        { from: "09:00", to: "bad" },
      ],
    },
  });
  assert.deepEqual(config.refresh.windows, [
    { from: "08:55", to: "09:30" },
    { from: "22:00", to: "01:00" },
  ]);
  assert.ok(warnings.some((w) => w.includes("windows") && w.includes("제거")));
});

// ── refresh.enabled ──────────────────────────────────────

test("refresh.enabled: boolean 아니면 false", () => {
  const a = validateUserConfig({ refresh: { enabled: "yes" } });
  assert.equal(a.config.refresh.enabled, false);
  assert.ok(a.warnings.some((w) => w.includes("enabled")));

  const b = validateUserConfig({ refresh: { enabled: true } });
  assert.equal(b.config.refresh.enabled, true);
});

// ── notify.telegram ──────────────────────────────────────

test("notify.telegram: enabled인데 token·chatId 비면 enabled false + 경고", () => {
  const a = validateUserConfig({
    notify: { telegram: { enabled: true, token: "", chatId: "1" } },
  });
  assert.equal(a.config.notify.telegram.enabled, false);
  assert.ok(a.warnings.some((w) => w.includes("telegram") && w.includes("false")));

  const b = validateUserConfig({
    notify: { telegram: { enabled: true, token: "t", chatId: "c" } },
  });
  assert.equal(b.config.notify.telegram.enabled, true);
  assert.equal(b.config.notify.telegram.token, "t");
  assert.equal(b.config.notify.telegram.chatId, "c");
});

// ── profile ──────────────────────────────────────────────

test("profile: 문자열 필드만 유지, 앞뒤 공백 제거", () => {
  const { config } = validateUserConfig({
    profile: { name: "  홍길동  ", phone: 123, email: " a@b.c ", extra: "x" },
  });
  assert.deepEqual(config.profile, { name: "홍길동", phone: "", email: "a@b.c" });
  assert.equal("extra" in config.profile, false);
});

// ── 모르는 키 ────────────────────────────────────────────

test("모르는 키는 버린다", () => {
  const { config } = validateUserConfig({
    targets: [],
    refresh: { enabled: false, intervalSec: 60, windows: [], mystery: 1 },
    notify: { sound: true, desktop: true, telegram: { enabled: false, token: "", chatId: "" } },
    profile: { name: "", phone: "", email: "" },
    unknownTop: true,
  });
  assert.equal("unknownTop" in config, false);
  assert.equal("mystery" in config.refresh, false);
});

// ── 입력 불변 ────────────────────────────────────────────

test("입력을 변경하지 않는다", () => {
  const input = {
    targets: [{ goodsCode: "1", playSeq: ["001", ""], filter: { grades: ["R"], regex: "[" } }],
    refresh: { enabled: true, intervalSec: 10, windows: [{ from: "08:00", to: "09:00" }] },
    notify: { sound: true, desktop: true, telegram: { enabled: true, token: "", chatId: "" } },
    profile: { name: "  a  ", phone: "", email: "" },
  };
  const before = JSON.stringify(input);
  validateUserConfig(input);
  assert.equal(JSON.stringify(input), before);
});

// ── validateSiteConfig ───────────────────────────────────

/** 필수 항목이 채워진 최소 사이트 설정 */
function filledSite(overrides = {}) {
  return {
    seatMapFrame: { urlPattern: "https://example.com/seat" },
    net: {
      urlPatterns: ["https://api.example.com/seats"],
      seatPath: "data.seats",
      fields: {
        id: "seatId",
        grade: "grade",
        zone: "zone",
        block: "block",
        row: "row",
        col: "col",
        available: "avail",
      },
    },
    dom: { seatSelector: ".seat", availableSelector: ".seat.ok" },
    refresh: { action: "button", selector: "#refresh" },
    assist: { confirmButtonSelector: "#confirm" },
    ...overrides,
  };
}

test("validateSiteConfig: 필수 항목이 채워지면 missing 비어 있음", () => {
  assert.deepEqual(validateSiteConfig(filledSite()).missing, []);
});

test("validateSiteConfig: 없거나 빈 문자열이거나 TODO로 시작하면 missing", () => {
  const site = filledSite({
    seatMapFrame: { urlPattern: "TODO: frame" },
    net: {
      urlPatterns: ["TODO: url", ""],
      seatPath: "",
      fields: {
        id: "TODO",
        grade: "g",
        zone: "z",
        block: "b",
        row: "r",
        col: "c",
        available: "a",
      },
    },
    dom: { seatSelector: null, availableSelector: ".ok" },
    refresh: { selector: "TODO: btn" },
    assist: { confirmButtonSelector: "#ok" },
  });
  const { missing } = validateSiteConfig(site);
  assert.ok(missing.includes("seatMapFrame.urlPattern"));
  assert.ok(missing.includes("net.urlPatterns.0"));
  assert.ok(missing.includes("net.urlPatterns.1"));
  assert.ok(missing.includes("net.seatPath"));
  assert.ok(missing.includes("net.fields.id"));
  assert.ok(missing.includes("dom.seatSelector"));
  assert.ok(missing.includes("refresh.selector"));
  assert.ok(!missing.includes("assist.confirmButtonSelector"));
});

test("validateSiteConfig: urlPatterns가 빈 배열이면 net.urlPatterns 누락", () => {
  const site = filledSite();
  site.net.urlPatterns = [];
  assert.ok(validateSiteConfig(site).missing.includes("net.urlPatterns"));
});

test("validateSiteConfig: 사이트가 객체가 아니면 필수 경로 전부 missing", () => {
  const { missing } = validateSiteConfig(null);
  assert.ok(missing.includes("seatMapFrame.urlPattern"));
  assert.ok(missing.includes("net.fields.available"));
  assert.ok(missing.includes("assist.confirmButtonSelector"));
});

test("validateSiteConfig: 입력을 변경하지 않는다", () => {
  const site = filledSite({ seatMapFrame: { urlPattern: "TODO" } });
  const before = JSON.stringify(site);
  validateSiteConfig(site);
  assert.equal(JSON.stringify(site), before);
});

// ── 로딩 방식 (DESIGN 2.1) ───────────────────────────────

test("content script처럼 classic script로 순서대로 로드하면 globalThis.NCA에 붙는다", () => {
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const ctx = vm.createContext({});
  for (const f of ["types.js", "detector.js", "config-validate.js"]) {
    const code = fs.readFileSync(path.join(__dirname, "../extension/shared", f), "utf8");
    vm.runInContext(code, ctx, { filename: f });
  }
  const NCA = vm.runInContext("globalThis.NCA", ctx);
  assert.equal(typeof NCA.configValidate.defaultUserConfig, "function");
  assert.equal(typeof NCA.configValidate.validateUserConfig, "function");
  assert.equal(typeof NCA.configValidate.validateSiteConfig, "function");
  const { config } = NCA.configValidate.validateUserConfig({ refresh: { intervalSec: 10 } });
  assert.equal(config.refresh.intervalSec, 30);
});
