// @ts-check
// 좌석 스냅샷 처리 (DESIGN 5.1, 6, 7.1, 10, 16). content script → SW.
// 대상 공연 확인 → 기준 보정(newBlocks) → 감지 → 상태 저장 → 알림·포커스·로그.
// 의존성을 주입받아 Node에서 테스트한다.

/**
 * @typedef {import("../shared/types.js").Snapshot} Snapshot
 * @typedef {import("../shared/types.js").SeatEvent} SeatEvent
 * @typedef {import("./store.js").TabState} TabState
 *
 * @typedef {Object} WatchDeps
 * @property {ReturnType<typeof import("./store.js").createStore>} store
 * @property {{ append: (e: any) => Promise<void> }} log
 * @property {{ notify: (kind: any, text: string, opts?: any) => Promise<any> }} notifier
 * @property {(tabId: number, windowId: number) => Promise<unknown>} focus
 * @property {() => Promise<any>} loadUserConfig
 * @property {{ detect: Function }} detector
 * @property {{ withBaseline: Function }} seatParse
 * @property {{ formatSeatEvent: Function, formatBlind: Function, formatRecovered: Function }} format
 * @property {() => number} [now]
 *
 * @typedef {{ id: number, windowId: number }} TabRef
 */

/** @param {WatchDeps} deps */
export function createWatcher(deps) {
  const now = deps.now ?? Date.now;

  /** 탭마다 스냅샷을 순서대로 처리한다 (3.8초마다 여러 응답이 겹쳐 올 수 있음) */
  /** @type {Map<number, Promise<unknown>>} */
  const queues = new Map();
  /** @template T @param {number} tabId @param {() => Promise<T>} job @returns {Promise<T>} */
  function serial(tabId, job) {
    const run = (queues.get(tabId) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => {});
    queues.set(tabId, tail);
    tail.then(() => { if (queues.get(tabId) === tail) queues.delete(tabId); });
    return run;
  }

  /** @param {SeatEvent} e @param {string} goodsCode @param {string} playSeq */
  function logEntry(e, goodsCode, playSeq) {
    return {
      t: now(),
      kind: e.kind,
      goodsCode,
      playSeq,
      matched: e.matched,
      seats: e.seats.map((s) => ({ grade: s.grade, zone: s.zone, row: s.row, col: s.col })),
    };
  }

  /**
   * 감시 불능에서 돌아왔으면 복구 알림.
   * @param {TabRef} tab @param {TabState} before
   */
  async function maybeRecovered(tab, before) {
    if (before.watch === "BLIND") {
      await deps.notifier.notify("recovered", deps.format.formatRecovered(), { tabId: tab.id, windowId: tab.windowId });
    }
  }

  /**
   * 좌석 스냅샷 하나 처리.
   * @param {TabRef} tab
   * @param {{ goodsCode: string, snapshot: Snapshot, newBlocks: string[] }} msg
   * @returns {Promise<{ ignored?: string, events?: SeatEvent[], watch?: string }>}
   */
  function handleSnapshot(tab, msg) {
    return serial(tab.id, async () => {
      const config = await deps.loadUserConfig();
      const snap = msg.snapshot;
      const target = config.targets.find((/** @type {any} */ t) => t.goodsCode === msg.goodsCode);
      if (!target) return { ignored: "대상 공연 아님" };
      if (target.playSeq.length > 0 && !target.playSeq.includes(snap.playSeq)) return { ignored: "대상 회차 아님" };

      const prevRaw = await deps.store.getPrev(tab.id, snap.playSeq);
      const prev = target.filter.alertOnFirst ? prevRaw : deps.seatParse.withBaseline(prevRaw, snap, msg.newBlocks ?? []);
      const alerted = await deps.store.getAlerted(tab.id, snap.playSeq);
      const { events, alerted: nextAlerted } = deps.detector.detect(prev, snap, target.filter, alerted);

      // 정상 스냅샷만 기준으로 저장한다 (DESIGN 7)
      await deps.store.setPrev(tab.id, snap);
      await deps.store.setAlerted(tab.id, snap.playSeq, nextAlerted);

      const found = events.filter((/** @type {SeatEvent} */ e) => e.kind === "appeared" && e.matched);
      const gone = events.filter((/** @type {SeatEvent} */ e) => e.kind === "disappeared");
      /** @type {TabState | null} */
      let before = null;
      const state = await deps.store.updateTab(tab.id, (t) => {
        before = structuredClone(t);
        t.lastOkAt = now();
        t.blindReason = null;
        if (found.length > 0) t.watch = "FOUND";
        else if (t.watch === "FOUND" && nextAlerted.size === 0) t.watch = "WATCHING";
        else if (t.watch !== "FOUND" && t.watch !== "ASSISTING") t.watch = "WATCHING";
      });
      if (before) await maybeRecovered(tab, before);

      for (const e of events) {
        await deps.log.append(logEntry(e, msg.goodsCode, snap.playSeq)).catch((err) => console.error("[nca] 로그 실패", err));
      }
      for (const e of found) {
        await deps.notifier.notify("found", deps.format.formatSeatEvent(e), { tabId: tab.id, windowId: tab.windowId });
      }
      if (found.length > 0) await deps.focus(tab.id, tab.windowId);
      for (const e of gone) {
        await deps.notifier.notify("gone", deps.format.formatSeatEvent(e), { tabId: tab.id, windowId: tab.windowId });
      }
      return { events, watch: state.watch };
    });
  }

  /**
   * 파싱 실패 등 감시 불능 (FR-11). 같은 사유로는 한 번만 알린다.
   * @param {TabRef} tab
   * @param {{ reason: string, detail?: string, goodsCode?: string, playSeq?: string }} msg
   */
  function handleBlind(tab, msg) {
    return serial(tab.id, async () => {
      if (msg.goodsCode) {
        const config = await deps.loadUserConfig();
        if (!config.targets.some((/** @type {any} */ t) => t.goodsCode === msg.goodsCode)) return { notified: false, ignored: "대상 공연 아님" };
      }
      /** @type {TabState | null} */
      let before = null;
      await deps.store.updateTab(tab.id, (t) => {
        before = structuredClone(t);
        t.watch = "BLIND";
        t.blindReason = msg.reason;
      });
      const b = /** @type {TabState} */ (/** @type {unknown} */ (before));
      if (b.watch === "BLIND" && b.blindReason === msg.reason) return { notified: false };
      await deps.notifier.notify("blind", deps.format.formatBlind(msg.reason), { tabId: tab.id, windowId: tab.windowId });
      await deps.log.append({
        t: now(), kind: "blind", goodsCode: msg.goodsCode ?? "", playSeq: msg.playSeq ?? "", matched: false, seats: [], reason: msg.reason,
      }).catch(() => {});
      return { notified: true };
    });
  }

  return { handleSnapshot, handleBlind };
}
