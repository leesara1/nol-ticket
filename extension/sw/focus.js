// @ts-check
// 창·탭 포커스 (DESIGN 11.1). Windows는 백그라운드에서 창을 앞으로 가져오는 걸 막는 경우가 많아
// drawAttention(작업표시줄 깜빡임)을 함께 쓰고, 알림 클릭 때 다시 호출한다.

/**
 * @param {{ windows: { update: (id: number, info: object) => Promise<unknown> }, tabs: { update: (id: number, info: object) => Promise<unknown> } }} api
 * @param {number} tabId
 * @param {number} windowId
 * @returns {Promise<boolean>} 둘 다 성공하면 true
 */
export async function focusTab(api, tabId, windowId) {
  let ok = true;
  if (windowId >= 0) {
    await api.windows.update(windowId, { focused: true, drawAttention: true }).catch((e) => {
      ok = false;
      console.warn("[nca] 창 포커스 실패", e);
    });
  }
  if (tabId >= 0) {
    await api.tabs.update(tabId, { active: true }).catch((e) => {
      ok = false;
      console.warn("[nca] 탭 활성화 실패", e);
    });
  }
  return ok;
}
