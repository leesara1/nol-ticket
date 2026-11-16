// sw/watch.js 테스트: 실제 store·detector·seat-parse·format + 가짜 알림·로그·포커스 (DESIGN 5.1, 7.1)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const detector = require("../extension/shared/detector.js");
const seatParse = require("../extension/shared/seat-parse.js");
const format = require("../extension/shared/format.js");
const assistPlan = require("../extension/shared/assist-plan.js");
const soldout = require(path.join(__dirname, "../fixtures/seat-soldout.json"));
const musical = require(path.join(__dirname, "../fixtures/seat-musical.json"));

function fakeArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) { for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
  };
}

async function setup(targets) {
  const { createStore } = await import("../extension/sw/store.js");
  const { createWatcher } = await import("../extension/sw/watch.js");
  const calls = { notify: [], log: [], focus: [], highlight: [] };
  const store = createStore(fakeArea());
  const watcher = createWatcher({
    store,
    log: { append: async (e) => { calls.log.push(e); } },
    notifier: { notify: async (kind, text, opts) => { calls.notify.push({ kind, text, opts }); } },
    focus: async (tabId, windowId) => { calls.focus.push([tabId, windowId]); },
    loadUserConfig: async () => ({ targets }),
    detector, seatParse, format, assistPlan,
    highlight: (tabId, plan) => { calls.highlight.push({ tabId, plan }); },
    now: () => 1000,
  });
  return { watcher, store, calls };
}

const target = (goodsCode, filter = {}, playSeq = []) => ({ goodsCode, playSeq, filter: detector.normalizeFilter(filter) });
const TAB = { id: 7, windowId: 2 };

function setBit(hex, i) {
  const chars = hex.split("");
  const c = Math.floor(i / 4);
  chars[c] = (parseInt(chars[c], 16) | (8 >> (i % 4))).toString(16);
  return chars.join("");
}

/** 성시경 매진 → 지정 좌석 풀림 → 다시 매진, 스냅샷 메시지 세 개 */
function soldoutThenRelease(ids) {
  const acc = seatParse.createAccumulator();
  acc.addMeta(soldout.meta[0].url, soldout.meta[0].body);
  const first = acc.addStatus(soldout.status[0].url, soldout.status[0].body, 1);
  const seats = soldout.meta[0].body.data[0].seats;
  const body = structuredClone(soldout.status[0].body);
  for (const id of ids) body.data[0] = setBit(body.data[0], seats.findIndex((s) => s.seatInfoId.endsWith(`:${id}`)));
  const second = acc.addStatus(soldout.status[0].url, body, 2);
  const third = acc.addStatus(soldout.status[0].url, soldout.status[0].body, 3);
  return [first, second, third];
}

test("취소표: 매진 → 두 좌석 풀림 → 알림·포커스·로그, 다시 팔리면 사라짐 알림", async () => {
  const { watcher, calls, store } = await setup([target("26015783", { grades: ["VIP"], adjacent: 2 })]);
  const [m1, m2, m3] = soldoutThenRelease([66233, 66234]);

  const r1 = await watcher.handleSnapshot(TAB, m1);
  assert.deepEqual(r1.events, []);
  assert.equal(r1.watch, "WATCHING");

  const r2 = await watcher.handleSnapshot(TAB, m2);
  assert.equal(r2.watch, "FOUND");
  assert.deepEqual(calls.notify, [{ kind: "found", text: "VIP석(현장수령) FLOOR A구역 10열 10·11번 (2연석) 생김", opts: { tabId: 7, windowId: 2 } }]);
  assert.deepEqual(calls.focus, [[7, 2]]);
  assert.equal(calls.log.filter((e) => e.kind === "appeared" && e.matched).length, 1);

  const r3 = await watcher.handleSnapshot(TAB, m3);
  assert.equal(r3.watch, "WATCHING");
  assert.equal(calls.notify.at(-1).kind, "gone");
  assert.match(calls.notify.at(-1).text, /사라짐$/);
  assert.equal((await store.getTab(7)).watch, "WATCHING");
});

