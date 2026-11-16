// sw/store.js 테스트 (DESIGN 12.4). 가짜 storage area를 주입한다.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

/** chrome.storage.session을 흉내 내는 메모리 저장소. 값은 JSON 복사로 저장한다. */
function fakeArea() {
  /** @type {Record<string, string>} */
  const data = {};
  return {
    data,
    /** @param {string | string[] | null} [keys] */
    async get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      /** @type {Record<string, any>} */
      const out = {};
      for (const k of list) if (k in data) out[k] = JSON.parse(data[k]);
      return out;
    },
    /** @param {Record<string, any>} items */
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = JSON.stringify(v);
    },
    /** @param {string | string[]} keys */
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

const load = () => import("../extension/sw/store.js");

const snap = (playSeq = "001") => ({ playSeq, source: "net", available: [], totalSeats: 10, takenAt: 1 });

test("저장된 탭이 없으면 IDLE 기본 상태", async () => {
  const { createStore } = await load();
  const s = createStore(fakeArea());
  assert.deepEqual(await s.getTab(1), {
    watch: "IDLE", blindReason: null, frames: {}, seatMapFrameId: null, lastOkAt: null,
  });
});

test("SW 재시작 후에도 상태가 복원된다 (같은 area, 새 store)", async () => {
  const { createStore } = await load();
  const area = fakeArea();
  const s1 = createStore(area);
  await s1.updateTab(7, (t) => { t.watch = "WATCHING"; });
  await s1.setPrev(7, snap());
  await s1.setAlerted(7, "001", ["001|a", "001|b"]);

  const s2 = createStore(area); // 재시작 흉내
  assert.equal((await s2.getTab(7)).watch, "WATCHING");
  assert.deepEqual(await s2.getPrev(7, "001"), snap());
  assert.deepEqual([...(await s2.getAlerted(7, "001"))].sort(), ["001|a", "001|b"]);
});

test("prev·alerted는 회차별로 분리된다", async () => {
  const { createStore } = await load();
  const s = createStore(fakeArea());
  await s.setPrev(1, snap("001"));
  assert.equal(await s.getPrev(1, "002"), null);
  await s.setAlerted(1, "001", ["x"]);
  assert.equal((await s.getAlerted(1, "002")).size, 0);
});

test("updateTab은 겹쳐 호출해도 갱신을 잃지 않는다", async () => {
  const { createStore } = await load();
  const s = createStore(fakeArea());
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      s.updateTab(3, (t) => { t.frames[String(i)] = { url: "u", state: "ok", lastSeenAt: i }; }),
    ),
  );
  assert.equal(Object.keys((await s.getTab(3)).frames).length, 20);
});

test("updateTab 콜백이 던져도 다음 작업은 진행된다", async () => {
  const { createStore } = await load();
  const s = createStore(fakeArea());
  await assert.rejects(s.updateTab(4, () => { throw new Error("boom"); }));
  const t = await s.updateTab(4, (t) => { t.watch = "FOUND"; });
  assert.equal(t.watch, "FOUND");
});

test("clearTab은 해당 탭 키만 지운다", async () => {
  const { createStore } = await load();
  const area = fakeArea();
  const s = createStore(area);
  await s.setTab(1, { watch: "WATCHING", blindReason: null, frames: {}, seatMapFrameId: null, lastOkAt: null });
  await s.setPrev(1, snap());
  await s.setAlerted(1, "001", ["k"]);
  await s.setTab(12, { watch: "WATCHING", blindReason: null, frames: {}, seatMapFrameId: null, lastOkAt: null });
  await s.setPrev(12, snap());

  await s.clearTab(1);
  assert.deepEqual(Object.keys(area.data).sort(), ["prev:12:001", "tab:12"]);
  assert.deepEqual(await s.listTabIds(), [12]);
});

test("updateTab 진행 중에 clearTab이 와도 닫힌 탭 상태가 되살아나지 않는다", async () => {
  const { createStore } = await load();
  const area = fakeArea();
  const s = createStore(area);
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => { release = () => r(undefined); });
  const updating = s.updateTab(5, async (t) => { await gate; t.watch = "WATCHING"; });
  const clearing = s.clearTab(5);
  release();
  await Promise.all([updating, clearing]);
  assert.equal("tab:5" in area.data, false);
});

test("updateTab은 async 콜백의 반환값을 저장한다", async () => {
  const { createStore } = await load();
  const s = createStore(fakeArea());
  await s.updateTab(6, async (t) => ({ ...t, watch: "BLIND", blindReason: "queue" }));
  const t = await s.getTab(6);
  assert.equal(t.watch, "BLIND");
  assert.equal(t.blindReason, "queue");
});

test("메서드를 꺼내 써도 동작한다 (this에 의존하지 않음)", async () => {
  const { createStore } = await load();
  const { updateTab, getTab } = createStore(fakeArea());
  await updateTab(8, (t) => { t.watch = "FOUND"; });
  assert.equal((await getTab(8)).watch, "FOUND");
});
