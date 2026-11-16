// @ts-check
// service worker 진입점 (DESIGN 3, 3.3, 10.1, 16.1, 16A).
// 리스너는 모두 최상위에서 동기적으로 등록한다. 상태는 store(storage.session)에 둔다.

import "./shared/types.js";
import "./shared/detector.js";
import "./shared/config-validate.js";
import "./shared/format.js";
import "./shared/seat-parse.js";
import "./shared/assist-plan.js";
import { createStore } from "./sw/store.js";
import { createLog } from "./sw/log.js";
import { createNotifier, parseNotificationId } from "./sw/notifier.js";
import { focusTab } from "./sw/focus.js";
import { createWatcher } from "./sw/watch.js";

const { configValidate, format, detector, seatParse, assistPlan } = /** @type {any} */ (globalThis).NCA;

const store = createStore(chrome.storage.session);
const log = createLog(chrome.storage.local, { dayKey: format.dayKey });

/**
 * 사용자 설정을 읽어 검증된 설정 객체를 돌려준다. 경고는 콘솔에만 남긴다 (옵션 페이지가 따로 보여줌).
 */
async function loadUserConfig() {
  const { userConfig } = await chrome.storage.local.get("userConfig");
  const { config, warnings } = configValidate.validateUserConfig(userConfig ?? configValidate.defaultUserConfig());
  if (warnings.length > 0) console.warn("[nca] 설정 경고", warnings);
  return config;
}

// ── 소리 (offscreen) ─────────────────────────────────────

const OFFSCREEN_URL = "offscreen/offscreen.html";
/** @type {Promise<void> | null} */
let creatingOffscreen = null;

/**
 * offscreen 문서는 하나만 만들 수 있으므로 있는지 확인하고 없으면 만든다 (DESIGN 3.2).
 * 확인부터 생성까지 하나의 잠금으로 묶어, 동시에 불려도 한 번만 만든다.
 */
function ensureOffscreen() {
  creatingOffscreen ??= (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    if (contexts.length > 0) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: "취소표 알림 신호음 재생",
    });
  })().finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

/**
 * 소리 재생. 문서를 막 만든 직후라 offscreen 리스너가 아직 없으면 한 번 다시 시도한다.
 * @param {"found"|"blind"} pattern
 */
async function playSound(pattern) {
  await ensureOffscreen();
  const msg = { target: "offscreen", type: "PLAY", pattern };
  /** @type {any} */
  let r = await chrome.runtime.sendMessage(msg).catch(() => null);
  if (!r) {
    await new Promise((res) => setTimeout(res, 150));
    r = await chrome.runtime.sendMessage(msg);
  }
  if (!r?.ok) throw new Error(r?.error ?? "offscreen 응답 없음");
}

const notifier = createNotifier({
  notifications: chrome.notifications,
  playSound,
  fetch: (url, init) => fetch(url, init),
  session: chrome.storage.session,
  getChannels: async () => (await loadUserConfig()).notify,
  iconUrl: chrome.runtime.getURL("icons/icon128.png"),
});

// ── 팝업·옵션 메시지 ─────────────────────────────────────

/** @param {any} msg */
async function handleMessage(msg) {
  switch (msg?.type) {
    case "GET_STATUS": {
      const c = await loadUserConfig();
      const tabIds = await store.listTabIds();
      const tabs = [];
      for (const tabId of tabIds) {
        const t = await store.getTab(tabId);
        if (t.watch !== "IDLE") tabs.push({ tabId, watch: t.watch, blindReason: t.blindReason });
      }
      return {
        ok: true,
        targets: c.targets.map((/** @type {any} */ t) => t.goodsCode),
        channels: { sound: c.notify.sound, desktop: c.notify.desktop, telegram: c.notify.telegram.enabled },
        tabs,
      };
    }
    case "TEST_NOTIFY": {
      const { results } = await notifier.notify("test", "알림 테스트입니다. 이 알림이 보이면 설정이 정상입니다.", { force: true });
      return { ok: true, results };
    }
    case "LOG_LIST": {
      const entries = await log.list({ from: msg.from, to: msg.to });
      return { ok: true, entries };
    }
    default:
      return null; // 처리하지 않는 메시지
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "offscreen") return false; // offscreen 문서가 받는 메시지
  if (sender.id !== chrome.runtime.id) return false;
  // 팝업·옵션 전용 메시지: 확장 내부 페이지에서 온 것만 받는다.
  // 탭으로 열린 옵션 페이지도 sender.tab이 있으므로 tab 유무가 아니라 URL로 구분한다.
  // content script는 sender.url이 사이트 주소이고, 포트로 따로 통신한다.
  if (!sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  handleMessage(msg).then(
    (r) => { if (r) sendResponse(r); else sendResponse({ ok: false, error: `unknown message: ${msg?.type}` }); },
    (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
  );
  return true; // 비동기 응답
});

// ── 알림 클릭 → 해당 탭으로 (DESIGN 11.1) ────────────────

chrome.notifications.onClicked.addListener((id) => {
  const p = parseNotificationId(id);
  chrome.notifications.clear(id);
  if (p) focusTab(chrome, p.tabId, p.windowId);
});

// ── 설치·시작 ────────────────────────────────────────────

// 설치·업데이트: 사용자 설정이 없으면 기본값을 저장하고, 처음 설치면 옵션 페이지를 연다.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { userConfig } = await chrome.storage.local.get("userConfig");
  if (!userConfig) {
    await chrome.storage.local.set({ userConfig: configValidate.defaultUserConfig() });
  }
  await log.prune().catch((e) => console.error("[nca] 로그 정리 실패", e));
  if (reason === "install") {
    await chrome.runtime.openOptionsPage();
  }
});

