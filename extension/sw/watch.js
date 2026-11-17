// @ts-check
// 좌석 스냅샷 처리 (DESIGN 5.1, 6, 7.1, 10, 16). content script → SW.
// 대상 공연 확인 → 기준 보정(newBlocks) → 감지 → 상태 저장 → 알림·포커스·로그.
// 6단계: 페이지 이탈(LEAVE·포트 끊김) → IDLE, 30초 응답 끊김 → stale, 좌석을 찾은 뒤의 만료·끊김은 알리지 않음.
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
 * @property {{ planHighlight: Function }} [assistPlan]
 * @property {(tabId: number, plan: { add: any[], remove: string[], banner: string | null }) => void} [highlight]  좌석 화면에 강조 전송 (7단계)
 * @property {() => number} [now]
 *
 * @typedef {{ id: number, windowId: number }} TabRef
 */

export const STALE_MS = 30_000;

/** 좌석을 이미 찾았거나 고르는 중이면 만료·끊김을 알리지 않는다 (DESIGN 8) */
const QUIET_WHEN = new Set(["FOUND", "ASSISTING"]);
const QUIET_REASONS = new Set(["expired", "stale"]);

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
      if (!target) {
        await deps.store.updateTab(tab.id, (t) => {
          t.watch = "IDLE";
          t.goodsCode = msg.goodsCode;
          t.playSeq = snap.playSeq;
          t.windowId = tab.windowId;
          t.lastOkAt = now();
        });
        return { ignored: "대상 공연 아님" };
      }
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
        t.goodsCode = msg.goodsCode;
        t.playSeq = snap.playSeq;
        t.windowId = tab.windowId;
        if (found.length > 0) t.watch = "FOUND";
        else if (t.watch === "FOUND" && nextAlerted.size === 0) t.watch = "WATCHING";
        else if (t.watch !== "FOUND" && t.watch !== "ASSISTING") t.watch = "WATCHING";
      });
      if (before) await maybeRecovered(tab, before);

      for (const e of events) {
        await deps.log.append(logEntry(e, msg.goodsCode, snap.playSeq)).catch((err) => console.error("[nca] 로그 실패", err));
      }
      // 강조는 알림보다 먼저 보낸다 (탭을 앞으로 가져왔을 때 이미 표시돼 있도록)
      if (deps.assistPlan && deps.highlight) {
        const plan = deps.assistPlan.planHighlight(events);
        if (plan.add.length > 0 || plan.remove.length > 0) deps.highlight(tab.id, { ...plan, autoZoom: config.assist?.autoZoom !== false });
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
      const current = await deps.store.getTab(tab.id);
      const goodsCode = msg.goodsCode || current.goodsCode || "";
      if (goodsCode) {
        const config = await deps.loadUserConfig();
        if (!config.targets.some((/** @type {any} */ t) => t.goodsCode === goodsCode)) return { notified: false, ignored: "대상 공연 아님" };
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
      if (QUIET_WHEN.has(b.watch) && QUIET_REASONS.has(msg.reason)) return { notified: false, quiet: true };
      await deps.notifier.notify("blind", deps.format.formatBlind(msg.reason), { tabId: tab.id, windowId: tab.windowId });
      await deps.log.append({
        t: now(), kind: "blind", goodsCode, playSeq: msg.playSeq || current.playSeq || "", matched: false, seats: [], reason: msg.reason,
      }).catch(() => {});
      return { notified: true };
    });
  }

  /**
   * 페이지를 떠남 (좌석 화면이 아닌 주소로 이동, 포트 끊김). 조용히 IDLE로 (DESIGN 5.3).
   * @param {TabRef} tab
   */
  function handleLeave(tab) {
    return serial(tab.id, async () => {
      await deps.store.updateTab(tab.id, (t) => {
        t.watch = "IDLE";
        t.blindReason = null;
      });
    });
  }

  /**
   * 30초 주기 알람에서 호출: 감시 중인데 응답이 끊긴 탭을 stale로 (DESIGN 5.3).
   * 닫힌 탭은 상태를 지운다.
   * @param {(tabId: number) => Promise<boolean>} tabExists
   * @returns {Promise<number[]>} stale로 바꾼 탭
   */
  async function checkStale(tabExists) {
    /** @type {number[]} */
    const staled = [];
    for (const tabId of await deps.store.listTabIds()) {
      if (!(await tabExists(tabId))) {
        await deps.store.clearTab(tabId);
        continue;
      }
      const t = await deps.store.getTab(tabId);
      if (t.watch !== "WATCHING" || t.lastOkAt === null || now() - t.lastOkAt <= STALE_MS) continue;
      await handleBlind({ id: tabId, windowId: t.windowId ?? -1 }, { reason: "stale" });
      staled.push(tabId);
    }
    return staled;
  }

  return { handleSnapshot, handleBlind, handleLeave, checkStale };
}
