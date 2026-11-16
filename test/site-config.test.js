// extension/config/site.nol.json 점검 (DESIGN 12.1, 12.3)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { validateSiteConfig, validateUserConfig } = require("../extension/shared/config-validate.js");

const site = require(path.join(__dirname, "../extension/config/site.nol.json"));

test("site.nol.json은 JSON으로 읽히고 site가 nol이다", () => {
  assert.equal(site.site, "nol");
});

test("사전 조사 전이므로 필수 항목이 모두 미설정(TODO)으로 보고된다", () => {
  // 사전 조사(DESIGN 19절)로 값을 채우면 이 테스트를 '누락 0개'로 바꾼다.
  const { missing } = validateSiteConfig(site);
  assert.ok(missing.includes("seatMapFrame.urlPattern"));
  assert.ok(missing.includes("net.fields.available"));
  assert.ok(missing.includes("assist.confirmButtonSelector"));
});

test("필터: 배열이 아닌 grades는 경고와 함께 []", () => {
  const { config, warnings } = validateUserConfig({
    targets: [{ goodsCode: "1", playSeq: [], filter: { grades: "R" } }],
  });
  assert.deepEqual(config.targets[0].filter.grades, []);
  assert.ok(warnings.some((w) => w.includes("grades")));
});

test("필터: 문자열이 아닌·빈 항목은 제거하고 경고", () => {
  const { config, warnings } = validateUserConfig({
    targets: [{ goodsCode: "1", playSeq: [], filter: { zones: ["1층", 3, " ", " 2층 "] } }],
  });
  assert.deepEqual(config.targets[0].filter.zones, ["1층", "2층"]);
  assert.ok(warnings.some((w) => w.includes("zones")));
});

test("필터: 잘못된 adjacent는 1로 고치고 경고", () => {
  const { config, warnings } = validateUserConfig({
    targets: [{ goodsCode: "1", playSeq: [], filter: { adjacent: 0 } }],
  });
  assert.equal(config.targets[0].filter.adjacent, 1);
  assert.ok(warnings.some((w) => w.includes("adjacent")));
});

test("필터: 정상 값에는 경고가 없다", () => {
  const { warnings } = validateUserConfig({
    targets: [{ goodsCode: "26015783", playSeq: ["001"], filter: { grades: ["R"], zones: [], rows: null, adjacent: 2 } }],
    refresh: { enabled: false, intervalSec: 60, windows: [{ from: "08:55", to: "09:30" }] },
    notify: { sound: true, desktop: true, telegram: { enabled: false, token: "", chatId: "" } },
    profile: { name: "", phone: "", email: "" },
  });
  assert.deepEqual(warnings, []);
});
