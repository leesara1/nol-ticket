// sw/log.js, sw/notifier.js, sw/focus.js 테스트 (DESIGN 10.1, 16.1)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { dayKey } = require("../extension/shared/format.js");

function fakeArea() {
  /** @type {Record<string, string>} */
  const data = {};
  return {
    data,
    async get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = JSON.parse(data[k]);
      return out;
    },
    async set(items) { for (const [k, v] of Object.entries(items)) data[k] = JSON.stringify(v); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
  };
}

const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h).getTime();
const entry = (t, o = {}) => ({ t, kind: "appeared", goodsCode: "1", playSeq: "001", matched: true, seats: [], ...o });

// ── log ──────────────────────────────────────────────────

test("log: 날짜별 키에 쌓이고 시간순으로 나온다", async () => {
  const { createLog } = await import("../extension/sw/log.js");
  const area = fakeArea();
  const log = createLog(area, { dayKey });
  await log.append(entry(at(2026, 11, 17, 9)));
  await log.append(entry(at(2026, 11, 16, 23)));
  await log.append(entry(at(2026, 11, 16, 8)));
  assert.deepEqual(Object.keys(area.data).sort(), ["log:2026-11-16", "log:2026-11-17"]);
  const all = await log.list();
  assert.deepEqual(all.map((e) => e.t), [at(2026, 11, 16, 8), at(2026, 11, 16, 23), at(2026, 11, 17, 9)]);
});

test("log: 동시에 append해도 항목을 잃지 않는다", async () => {
  const { createLog } = await import("../extension/sw/log.js");
  const log = createLog(fakeArea(), { dayKey });
  await Promise.all(Array.from({ length: 30 }, (_, i) => log.append(entry(at(2026, 11, 16) + i))));
  assert.equal((await log.list()).length, 30);
});

test("log: t가 없으면 now()를 쓴다", async () => {
  const { createLog } = await import("../extension/sw/log.js");
  const log = createLog(fakeArea(), { dayKey, now: () => at(2026, 11, 20) });
  const { t, ...rest } = entry(0);
  await log.append(rest);
  assert.equal((await log.list())[0].t, at(2026, 11, 20));
});

test("log: list 기간 필터 (양 끝 포함)", async () => {
  const { createLog } = await import("../extension/sw/log.js");
  const log = createLog(fakeArea(), { dayKey });
  for (const d of [14, 15, 16, 17]) await log.append(entry(at(2026, 11, d)));
  const r = await log.list({ from: "2026-11-15", to: "2026-11-16" });
  assert.equal(r.length, 2);
});

test("log: prune은 보관 기간보다 오래된 날짜만 지운다", async () => {
  const { createLog } = await import("../extension/sw/log.js");
  const area = fakeArea();
  await area.set({ other: 1 });
  const log = createLog(area, { dayKey, now: () => at(2026, 11, 16) });
  await log.append(entry(at(2026, 8, 1)));   // 107일 전
  await log.append(entry(at(2026, 8, 18)));  // 90일 전 (경계: 남김)
  await log.append(entry(at(2026, 11, 16)));
  assert.equal(await log.prune(90), 1);
  assert.deepEqual(Object.keys(area.data).sort(), ["log:2026-08-18", "log:2026-11-16", "other"]);
});

// ── notifier ─────────────────────────────────────────────

async function makeNotifier(channels, opts = {}) {
  const { createNotifier } = await import("../extension/sw/notifier.js");
  const calls = { notifications: [], sounds: [], fetches: [] };
  let t = opts.t ?? 1_000_000;
  const notifier = createNotifier({
    notifications: { create: async (id, o) => { if (opts.desktopFails) throw new Error("denied"); calls.notifications.push({ id, o }); } },
    playSound: async (p) => { calls.sounds.push(p); },
    fetch: async (url, init) => { calls.fetches.push({ url, init }); return { ok: !opts.telegramFails, status: opts.telegramFails ? 401 : 200 }; },
    session: fakeArea(),
    getChannels: async () => channels,
    now: () => t,
  });
  return { notifier, calls, advance: (ms) => { t += ms; } };
}

const allOn = { sound: true, desktop: true, telegram: { enabled: true, token: "123:abc", chatId: "42" } };

test("notifier: 켜진 채널 모두로 보낸다 (found는 requireInteraction, 높아지는 음)", async () => {
  const { notifier, calls } = await makeNotifier(allOn);
  const r = await notifier.notify("found", "R석 7열 12번 생김", { tabId: 5, windowId: 2 });
  assert.deepEqual(r.results, { desktop: "sent", sound: "sent", telegram: "sent" });
  assert.match(calls.notifications[0].id, /^found:5:2:\d+$/);
  assert.equal(calls.notifications[0].o.requireInteraction, true);
  assert.deepEqual(calls.sounds, ["found"]);
  assert.equal(calls.fetches[0].url, "https://api.telegram.org/bot123%3Aabc/sendMessage");
  assert.deepEqual(JSON.parse(calls.fetches[0].init.body), { chat_id: "42", text: "[NOL 취소표 알리미] R석 7열 12번 생김" });
});

