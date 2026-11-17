// @ts-check
// service worker 상태 저장 (DESIGN 3.3, 12.4).
// SW는 언제든 종료될 수 있으므로 상태는 메모리가 아니라 chrome.storage.session에 둔다.
// area를 주입받아 Node 테스트에서는 가짜 저장소를 쓴다.

/**
 * @typedef {import("../shared/types.js").Snapshot} Snapshot
 * @typedef {"IDLE"|"WATCHING"|"BLIND"|"FOUND"|"ASSISTING"} WatchState
 *
 * @typedef {Object} FrameInfo
 * @property {string} url
 * @property {import("../shared/types.js").PageState} state
 * @property {number} lastSeenAt
 *
 * @typedef {Object} TabState
 * @property {WatchState} watch
 * @property {string | null} blindReason
 * @property {Record<string, FrameInfo>} frames
 * @property {number | null} seatMapFrameId
 * @property {number | null} lastOkAt
 * @property {string} [goodsCode]   마지막 스냅샷의 공연 (응답 끊김 알림·대상 확인용)
 * @property {string} [playSeq]
 * @property {number} [windowId]    알림 클릭 시 포커스용
 * @property {any} [diag]            진단 (팝업 표시용): 연결 시각, 설정 수신, 받은 응답 수, 마지막 오류
 *
 * @typedef {Object} StorageArea  chrome.storage.StorageArea 중 쓰는 부분
 * @property {(keys?: string | string[] | null) => Promise<Record<string, any>>} get
 * @property {(items: Record<string, any>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/** @returns {TabState} */
export function emptyTabState() {
  return { watch: "IDLE", blindReason: null, frames: {}, seatMapFrameId: null, lastOkAt: null };
}

/** @param {number} tabId */
const tabKey = (tabId) => `tab:${tabId}`;
/** @param {number} tabId @param {string} playSeq */
const prevKey = (tabId, playSeq) => `prev:${tabId}:${playSeq}`;
/** @param {number} tabId @param {string} playSeq */
const alertedKey = (tabId, playSeq) => `alerted:${tabId}:${playSeq}`;

/**
 * @param {StorageArea} area  보통 chrome.storage.session
 */
export function createStore(area) {
  // 메서드끼리 this로 부르지 않는다. const { updateTab } = store 처럼 꺼내 써도 동작해야 한다.

  /** @param {number} tabId @returns {Promise<TabState>} */
  async function getTab(tabId) {
    const k = tabKey(tabId);
    const r = await area.get(k);
    return r[k] ?? emptyTabState();
  }

  /** @param {number} tabId @param {TabState} state */
  async function setTab(tabId, state) {
    await area.set({ [tabKey(tabId)]: state });
  }

  /**
   * 읽고-고치고-저장. 같은 SW 안에서 이벤트가 겹쳐도 덮어쓰지 않도록 탭별로 직렬화한다.
   * 콜백은 draft를 직접 고치거나 새 상태를 반환한다. async 콜백도 된다.
   * @param {number} tabId
   * @param {(state: TabState) => TabState | void | Promise<TabState | void>} fn
   * @returns {Promise<TabState>}
   */
  function updateTab(tabId, fn) {
    return serialize(tabKey(tabId), async () => {
      const draft = structuredClone(await getTab(tabId));
      const next = (await fn(draft)) ?? draft;
      await setTab(tabId, next);
      return next;
    });
  }

  /** @param {number} tabId @param {string} playSeq @returns {Promise<Snapshot | null>} */
  async function getPrev(tabId, playSeq) {
    const k = prevKey(tabId, playSeq);
    const r = await area.get(k);
    return r[k] ?? null;
  }

  /**
   * 정상 스냅샷만 저장한다. 실패 스냅샷은 호출하지 않는다 (DESIGN 7절).
   * @param {number} tabId @param {Snapshot} snapshot
   */
  async function setPrev(tabId, snapshot) {
    await area.set({ [prevKey(tabId, snapshot.playSeq)]: snapshot });
  }

  /** @param {number} tabId @param {string} playSeq @returns {Promise<Set<string>>} */
  async function getAlerted(tabId, playSeq) {
    const k = alertedKey(tabId, playSeq);
    const r = await area.get(k);
    return new Set(r[k] ?? []);
  }

  /** @param {number} tabId @param {string} playSeq @param {Iterable<string>} keys */
  async function setAlerted(tabId, playSeq, keys) {
    await area.set({ [alertedKey(tabId, playSeq)]: [...keys] });
  }

  /** @returns {Promise<number[]>} 저장된 탭 ID 목록 */
  async function listTabIds() {
    const all = await area.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith("tab:"))
      .map((k) => Number(k.slice(4)))
      .filter(Number.isInteger);
  }

  /**
   * 탭이 닫히면 해당 탭의 모든 키를 지운다.
   * updateTab과 같은 큐로 직렬화해, 진행 중이던 갱신이 삭제 뒤에 상태를 되살리지 않게 한다.
   * @param {number} tabId
   */
  function clearTab(tabId) {
    return serialize(tabKey(tabId), async () => {
      const all = await area.get(null);
      const keys = Object.keys(all).filter(
        (k) => k === tabKey(tabId) || k.startsWith(`prev:${tabId}:`) || k.startsWith(`alerted:${tabId}:`),
      );
      if (keys.length > 0) await area.remove(keys);
    });
  }

  return { getTab, setTab, updateTab, getPrev, setPrev, getAlerted, setAlerted, listTabIds, clearTab };
}

/** @type {Map<string, Promise<unknown>>} */
const queues = new Map();

/**
 * 같은 이름의 작업을 순서대로 실행한다.
 * @template T @param {string} name @param {() => Promise<T>} job @returns {Promise<T>}
 */
function serialize(name, job) {
  const prev = queues.get(name) ?? Promise.resolve();
  const run = prev.then(job, job);
  const tail = run.catch(() => {});
  queues.set(name, tail);
  tail.then(() => {
    if (queues.get(name) === tail) queues.delete(name);
  });
  return run;
}
