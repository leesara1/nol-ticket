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

    // 진단: 좌석 탭이 확장과 연결됐는지, 좌석 응답을 받고 있는지
    const dl = $("diag");
    dl.replaceChildren(
      ...(s.diag ?? []).map((/** @type {any} */ d) => {
        const li = document.createElement("li");
        const ago = d.at ? `${Math.round((Date.now() - d.at) / 1000)}초 전` : "아직 없음";
        li.textContent = `탭 ${d.tabId}: 연결됨 · 설정 ${d.config ? "받음" : "못 받음"} · 좌석 배치 ${d.meta ?? 0}건 · 좌석 상태 ${d.status ?? 0}건` +
          (d.goodsCode ? ` · 공연 ${d.goodsCode}` : "") + ` · 마지막 보고 ${ago}` + (d.lastError ? ` · 오류: ${d.lastError}` : "");
        return li;
      }),
    );
    $("diagSection").hidden = (s.diag ?? []).length === 0;

    const ul = $("tabs");
    ul.replaceChildren();
    // 좌석 화면에 있지만 감시 대상이 아닌 공연 → 바로 추가
    for (const u of s.untracked ?? []) {
      const li = document.createElement("li");
      li.className = "untracked";
      const text = document.createElement("span");
      text.textContent = `이 좌석 화면의 공연(${u.goodsCode})은 감시 대상이 아닙니다`;
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = "이 공연 감시하기";
      add.addEventListener("click", () => addTarget(u.goodsCode, false));
      const addNow = document.createElement("button");
      addNow.type = "button";
      addNow.className = "secondary";
      addNow.textContent = "테스트: 지금 빈 좌석도 알림";
      addNow.title = "들어가 있을 때 이미 비어 있는 좌석도 바로 알립니다 (설정의 '감시 시작 시 이미 비어 있는 좌석도 알림')";
      addNow.addEventListener("click", () => addTarget(u.goodsCode, true));
      li.append(text, add, addNow);
      ul.append(li);
    }
    if (s.tabs.length === 0 && (s.untracked ?? []).length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = (s.diag ?? []).length === 0
        ? "좌석 화면과 연결된 탭이 없습니다. 확장을 새로고침했다면 좌석 화면 탭도 새로고침(보안문자부터 다시)해야 합니다"
        : "감시 중인 탭 없음 — 아래 진단을 확인하세요";
      ul.append(li);
      return;
    }
    if (s.tabs.length === 0) return;
    ul.append(
      ...s.tabs.map((/** @type {{tabId: number, watch: string, blindReason: string | null}} */ t) => {
        const li = document.createElement("li");
        li.className = `state-${t.watch}`;
        const reason = t.blindReason ? ` — ${/** @type {any} */ (globalThis).NCA.format.blindText(t.blindReason)}` : "";
        li.textContent = `탭 ${t.tabId}: ${WATCH_TEXT[t.watch] ?? t.watch}${reason}`;
        return li;
      }),
    );
  }

  /** @param {string} goodsCode @param {boolean} alertOnFirst */
  async function addTarget(goodsCode, alertOnFirst) {
    const r = await chrome.runtime.sendMessage({ type: "ADD_TARGET", goodsCode, alertOnFirst });
    $("result").textContent = r?.ok
      ? `${goodsCode} 감시 대상에 추가했습니다. 좌석 화면 응답이 다음에 갱신될 때(약 4초)부터 감시합니다${alertOnFirst ? ". 지금 비어 있는 좌석도 알립니다" : ""}`
      : `추가 실패: ${r?.error ?? "응답 없음"}`;
    await render();
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