test("조건에 안 맞는 좌석(1석, 연석 2 조건)은 알리지 않고 로그만", async () => {
  const { watcher, calls } = await setup([target("26015783", { adjacent: 2 })]);
  const [m1, m2] = soldoutThenRelease([66233]);
  await watcher.handleSnapshot(TAB, m1);
  const r = await watcher.handleSnapshot(TAB, m2);
  assert.equal(calls.notify.length, 0);
  assert.equal(r.watch, "WATCHING");
  assert.deepEqual(calls.log.map((e) => [e.kind, e.matched]), [["appeared", false]]);
});

test("대상 공연이 아니면 무시", async () => {
  const { watcher, calls } = await setup([target("99999999")]);
  const [m1] = soldoutThenRelease([]);
  assert.deepEqual(await watcher.handleSnapshot(TAB, m1), { ignored: "대상 공연 아님" });
  assert.equal(calls.notify.length + calls.log.length, 0);
});

test("대상 회차가 아니면 무시", async () => {
  const { watcher } = await setup([target("26015783", {}, ["002"])]);
  const [m1] = soldoutThenRelease([]);
  assert.deepEqual(await watcher.handleSnapshot(TAB, m1), { ignored: "대상 회차 아님" });
});

test("SW가 재시작돼도(새 watcher, 같은 store) 같은 좌석을 다시 알리지 않는다", async () => {
  const { createWatcher } = await import("../extension/sw/watch.js");
  const { watcher, calls, store } = await setup([target("26015783")]);
  const [m1, m2] = soldoutThenRelease([66233]);
  await watcher.handleSnapshot(TAB, m1);
  await watcher.handleSnapshot(TAB, m2);
  assert.equal(calls.notify.length, 1);
  const w2 = createWatcher({
    store, log: { append: async () => {} },
    notifier: { notify: async (k, t) => { calls.notify.push({ k, t }); } },
    focus: async () => {}, loadUserConfig: async () => ({ targets: [target("26015783")] }),
    detector, seatParse, format,
  });
  await w2.handleSnapshot(TAB, m2);
  assert.equal(calls.notify.length, 1);
});

test("처음 보는 구역의 기존 빈 좌석(뮤지컬 74석)은 알리지 않는다", async () => {
  const { watcher, calls } = await setup([target("26013198")]);
  const acc = seatParse.createAccumulator();
  for (const m of musical.meta) acc.addMeta(m.url, m.body);
  const r = await watcher.handleSnapshot(TAB, acc.addStatus(musical.status[0].url, musical.status[0].body));
  assert.deepEqual(r.events, []);
  assert.equal(calls.notify.length, 0);
});

test("alertOnFirst면 처음부터 비어 있던 좌석도 알린다", async () => {
  const { watcher, calls } = await setup([target("26013198", { alertOnFirst: true, adjacent: 4 })]);
  const acc = seatParse.createAccumulator();
  for (const m of musical.meta) acc.addMeta(m.url, m.body);
  await watcher.handleSnapshot(TAB, acc.addStatus(musical.status[0].url, musical.status[0].body));
  assert.ok(calls.notify.length > 0);
  assert.ok(calls.notify.every((n) => n.kind === "found" && /연석\) 생김$/.test(n.text)));
});

test("감시 불능: 같은 사유는 한 번만 알리고, 정상 스냅샷이 오면 복구 알림", async () => {
  const { watcher, calls } = await setup([target("26015783")]);
  const [m1] = soldoutThenRelease([]);
  assert.deepEqual(await watcher.handleBlind(TAB, { reason: "selector_mismatch", goodsCode: "26015783" }), { notified: true });
  assert.deepEqual(await watcher.handleBlind(TAB, { reason: "selector_mismatch", goodsCode: "26015783" }), { notified: false });
  assert.equal(calls.notify.filter((n) => n.kind === "blind").length, 1);
  await watcher.handleSnapshot(TAB, m1);
  assert.equal(calls.notify.at(-1).kind, "recovered");
});

test("감시 불능: 대상 공연이 아니면 알리지 않는다", async () => {
  const { watcher, calls } = await setup([target("26015783")]);
  const r = await watcher.handleBlind(TAB, { reason: "parse_failed", goodsCode: "11111111" });
  assert.equal(r.notified, false);
  assert.equal(calls.notify.length, 0);
});

