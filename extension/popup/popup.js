// @ts-check
// 툴바 팝업 (DESIGN 16A). SW에 GET_STATUS를 물어 현재 상태를 보여준다.
"use strict";

(function () {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

  /** @type {Record<string, string>} */
  const WATCH_TEXT = { IDLE: "대기", WATCHING: "감시 중", BLIND: "감시 불능", FOUND: "좌석 발견", ASSISTING: "선택 중" };

  async function render() {
    const s = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (!s?.ok) throw new Error(s?.error ?? "응답 없음");

    $("targets").textContent = s.targets.length === 0 ? "없음 (설정에서 추가)" : s.targets.join(", ");
    const ch = [s.channels.sound && "소리", s.channels.desktop && "크롬 알림", s.channels.telegram && "텔레그램"].filter(Boolean);
    $("channels").textContent = ch.length === 0 ? "모두 꺼짐" : ch.join(", ");

    const ul = $("tabs");
    if (s.tabs.length === 0) {
      ul.innerHTML = "";
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "감시 중인 탭 없음 — 감지 기능은 5단계에서 연결됩니다";
      ul.append(li);
      return;
    }
    ul.replaceChildren(
      ...s.tabs.map((/** @type {{tabId: number, watch: string, blindReason: string | null}} */ t) => {
        const li = document.createElement("li");
        li.className = `state-${t.watch}`;
        const reason = t.blindReason ? ` — ${/** @type {any} */ (globalThis).NCA.format.blindText(t.blindReason)}` : "";
        li.textContent = `탭 ${t.tabId}: ${WATCH_TEXT[t.watch] ?? t.watch}${reason}`;
        return li;
      }),
    );
  }

  $("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

  $("test").addEventListener("click", async () => {
    const btn = /** @type {HTMLButtonElement} */ ($("test"));
    btn.disabled = true;
    $("result").textContent = "보내는 중…";
    try {
      const r = await chrome.runtime.sendMessage({ type: "TEST_NOTIFY" });
      if (!r?.ok) throw new Error(r?.error ?? "응답 없음");
      /** @type {Record<string, string>} */
      const label = { desktop: "크롬 알림", sound: "소리", telegram: "텔레그램" };
      $("result").textContent = Object.entries(r.results)
        .map(([k, v]) => `${label[k]}: ${v === "sent" ? "보냄" : v === "off" ? "꺼짐" : `실패 (${String(v).replace(/^error: /, "")})`}`)
        .join(" · ");
    } catch (e) {
      $("result").textContent = `실패: ${/** @type {Error} */ (e).message}`;
    } finally {
      btn.disabled = false;
    }
  });

  render().catch((e) => {
    $("tabs").textContent = `상태를 불러오지 못했습니다: ${e.message}`;
  });
})();
