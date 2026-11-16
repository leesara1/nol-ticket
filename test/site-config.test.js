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

test("사전 조사로 확정된 항목은 채워져 있고, 선택완료 버튼(7단계)만 남았다", () => {
  const { missing } = validateSiteConfig(site);
  assert.deepEqual(missing, ["assist.confirmButtonSelector"]);
});

test("URL 패턴이 실제 주소와 맞는다", () => {
  assert.match("https://tickets.interpark.com/onestop/seat", new RegExp(site.seatMapFrame.urlPattern));
  assert.match("https://tickets.interpark.com/onestop/api/seatMeta?goodsCode=1", new RegExp(site.net.metaUrlPattern));
  assert.match("https://tickets.interpark.com/onestop/api/seatStatus?goodsCode=1", new RegExp(site.net.statusUrlPattern));
  assert.doesNotMatch("https://tickets.interpark.com/onestop/api/seatMeta?x", new RegExp(site.net.statusUrlPattern));
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
    notify: { sound: true, desktop: true, telegram: { enabled: false, token: "", chatId: "" } },
    profile: { name: "", phone: "", email: "" },
  });
  assert.deepEqual(warnings, []);
});
