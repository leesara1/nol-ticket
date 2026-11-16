// @ts-check
// service worker 진입점 (DESIGN 3, 3.3).
// 리스너는 모두 최상위에서 동기적으로 등록한다. 상태는 store(storage.session)에 둔다.

import "./shared/types.js";
import "./shared/detector.js";
import "./shared/config-validate.js";
import { createStore } from "./sw/store.js";

const store = createStore(chrome.storage.session);
const { configValidate } = /** @type {any} */ (globalThis).NCA;

/**
 * 사용자 설정을 읽어 검증된 설정 객체를 돌려준다. 경고는 콘솔에만 남긴다 (옵션 페이지가 따로 보여줌).
 * 3단계 이후 감시·알림 모듈에서 쓴다.
 */
async function loadUserConfig() {
  const { userConfig } = await chrome.storage.local.get("userConfig");
  const { config, warnings } = configValidate.validateUserConfig(userConfig ?? configValidate.defaultUserConfig());
  if (warnings.length > 0) console.warn("[nca] 설정 경고", warnings);
  return config;
}
void loadUserConfig; // 아직 호출하는 곳 없음

// 설치·업데이트: 사용자 설정이 없으면 기본값을 저장하고, 처음 설치면 옵션 페이지를 연다.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { userConfig } = await chrome.storage.local.get("userConfig");
  if (!userConfig) {
    await chrome.storage.local.set({ userConfig: configValidate.defaultUserConfig() });
  }
  if (reason === "install") {
    await chrome.runtime.openOptionsPage();
  }
});

// 탭이 닫히면 그 탭의 감시 상태를 정리한다 (DESIGN 12.4).
chrome.tabs.onRemoved.addListener((tabId) => {
  store.clearTab(tabId).catch((e) => console.error("[nca] clearTab 실패", e));
});

// 이후 단계에서 추가: runtime.onConnect(content 포트), alarms.onAlarm(health·scheduler),
// notifications.onClicked(포커스). 모두 이 파일 최상위에 등록한다.
