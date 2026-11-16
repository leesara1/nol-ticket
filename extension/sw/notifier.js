// @ts-check
// 알림 발송 (DESIGN 10, 10.1). 크롬 알림, offscreen 소리, 텔레그램.
// chrome API와 fetch를 주입받아 Node에서 테스트한다.

/**
 * @typedef {import("./store.js").StorageArea} StorageArea
 * @typedef {"found"|"gone"|"blind"|"recovered"|"test"} NotifyKind
 *
 * @typedef {Object} ChannelConfig  userConfig.notify
 * @property {boolean} sound
 * @property {boolean} desktop
 * @property {{ enabled: boolean, token: string, chatId: string }} telegram
 *
 * @typedef {Object} NotifierDeps
 * @property {{ create: (id: string, opts: object) => Promise<unknown> }} notifications
 * @property {(pattern: "found"|"blind") => Promise<void>} playSound   offscreen 소리 재생
 * @property {(url: string, init: object) => Promise<{ ok: boolean, status: number }>} fetch
 * @property {StorageArea} session   중복 방지 기억 (chrome.storage.session)
 * @property {() => Promise<ChannelConfig>} getChannels
 * @property {() => number} [now]
 * @property {string} [iconUrl]
 */

const DEDUPE_MS = 30_000;

/** 소리 패턴: 좌석 관련은 found, 감시 상태 관련은 blind */
/** @type {Record<NotifyKind, "found"|"blind"|null>} */
const SOUND = { found: "found", gone: null, blind: "blind", recovered: "blind", test: "found" };

/** @type {Record<NotifyKind, string>} */
const TITLE = {
  found: "취소표 생김",
  gone: "좌석 사라짐",
  blind: "감시 불능",
  recovered: "감시 복구",
  test: "알림 테스트",
};

/**
 * 알림 ID `{kind}:{tabId}:{windowId}:{시각}` (DESIGN 10.1).
 * @param {NotifyKind} kind @param {number} tabId @param {number} windowId @param {number} t
 */
export function makeNotificationId(kind, tabId, windowId, t) {
  return `${kind}:${tabId}:${windowId}:${t}`;
}

/**
 * @param {string} id
 * @returns {{ kind: NotifyKind, tabId: number, windowId: number } | null}
 */
export function parseNotificationId(id) {
  const m = /^(found|gone|blind|recovered|test):(-?\d+):(-?\d+):\d+$/.exec(id);
  if (!m) return null;
  return { kind: /** @type {NotifyKind} */ (m[1]), tabId: Number(m[2]), windowId: Number(m[3]) };
}

/** 문자열 해시 (중복 방지 키용, 보안 용도 아님). @param {string} s */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** @param {NotifierDeps} deps */
export function createNotifier(deps) {
  const now = deps.now ?? Date.now;

  /**
   * 30초 안에 같은 문구를 보냈으면 true. 아니면 기록하고 false.
   * @param {string} text
   */
  async function isDuplicate(text) {
    const key = `notified:${hash(text)}`;
    const r = await deps.session.get(key);
    const last = r[key];
    const t = now();
    if (typeof last === "number" && t - last < DEDUPE_MS) return true;
    await deps.session.set({ [key]: t });
    // 지난 기록 정리: 30초가 지난 notified: 키는 더 이상 필요 없다
    const all = await deps.session.get(null);
    const stale = Object.keys(all).filter((k) => k.startsWith("notified:") && typeof all[k] === "number" && t - all[k] >= DEDUPE_MS);
    if (stale.length > 0) await deps.session.remove(stale);
    return false;
  }

  /**
   * @param {{ token: string, chatId: string }} tg @param {string} text
   */
  async function sendTelegram(tg, text) {
    const url = `https://api.telegram.org/bot${encodeURIComponent(tg.token)}/sendMessage`;
    try {
      const res = await deps.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tg.chatId, text: `[NOL 취소표 알리미] ${text}` }),
      });
      if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
    } catch (e) {
      // 오류 문구가 콘솔·팝업에 나가므로 토큰을 가린다
      let msg = String(/** @type {any} */ (e)?.message ?? e);
      for (const secret of [tg.token, encodeURIComponent(tg.token)]) {
        if (secret) msg = msg.split(secret).join("[토큰]");
      }
      throw new Error(msg);
    }
  }

  /**
   * 켜진 채널로 보낸다. 한 채널이 실패해도 나머지는 계속한다.
   * @param {NotifyKind} kind
   * @param {string} text
   * @param {{ tabId?: number, windowId?: number, force?: boolean }} [opts]  force: 중복 방지 무시 (테스트 알림)
   * @returns {Promise<{ skipped: boolean, results: Record<"desktop"|"sound"|"telegram", "sent"|"off"|string> }>}
   */
  async function notify(kind, text, opts = {}) {
    /** @type {Record<"desktop"|"sound"|"telegram", "sent"|"off"|string>} */
    const results = { desktop: "off", sound: "off", telegram: "off" };
    if (!opts.force && (await isDuplicate(`${kind}|${text}`))) return { skipped: true, results };

    const ch = await deps.getChannels();
    const t = now();
    const id = makeNotificationId(kind, opts.tabId ?? -1, opts.windowId ?? -1, t);

    /** @type {Array<Promise<void>>} */
    const jobs = [];
    if (ch.desktop) {
      jobs.push(
        deps.notifications
          .create(id, {
            type: "basic",
            iconUrl: deps.iconUrl ?? "icons/icon128.png",
            title: TITLE[kind],
            message: text,
            priority: kind === "found" ? 2 : 1,
            requireInteraction: kind === "found",
          })
          .then(() => { results.desktop = "sent"; }, (e) => { results.desktop = `error: ${e?.message ?? e}`; }),
      );
    }
    const pattern = SOUND[kind];
    if (ch.sound && pattern) {
      jobs.push(deps.playSound(pattern).then(() => { results.sound = "sent"; }, (e) => { results.sound = `error: ${e?.message ?? e}`; }));
    }
    if (ch.telegram?.enabled) {
      jobs.push(sendTelegram(ch.telegram, text).then(() => { results.telegram = "sent"; }, (e) => { results.telegram = `error: ${e?.message ?? e}`; }));
    }
    await Promise.all(jobs);
    for (const [name, r] of Object.entries(results)) {
      if (r.startsWith("error")) console.warn(`[nca] ${name} 알림 실패`, r);
    }
    return { skipped: false, results };
  }

  return { notify };
}
