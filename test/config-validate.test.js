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

test("defaultUserConfig: 12.2 구조, targets는 빈 배열", () => {
  assert.deepEqual(defaultUserConfig(), {
    targets: [],
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
    refresh: { enabled: true, intervalSec: 60, windows: [] }, // 없앤 항목 (예전 설정)
    notify: { sound: true, desktop: true, telegram: { enabled: false, token: "", chatId: "" }, mystery: 1 },
    profile: { name: "", phone: "", email: "" },
    unknownTop: true,
  });
  assert.equal("unknownTop" in config, false);
  assert.equal("refresh" in config, false);
  assert.equal("mystery" in config.notify, false);
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

// ── validateSiteConfig (DESIGN 12.1) ─────────────────────

/** 필수 항목이 채워진 최소 사이트 설정 */
function filledSite() {
  return {
    seatMapFrame: { urlPattern: "^https://example\\.com/seat" },
    net: { metaUrlPattern: "/api/seatMeta\\?", statusUrlPattern: "/api/seatStatus\\?", statusEncoding: "hex-msb" },
    pageState: { gqlUrlPattern: "/gql$", expiredOperation: "ExpiredSession" },
    assist: { confirmButtonSelector: "#confirm" },
  };
}

test("validateSiteConfig: 필수 항목이 채워지면 missing 비어 있음", () => {
  assert.deepEqual(validateSiteConfig(filledSite()).missing, []);
});

test("validateSiteConfig: 비었거나 TODO거나 정규식 오류면 missing", () => {
  const site = filledSite();
  site.seatMapFrame.urlPattern = "TODO: frame";
  site.net.metaUrlPattern = "";
  site.net.statusUrlPattern = "([";
  site.assist.confirmButtonSelector = null;
  const { missing } = validateSiteConfig(site);
  assert.deepEqual(missing.sort(), ["assist.confirmButtonSelector", "net.metaUrlPattern", "net.statusUrlPattern", "seatMapFrame.urlPattern"]);
});

test("validateSiteConfig: 페이지 상태 항목(GraphQL·만료 operation)도 필수", () => {
  const site = filledSite();
  site.pageState.gqlUrlPattern = "(";
  site.pageState.expiredOperation = "";
  assert.deepEqual(validateSiteConfig(site).missing.sort(), ["pageState.expiredOperation", "pageState.gqlUrlPattern"]);
});

test("validateSiteConfig: 상태 인코딩은 hex-msb만 지원", () => {
  const site = filledSite();
  site.net.statusEncoding = "hex-lsb";
  assert.deepEqual(validateSiteConfig(site).missing, ["net.statusEncoding"]);
});

test("validateSiteConfig: 사이트가 객체가 아니면 필수 경로 전부 missing", () => {
  const { missing } = validateSiteConfig(null);
  assert.equal(missing.length, 7);
});

test("validateSiteConfig: 입력을 변경하지 않는다", () => {
  const site = filledSite();
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
  const { config } = NCA.configValidate.validateUserConfig({ notify: { telegram: { enabled: true } } });
  assert.equal(config.notify.telegram.enabled, false);
});