test("notifier: 꺼진 채널은 보내지 않는다", async () => {
  const { notifier, calls } = await makeNotifier({ sound: false, desktop: true, telegram: { enabled: false, token: "", chatId: "" } });
  const r = await notifier.notify("found", "x");
  assert.deepEqual(r.results, { desktop: "sent", sound: "off", telegram: "off" });
  assert.equal(calls.sounds.length + calls.fetches.length, 0);
});

test("notifier: 좌석 사라짐은 소리 없음", async () => {
  const { notifier, calls } = await makeNotifier(allOn);
  await notifier.notify("gone", "x");
  assert.equal(calls.sounds.length, 0);
});

test("notifier: 같은 문구는 30초 안에 다시 보내지 않는다", async () => {
  const { notifier, calls, advance } = await makeNotifier(allOn);
  await notifier.notify("found", "같은 문구");
  assert.equal((await notifier.notify("found", "같은 문구")).skipped, true);
  advance(30_000);
  assert.equal((await notifier.notify("found", "같은 문구")).skipped, false);
  assert.equal(calls.notifications.length, 2);
});

test("notifier: 30초 지난 중복 방지 기록은 정리된다", async () => {
  const { createNotifier } = await import("../extension/sw/notifier.js");
  const session = fakeArea();
  let t = 1_000_000;
  const n = createNotifier({
    notifications: { create: async () => {} }, playSound: async () => {}, fetch: async () => ({ ok: true, status: 200 }),
    session, getChannels: async () => allOn, now: () => t,
  });
  await n.notify("found", "a");
  await n.notify("found", "b");
  t += 31_000;
  await n.notify("found", "c");
  assert.equal(Object.keys(session.data).filter((k) => k.startsWith("notified:")).length, 1);
});

test("notifier: 텔레그램 오류 문구에 토큰이 나오지 않는다", async () => {
  const { createNotifier } = await import("../extension/sw/notifier.js");
  const token = "123456:SECRET-token";
  const n = createNotifier({
    notifications: { create: async () => {} }, playSound: async () => {},
    fetch: async (url) => { throw new TypeError(`network error for ${url}`); },
    session: fakeArea(), now: () => 1,
    getChannels: async () => ({ sound: false, desktop: false, telegram: { enabled: true, token, chatId: "1" } }),
  });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const r = await n.notify("found", "x");
    assert.match(r.results.telegram, /^error: /);
    assert.ok(!r.results.telegram.includes("SECRET"), r.results.telegram);
    assert.ok(r.results.telegram.includes("[토큰]"));
  } finally {
    console.warn = origWarn;
  }
});

test("notifier: force면 중복 방지를 무시한다 (테스트 알림)", async () => {
  const { notifier } = await makeNotifier(allOn);
  await notifier.notify("test", "t", { force: true });
  assert.equal((await notifier.notify("test", "t", { force: true })).skipped, false);
});

test("notifier: 한 채널이 실패해도 나머지는 보낸다", async () => {
  const { notifier, calls } = await makeNotifier(allOn, { telegramFails: true, desktopFails: true });
  const r = await notifier.notify("found", "x");
  assert.match(r.results.telegram, /^error: telegram HTTP 401/);
  assert.match(r.results.desktop, /^error/);
  assert.equal(r.results.sound, "sent");
  assert.deepEqual(calls.sounds, ["found"]);
});

test("notifier: 알림 ID 왕복", async () => {
  const { makeNotificationId, parseNotificationId } = await import("../extension/sw/notifier.js");
  assert.deepEqual(parseNotificationId(makeNotificationId("blind", 12, 3, 99)), { kind: "blind", tabId: 12, windowId: 3 });
  assert.deepEqual(parseNotificationId("test:-1:-1:5"), { kind: "test", tabId: -1, windowId: -1 });
  assert.equal(parseNotificationId("other:1:2:3"), null);
  assert.equal(parseNotificationId("found:1:2"), null);
});

// ── focus ────────────────────────────────────────────────

test("focus: 창은 focused+drawAttention, 탭은 active", async () => {
  const { focusTab } = await import("../extension/sw/focus.js");
  const calls = [];
  const api = {
    windows: { update: async (id, info) => { calls.push(["w", id, info]); } },
    tabs: { update: async (id, info) => { calls.push(["t", id, info]); } },
  };
  assert.equal(await focusTab(api, 7, 2), true);
  assert.deepEqual(calls, [["w", 2, { focused: true, drawAttention: true }], ["t", 7, { active: true }]]);
});

test("focus: 창 포커스가 거부돼도 탭 활성화는 한다", async () => {
  const { focusTab } = await import("../extension/sw/focus.js");
  const calls = [];
  const api = {
    windows: { update: async () => { throw new Error("blocked"); } },
    tabs: { update: async (id) => { calls.push(id); } },
  };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await focusTab(api, 7, 2), false);
  } finally {
    console.warn = origWarn;
  }
  assert.deepEqual(calls, [7]);
});

test("focus: 탭·창 ID가 없으면(-1) 아무것도 하지 않는다", async () => {
  const { focusTab } = await import("../extension/sw/focus.js");
  let n = 0;
  const api = { windows: { update: async () => { n++; } }, tabs: { update: async () => { n++; } } };
  await focusTab(api, -1, -1);
  assert.equal(n, 0);
});
