// @ts-check
// 이벤트 로그 (DESIGN 16, 16.1, NFR-5). chrome.storage.local에 일별 키로 계속 쌓는다.
// area·now·dayKey를 주입받아 Node에서 테스트한다.

/**
 * @typedef {import("./store.js").StorageArea} StorageArea
 *
 * @typedef {Object} LogEntry
 * @property {number} t
 * @property {"appeared"|"disappeared"|"blind"|"recovered"} kind
 * @property {string} goodsCode
 * @property {string} playSeq
 * @property {boolean} matched
 * @property {Array<{grade: string, zone: string, row: string, col: number}>} seats
 * @property {string} [reason]
 */

const PREFIX = "log:";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {StorageArea} area           보통 chrome.storage.local
 * @param {{ now?: () => number, dayKey: (ts: number) => string }} deps
 */
export function createLog(area, { now = Date.now, dayKey }) {
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /** 같은 키를 동시에 고쳐 항목을 잃지 않도록 append·prune을 순서대로 실행한다. @template T @param {() => Promise<T>} job */
  function serial(job) {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
  }

  /**
   * 항목 하나 추가. t가 없으면 now().
   * @param {Omit<LogEntry, "t"> & { t?: number }} entry
   */
  function append(entry) {
    return serial(async () => {
      const t = entry.t ?? now();
      const key = PREFIX + dayKey(t);
      const r = await area.get(key);
      const list = Array.isArray(r[key]) ? r[key] : [];
      list.push({ ...entry, t });
      await area.set({ [key]: list });
    });
  }

  /**
   * 기간 안의 항목을 시간순으로. from·to는 "YYYY-MM-DD" (포함), 생략하면 전체.
   * @param {{ from?: string, to?: string }} [range]
   * @returns {Promise<LogEntry[]>}
   */
  async function list(range = {}) {
    const all = await area.get(null);
    /** @type {LogEntry[]} */
    const out = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(PREFIX) || !Array.isArray(v)) continue;
      const day = k.slice(PREFIX.length);
      if (range.from && day < range.from) continue;
      if (range.to && day > range.to) continue;
      out.push(...v);
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /**
   * keepDays일보다 오래된 날짜 키를 지운다. 지운 키 개수를 돌려준다.
   * @param {number} [keepDays]
   */
  function prune(keepDays = 90) {
    return serial(async () => {
      const cutoff = dayKey(now() - keepDays * DAY_MS);
      const all = await area.get(null);
      const old = Object.keys(all).filter((k) => k.startsWith(PREFIX) && k.slice(PREFIX.length) < cutoff);
      if (old.length > 0) await area.remove(old);
      return old.length;
    });
  }

  return { append, list, prune };
}
