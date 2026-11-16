// background.js 연결 테스트: 가짜 chrome으로 SW를 불러와 메시지·알림 클릭·설치 흐름을 확인한다.
// 매니페스트가 가리키는 파일이 모두 있는지도 확인한다.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(__dirname, "../extension");

function fakeArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) { for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
  };
}

function makeEvent() {
  const listeners = [];
  return { listeners, addListener: (fn) => listeners.push(fn) };
}

function makeChrome() {
  const calls = { notifications: [], cleared: [], offscreen: [], sent: [], windows: [], tabs: [], optionsOpened: 0, fetches: [] };
  const chrome = {
    calls,
    storage: { session: fakeArea(), local: fakeArea() },
    runtime: {
      id: "ext-id",
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      getURL: (p) => `chrome-extension://ext-id/${p}`,
      getContexts: async () => (calls.offscreen.length > 0 ? [{}] : []),
      sendMessage: async (msg) => { calls.sent.push(msg); return msg.target === "offscreen" ? { ok: true } : undefined; },
      openOptionsPage: async () => { calls.optionsOpened++; },
      onMessage: makeEvent(),
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      onConnect: makeEvent(),
    },
    offscreen: {
      Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
      createDocument: async (o) => { calls.offscreen.push(o); },
    },
    notifications: {
      create: async (id, o) => { calls.notifications.push({ id, o }); },
      clear: (id) => { calls.cleared.push(id); },
      onClicked: makeEvent(),
    },
    tabs: {
      onRemoved: makeEvent(),
      update: async (id, info) => { calls.tabs.push([id, info]); },
      openIds: new Set(),
      async get(id) { if (!chrome.tabs.openIds.has(id)) throw new Error(`No tab with id: ${id}`); return { id }; },
    },
    alarms: { created: [], create(name, info) { this.created.push([name, info]); }, onAlarm: makeEvent() },
    windows: { update: async (id, info) => { calls.windows.push([id, info]); } },
  };
  return chrome;
}