// 브라우저 시작 시 오래된 로그 정리 (90일)
chrome.runtime.onStartup.addListener(() => {
  log.prune().catch((e) => console.error("[nca] 로그 정리 실패", e));
});

// 탭이 닫히면 그 탭의 감시 상태를 정리한다 (DESIGN 12.4).
chrome.tabs.onRemoved.addListener((tabId) => {
  store.clearTab(tabId).catch((e) => console.error("[nca] clearTab 실패", e));
});

// ── 좌석 화면 content script 포트 (DESIGN 7.1, 13) ───────

/** 좌석 화면 탭의 content 포트 (강조 전송용). SW가 재시작되면 비지만 content가 다시 연결한다 */
/** @type {Map<number, chrome.runtime.Port>} */
const contentPorts = new Map();

const watcher = createWatcher({
  store,
  log,
  notifier,
  focus: (tabId, windowId) => focusTab(chrome, tabId, windowId),
  loadUserConfig,
  detector,
  seatParse,
  format,
  assistPlan,
  highlight: (tabId, plan) => {
    try { contentPorts.get(tabId)?.postMessage({ type: "HIGHLIGHT", ...plan }); } catch { /* 끊긴 포트 */ }
  },
});

/** @type {Promise<any> | null} */
let siteConfig = null;
/** 사이트 설정(extension/config/site.nol.json). SW는 자기 파일을 읽을 수 있다. */
function loadSiteConfig() {
  siteConfig ??= fetch(chrome.runtime.getURL("config/site.nol.json"))
    .then((r) => r.json())
    .catch((e) => { siteConfig = null; throw e; });
  return siteConfig;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "nca-content") return;
  const tab = port.sender?.tab;
  // 좌석 화면 탭에서 온 포트만 받는다 (확장 내부 페이지·다른 확장 제외)
  if (!tab || tab.id === undefined || port.sender?.id !== chrome.runtime.id) { port.disconnect(); return; }
  const ref = { id: tab.id, windowId: tab.windowId };
  contentPorts.set(tab.id, port);
  // content script는 확장 파일을 직접 못 읽으므로 사이트 설정을 보내준다 (DESIGN 13)
  loadSiteConfig().then(
    (site) => {
      try {
        port.postMessage({
          type: "CONFIG",
          net: { metaUrlPattern: site.net.metaUrlPattern, statusUrlPattern: site.net.statusUrlPattern },
          pageState: { gqlUrlPattern: site.pageState?.gqlUrlPattern, expiredOperation: site.pageState?.expiredOperation },
          seatPageUrlPattern: site.seatMapFrame?.urlPattern,
          assist: site.assist,
        });
      } catch { /* 이미 끊김 */ }
    },
    (e) => console.error("[nca] 사이트 설정을 읽지 못했습니다", e),
  );
  port.onMessage.addListener((msg) => {
    if (msg?.type === "SNAPSHOT" && msg.snapshot && Array.isArray(msg.snapshot.available)) {
      watcher.handleSnapshot(ref, msg).catch((e) => console.error("[nca] 스냅샷 처리 실패", e));
    } else if (msg?.type === "BLIND" && typeof msg.reason === "string") {
      watcher.handleBlind(ref, msg).catch((e) => console.error("[nca] 감시 불능 처리 실패", e));
    } else if (msg?.type === "LEAVE") {
      watcher.handleLeave(ref).catch((e) => console.error("[nca] 이탈 처리 실패", e));
    }
  });
  // 페이지를 떠나면(이동·닫기·새로고침) 포트가 끊긴다 → 조용히 IDLE (DESIGN 5.3)
  port.onDisconnect.addListener(() => {
    if (contentPorts.get(ref.id) === port) contentPorts.delete(ref.id);
    watcher.handleLeave(ref).catch((e) => console.error("[nca] 이탈 처리 실패", e));
  });
});

// ── 생존 확인: 30초 주기로 응답 끊김(stale) 판정 (DESIGN 5.3) ──

const HEALTH_ALARM = "nca-health";
// 같은 이름은 덮어쓰므로 SW가 다시 떠도 중복되지 않는다. 0.5분 = MV3 최소 주기
chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });

/** @param {number} tabId */
async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEALTH_ALARM) return;
  watcher.checkStale(tabExists).catch((e) => console.error("[nca] 생존 확인 실패", e));
});
