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
    tabs: { onRemoved: makeEvent(), update: async (id, info) => { calls.tabs.push([id, info]); } },
    windows: { update: async (id, info) => { calls.windows.push([id, info]); } },
  };
  return chrome;
}

// 크롬 SW에서는 shared/*.js가 ES module로 평가되어 `module`이 없으므로 globalThis.NCA에 붙는다.
// Node는 import/export가 없는 .js를 CommonJS로 보고 module.exports에 붙이므로,
// 브라우저와 같게 classic script로 먼저 평가해 globalThis.NCA를 채운다.
const vm = require("node:vm");
for (const f of ["types.js", "detector.js", "config-validate.js", "format.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(EXT, "shared", f), "utf8"), { filename: f });
}

const chrome = makeChrome();
globalThis.chrome = chrome;
globalThis.fetch = async (url, init) => { chrome.calls.fetches.push({ url, init }); return { ok: true, status: 200 }; };
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
  assert.equal(r.refreshEnabled, false);
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