// 크롬 SW에서는 shared/*.js가 ES module로 평가되어 `module`이 없으므로 globalThis.NCA에 붙는다.
// Node는 import/export가 없는 .js를 CommonJS로 보고 module.exports에 붙이므로,
// 브라우저와 같게 classic script로 먼저 평가해 globalThis.NCA를 채운다.
const vm = require("node:vm");
for (const f of ["types.js", "detector.js", "config-validate.js", "format.js", "seat-parse.js", "assist-plan.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(EXT, "shared", f), "utf8"), { filename: f });
}

const chrome = makeChrome();
globalThis.chrome = chrome;
globalThis.fetch = async (url, init) => {
  chrome.calls.fetches.push({ url, init });
  const ext = "chrome-extension://ext-id/";
  if (String(url).startsWith(ext)) {
    const text = fs.readFileSync(path.join(EXT, String(url).slice(ext.length)), "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  }
  return { ok: true, status: 200 };
};
const loaded = import("../extension/background.js");

/** onMessage 리스너로 보내고 sendResponse 결과를 기다린다 */
const POPUP = { id: "ext-id", url: "chrome-extension://ext-id/popup/popup.html" };
async function send(msg, sender = POPUP) {
  await loaded;
  return new Promise((resolve) => {
    let async = false;
    for (const fn of chrome.runtime.onMessage.listeners) {
      if (fn(msg, sender, resolve) === true) async = true;
    }
    if (!async) resolve("not-handled");
  });
}

test("리스너가 최상위에서 등록된다", async () => {
  await loaded;
  assert.equal(chrome.runtime.onMessage.listeners.length, 1);
  assert.equal(chrome.runtime.onInstalled.listeners.length, 1);
  assert.equal(chrome.runtime.onStartup.listeners.length, 1);
  assert.equal(chrome.notifications.onClicked.listeners.length, 1);
  assert.equal(chrome.tabs.onRemoved.listeners.length, 1);
  assert.equal(chrome.runtime.onConnect.listeners.length, 1);
  assert.equal(chrome.alarms.onAlarm.listeners.length, 1);
  assert.deepEqual(chrome.alarms.created, [["nca-health", { periodInMinutes: 0.5 }]]);
});

/** content script 포트 흉내 */
function connect(name, sender) {
  const port = { name, sender, onMessage: makeEvent(), onDisconnect: makeEvent(), sent: [], disconnected: false, disconnect() { this.disconnected = true; }, postMessage(m) { this.sent.push(m); } };
  chrome.runtime.onConnect.listeners[0](port);
  return port;
}

test("content 포트: 좌석 화면 탭이 아니면 끊는다", async () => {
  await loaded;
  assert.equal(connect("nca-content", { id: "ext-id", url: "chrome-extension://ext-id/popup/popup.html" }).disconnected, true);
  assert.equal(connect("nca-content", { id: "other", tab: { id: 1, windowId: 1 } }).disconnected, true);
  assert.equal(connect("nca-content", { id: "ext-id", tab: { id: 1, windowId: 1 } }).disconnected, false);
});

test("content 포트: 연결하면 사이트 설정(URL 패턴)을 보내준다", async () => {
  await loaded;
  const port = connect("nca-content", { id: "ext-id", url: "https://tickets.interpark.com/onestop/seat", tab: { id: 40, windowId: 1 } });
  await new Promise((r) => setTimeout(r, 10));
  const site = JSON.parse(fs.readFileSync(path.join(EXT, "config/site.nol.json"), "utf8"));
  assert.deepEqual(port.sent[0], {
    type: "CONFIG",
    net: { metaUrlPattern: site.net.metaUrlPattern, statusUrlPattern: site.net.statusUrlPattern },
    pageState: { gqlUrlPattern: site.pageState.gqlUrlPattern, expiredOperation: site.pageState.expiredOperation },
    seatPageUrlPattern: site.seatMapFrame.urlPattern,
    assist: site.assist,
  });
});

test("content 포트: LEAVE 메시지·포트 끊김이면 탭을 조용히 IDLE로", async () => {
  await loaded;
  const sender = { id: "ext-id", url: "https://tickets.interpark.com/onestop/seat", tab: { id: 41, windowId: 1 } };
  await chrome.storage.session.set({ "tab:41": { watch: "WATCHING", blindReason: null, frames: {}, seatMapFrameId: null, lastOkAt: 1 } });
  const before = chrome.calls.notifications.length;
  const port = connect("nca-content", sender);
  port.onMessage.listeners[0]({ type: "LEAVE" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(chrome.storage.session.data["tab:41"].watch, "IDLE");
  await chrome.storage.session.set({ "tab:41": { ...chrome.storage.session.data["tab:41"], watch: "WATCHING" } });
  port.onDisconnect.listeners[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(chrome.storage.session.data["tab:41"].watch, "IDLE");
  assert.equal(chrome.calls.notifications.length, before);
  delete chrome.storage.session.data["tab:41"];
});

test("생존 확인 알람: 30초 넘게 응답 없는 감시 탭은 감시 불능 알림, 닫힌 탭은 정리", async () => {
  await loaded;
  await chrome.storage.local.set({ userConfig: { targets: [{ goodsCode: "26015783", playSeq: [], filter: {} }], notify: { sound: false, desktop: true, telegram: { enabled: false, token: "", chatId: "" } }, profile: {} } });
  const old = Date.now() - 60_000;
  await chrome.storage.session.set({
    "tab:51": { watch: "WATCHING", blindReason: null, frames: {}, seatMapFrameId: null, lastOkAt: old, goodsCode: "26015783", playSeq: "001", windowId: 6 },
    "tab:52": { watch: "WATCHING", blindReason: null, frames: {}, seatMapFrameId: null, lastOkAt: Date.now(), goodsCode: "26015783", playSeq: "001", windowId: 6 },
    "tab:53": { watch: "FOUND", blindReason: null, frames: {}, seatMapFrameId: null, lastOkAt: old, goodsCode: "26015783", playSeq: "001", windowId: 6 },
    "tab:54": { watch: "WATCHING", blindReason: null, frames: {}, seatMapFrameId: null, lastOkAt: old, goodsCode: "26015783", playSeq: "001", windowId: 6 },
  });
  chrome.tabs.openIds = new Set([51, 52, 53]); // 54는 닫힘
  const before = chrome.calls.notifications.length;
  chrome.alarms.onAlarm.listeners[0]({ name: "nca-health" });
  await new Promise((r) => setTimeout(r, 30));
  const added = chrome.calls.notifications.slice(before);
  assert.equal(added.length, 1);
  assert.match(added[0].id, /^blind:51:6:\d+$/);
  assert.match(added[0].o.message, /30초 동안 좌석맵 응답이 없습니다/);
  assert.equal(chrome.storage.session.data["tab:51"].blindReason, "stale");
  assert.equal(chrome.storage.session.data["tab:52"].watch, "WATCHING");
  assert.equal(chrome.storage.session.data["tab:53"].watch, "FOUND"); // 좌석을 찾은 상태는 건드리지 않음
  assert.equal("tab:54" in chrome.storage.session.data, false);
  delete chrome.storage.local.data.userConfig;
  for (const k of Object.keys(chrome.storage.session.data)) if (/:5[1-4]$|:5[1-4]:/.test(k)) delete chrome.storage.session.data[k];
  for (const k of Object.keys(chrome.storage.local.data)) if (k.startsWith("log:")) delete chrome.storage.local.data[k];
});

test("content 포트: 매진 → 좌석 풀림 스냅샷이 오면 '취소표 생김' 알림", async () => {
  await loaded;
  const soldout = require(path.join(__dirname, "../fixtures/seat-soldout.json"));
  const seatParse = require("../extension/shared/seat-parse.js");
  await chrome.storage.local.set({ userConfig: { targets: [{ goodsCode: "26015783", playSeq: [], filter: { grades: ["VIP"] } }], notify: { sound: false, desktop: true, telegram: { enabled: false, token: "", chatId: "" } }, profile: {} } });
  const acc = seatParse.createAccumulator();
  acc.addMeta(soldout.meta[0].url, soldout.meta[0].body);
  const m1 = acc.addStatus(soldout.status[0].url, soldout.status[0].body, 1);
  const body = structuredClone(soldout.status[0].body);
  body.data[0] = "8" + body.data[0].slice(1); // 첫 좌석 풀림
  const m2 = acc.addStatus(soldout.status[0].url, body, 2);

  const port = connect("nca-content", { id: "ext-id", url: "https://tickets.interpark.com/onestop/seat", tab: { id: 31, windowId: 4 } });
  const before = chrome.calls.notifications.length;
  port.onMessage.listeners[0]({ type: "SNAPSHOT", ...m1 });
  port.onMessage.listeners[0]({ type: "SNAPSHOT", ...m2 });
  await new Promise((r) => setTimeout(r, 30));
  const added = chrome.calls.notifications.slice(before);
  assert.equal(added.length, 1);
  assert.match(added[0].id, /^found:31:4:\d+$/);
  assert.match(added[0].o.message, /^VIP석\(현장수령\) FLOOR .+ 생김$/);
  assert.equal(chrome.storage.session.data["tab:31"].watch, "FOUND");
  // 뒤 테스트에 영향이 없도록 되돌린다
  delete chrome.storage.local.data.userConfig;
  for (const k of Object.keys(chrome.storage.session.data)) if (k.includes(":31")) delete chrome.storage.session.data[k];
  for (const k of Object.keys(chrome.storage.local.data)) if (k.startsWith("log:")) delete chrome.storage.local.data[k];
});

test("처음 설치: 기본 설정 저장 + 옵션 페이지 열기", async () => {
  await loaded;
  await chrome.runtime.onInstalled.listeners[0]({ reason: "install" });
  assert.ok(chrome.storage.local.data.userConfig);
  assert.equal(chrome.calls.optionsOpened, 1);
  await chrome.runtime.onInstalled.listeners[0]({ reason: "update" });
  assert.equal(chrome.calls.optionsOpened, 1);
});

test("GET_STATUS: 설정과 감시 탭 요약", async () => {
  await chrome.storage.session.set({ "tab:9": { watch: "BLIND", blindReason: "expired", frames: {}, seatMapFrameId: null, lastOkAt: null } });
  const r = await send({ type: "GET_STATUS" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.channels, { sound: true, desktop: true, telegram: false });
  assert.deepEqual(r.tabs, [{ tabId: 9, watch: "BLIND", blindReason: "expired" }]);
});

test("TEST_NOTIFY: 크롬 알림 + offscreen 소리, 텔레그램 꺼짐", async () => {
  const r = await send({ type: "TEST_NOTIFY" });
  assert.deepEqual(r, { ok: true, results: { desktop: "sent", sound: "sent", telegram: "off" } });
  assert.match(chrome.calls.notifications.at(-1).id, /^test:-1:-1:\d+$/);
  assert.equal(chrome.calls.offscreen.length, 1);
  assert.deepEqual(chrome.calls.sent.at(-1), { target: "offscreen", type: "PLAY", pattern: "found" });
  // 두 번째에는 offscreen 문서를 다시 만들지 않는다
  await send({ type: "TEST_NOTIFY" });
  assert.equal(chrome.calls.offscreen.length, 1);
});

test("LOG_LIST: 저장된 로그를 돌려준다", async () => {
  await chrome.storage.local.set({ "log:2026-11-16": [{ t: 1, kind: "blind", goodsCode: "1", playSeq: "1", matched: false, seats: [] }] });
  const r = await send({ type: "LOG_LIST" });
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 1);
});

test("모르는 메시지는 오류, offscreen용·외부 메시지는 처리하지 않는다", async () => {
  assert.deepEqual(await send({ type: "NOPE" }), { ok: false, error: "unknown message: NOPE" });
  assert.equal(await send({ target: "offscreen", type: "PLAY" }), "not-handled");
  assert.equal(await send({ type: "GET_STATUS" }, { id: "other-ext" }), "not-handled");
});

test("탭으로 열린 옵션 페이지(sender.tab 있음)의 메시지는 받는다", async () => {
  const optionsTab = { id: "ext-id", url: "chrome-extension://ext-id/options/options.html", tab: { id: 4 } };
  const r = await send({ type: "LOG_LIST" }, optionsTab);
  assert.equal(r.ok, true);
});

test("content script(사이트 주소)에서 온 팝업·옵션 메시지는 받지 않는다", async () => {
  const fromContent = { id: "ext-id", url: "https://tickets.interpark.com/onestop/seat", tab: { id: 3 } };
  assert.equal(await send({ type: "LOG_LIST" }, fromContent), "not-handled");
  assert.equal(await send({ type: "LOG_LIST" }, { id: "ext-id", url: "https://evil.example/" }), "not-handled");
});

test("offscreen: 동시에 여러 번 소리를 내도 문서는 한 번만 만든다", async () => {
  chrome.calls.offscreen.length = 0;
  // 문서가 없는 상태로 되돌린다
  const orig = chrome.runtime.getContexts;
  let created = false;
  chrome.runtime.getContexts = async () => { await new Promise((r) => setTimeout(r, 5)); return created ? [{}] : []; };
  const origCreate = chrome.offscreen.createDocument;
  chrome.offscreen.createDocument = async (o) => { await new Promise((r) => setTimeout(r, 5)); created = true; chrome.calls.offscreen.push(o); };
  try {
    await Promise.all([send({ type: "TEST_NOTIFY" }), send({ type: "TEST_NOTIFY" }), send({ type: "TEST_NOTIFY" })]);
    assert.equal(chrome.calls.offscreen.length, 1);
  } finally {
    chrome.runtime.getContexts = orig;
    chrome.offscreen.createDocument = origCreate;
  }
});

test("offscreen: 첫 소리 요청에 응답이 없으면 한 번 다시 보낸다", async () => {
  const orig = chrome.runtime.sendMessage;
  let n = 0;
  chrome.runtime.sendMessage = async (msg) => {
    if (msg.target !== "offscreen") return undefined;
    n++;
    if (n === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
    return { ok: true };
  };
  try {
    const r = await send({ type: "TEST_NOTIFY" });
    assert.equal(r.results.sound, "sent");
    assert.equal(n, 2);
  } finally {
    chrome.runtime.sendMessage = orig;
  }
});

test("알림 클릭: 알림을 지우고 해당 창·탭으로 포커스", async () => {
  await loaded;
  chrome.notifications.onClicked.listeners[0]("found:12:3:1700000000000");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(chrome.calls.cleared.at(-1), "found:12:3:1700000000000");
  assert.deepEqual(chrome.calls.windows.at(-1), [3, { focused: true, drawAttention: true }]);
  assert.deepEqual(chrome.calls.tabs.at(-1), [12, { active: true }]);
});

test("탭 닫힘: 그 탭의 감시 상태 정리", async () => {
  await chrome.storage.session.set({ "tab:21": { watch: "WATCHING" }, "prev:21:001": {} });
  chrome.tabs.onRemoved.listeners[0](21);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal("tab:21" in chrome.storage.session.data, false);
  assert.equal("prev:21:001" in chrome.storage.session.data, false);
});

test("매니페스트가 가리키는 파일이 모두 있다", () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const files = [
    m.background.service_worker,
    m.options_page,
    m.action.default_popup,
    ...Object.values(m.icons),
    ...Object.values(m.action.default_icon),
  ];
  for (const f of files) assert.ok(fs.existsSync(path.join(EXT, f)), `없음: ${f}`);
});

test("HTML이 불러오는 스크립트·스타일 파일이 모두 있다", () => {
  for (const page of ["options/options.html", "popup/popup.html", "offscreen/offscreen.html"]) {
    const html = fs.readFileSync(path.join(EXT, page), "utf8");
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      assert.ok(fs.existsSync(path.join(EXT, path.dirname(page), ref)), `${page}: 없음 ${ref}`);
    }
  }
});