// ── 6단계: 이탈·응답 끊김·만료 ──────────────────────────

test("이탈: handleLeave면 IDLE, 알림 없음", async () => {
  const { watcher, store, calls } = await setup([target("26015783")]);
  const [m1] = soldoutThenRelease([]);
  await watcher.handleSnapshot(TAB, m1);
  await watcher.handleLeave(TAB);
  assert.equal((await store.getTab(7)).watch, "IDLE");
  assert.equal(calls.notify.length, 0);
});

test("응답 끊김: 30초 넘게 스냅샷이 없으면 stale 1회 알림, 그 전엔 없음", async () => {
  const { createStore } = await import("../extension/sw/store.js");
  const { createWatcher } = await import("../extension/sw/watch.js");
  let t = 1000;
  const calls = [];
  const store = createStore(fakeArea());
  const watcher = createWatcher({
    store, log: { append: async () => {} },
    notifier: { notify: async (kind, text, opts) => { calls.push({ kind, text, opts }); } },
    focus: async () => {}, loadUserConfig: async () => ({ targets: [target("26015783")] }),
    detector, seatParse, format, now: () => t,
  });
  const [m1] = soldoutThenRelease([]);
  await watcher.handleSnapshot(TAB, m1);
  const alive = async () => true;
  t += 29_000;
  assert.deepEqual(await watcher.checkStale(alive), []);
  t += 2_000;
  assert.deepEqual(await watcher.checkStale(alive), [7]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "blind");
  assert.deepEqual(calls[0].opts, { tabId: 7, windowId: 2 });
  // 이미 BLIND면 다시 알리지 않는다 (WATCHING이 아니므로 대상에서 빠짐)
  t += 60_000;
  assert.deepEqual(await watcher.checkStale(alive), []);
  assert.equal(calls.length, 1);
});

test("좌석을 찾은 뒤(FOUND)의 만료는 상태만 바꾸고 알리지 않는다", async () => {
  const { watcher, calls, store } = await setup([target("26015783")]);
  const [m1, m2] = soldoutThenRelease([66233]);
  await watcher.handleSnapshot(TAB, m1);
  await watcher.handleSnapshot(TAB, m2);
  assert.equal((await store.getTab(7)).watch, "FOUND");
  const n = calls.notify.length;
  const r = await watcher.handleBlind(TAB, { reason: "expired" });
  assert.equal(r.quiet, true);
  assert.equal(calls.notify.length, n);
  assert.equal((await store.getTab(7)).watch, "BLIND");
});

test("감시 중 만료(goodsCode 없이 와도 탭 상태의 공연으로 대상 확인)", async () => {
  const { watcher, calls } = await setup([target("26015783")]);
  const [m1] = soldoutThenRelease([]);
  await watcher.handleSnapshot(TAB, m1);
  const r = await watcher.handleBlind(TAB, { reason: "expired" });
  assert.equal(r.notified, true);
  assert.match(calls.notify.at(-1).text, /좌석 선택 시간이 끝났습니다/);
});

// ── 7단계: 강조 ──────────────────────────────────────────

test("강조: 좌석이 풀리면 좌표와 안내를 보내고, 다시 팔리면 지우라고 보낸다", async () => {
  const { watcher, calls } = await setup([target("26015783", { grades: ["VIP"], adjacent: 2 })]);
  const [m1, m2, m3] = soldoutThenRelease([66233, 66234]);
  await watcher.handleSnapshot(TAB, m1);
  assert.equal(calls.highlight.length, 0);
  await watcher.handleSnapshot(TAB, m2);
  assert.equal(calls.highlight.length, 1);
  const { tabId, plan } = calls.highlight[0];
  assert.equal(tabId, 7);
  assert.equal(plan.add.length, 2);
  assert.ok(plan.add.every((t) => t.best && t.x > 0 && t.y > 0));
  assert.equal(plan.banner, "취소표: VIP석(현장수령) FLOOR A구역 10열 10·11번 (2연석) — 깜빡이는 곳을 누르세요");
  await watcher.handleSnapshot(TAB, m3);
  assert.deepEqual(calls.highlight[1].plan.remove.sort(), plan.add.map((t) => t.key).sort());
});
