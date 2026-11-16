// @ts-check
// 좌석·선택완료 버튼 강조 (DESIGN 11.1, 11.1.1). ISOLATED world content script.
// - 사이트 좌석 SVG와 같은 viewBox·위치의 겹침 SVG를 지도 안(확대 컨테이너 안)에 넣고 좌석 좌표에 깜빡이는 원을 그린다
//   → 사이트가 확대·이동하면 같이 움직인다. pointer-events: none이라 클릭은 사이트로 그대로 간다
// - 화면 위쪽에 고정 안내, '선택 완료' 버튼에 외곽선
// - 클릭 이벤트는 만들지 않는다 (좌석 클릭·선택완료는 사용자가 한다)
"use strict";

(function (root) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const OVERLAY_ID = "nca-overlay";
  const BANNER_ID = "nca-banner";
  const STYLE_ID = "nca-style";
  const CONFIRM_CLASS = "nca-confirm-highlight";

  /**
   * @typedef {{ key: string, x: number, y: number, best: boolean }} Target
   * @typedef {{ seatMapSelector: string, seatSvgSelector: string, confirmButtonSelector: string, confirmButtonText?: string }} AssistConfig
   */

  /** @param {AssistConfig} assist */
  function createHighlighter(assist) {
    /** @type {Map<string, Target>} */
    const targets = new Map();
    let bannerText = /** @type {string | null} */ (null);
    let bannerClosed = false;
    /** @type {MutationObserver | null} */
    let observer = null;
    let scheduled = false;

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = `
        #${BANNER_ID} { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
          max-width: min(720px, calc(100vw - 32px)); display: flex; align-items: center; gap: 12px;
          padding: 12px 16px; border-radius: 10px; background: #e11d48; color: #fff;
          font: 600 15px/1.4 system-ui, "Malgun Gothic", sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
        #${BANNER_ID}.nca-muted { background: #374151; }
        #${BANNER_ID} button { all: unset; white-space: nowrap; flex: none; cursor: pointer; padding: 4px 10px; border-radius: 6px; background: rgba(255,255,255,.2); font-weight: 600; }
        .${CONFIRM_CLASS} { outline: 4px solid #e11d48 !important; outline-offset: 3px !important; box-shadow: 0 0 0 8px rgba(225,29,72,.25) !important; }
      `;
      (document.head || document.documentElement).append(st);
    }

    /** 사이트 좌석 SVG의 viewBox·위치를 겹침 SVG에 복사 */
    function syncOverlay() {
      const map = document.querySelector(assist.seatMapSelector);
      const siteSvg = document.querySelector(assist.seatSvgSelector);
      let overlay = document.getElementById(OVERLAY_ID);
      if (!map || !siteSvg || targets.size === 0) {
        overlay?.remove();
        return;
      }
      if (!overlay || overlay.parentElement !== map) {
        overlay?.remove();
        overlay = /** @type {any} */ (document.createElementNS(SVG_NS, "svg"));
        overlay.id = OVERLAY_ID;
        map.append(overlay);
      }
      const ov = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (overlay));
      const vb = siteSvg.getAttribute("viewBox");
      if (vb) ov.setAttribute("viewBox", vb);
      ov.setAttribute("preserveAspectRatio", siteSvg.getAttribute("preserveAspectRatio") || "none");
      const ss = /** @type {SVGElement} */ (siteSvg).style;
      ov.setAttribute("style", `position:absolute;pointer-events:none;overflow:visible;z-index:10;` +
        `width:${ss.width};height:${ss.height};left:${ss.left};top:${ss.top};`);
      drawTargets(ov);
    }

    /** @param {SVGSVGElement} ov */
    function drawTargets(ov) {
      const want = new Set(targets.keys());
      for (const el of [...ov.querySelectorAll("[data-nca-key]")]) {
        if (!want.has(/** @type {string} */ (el.getAttribute("data-nca-key")))) el.remove();
      }
      for (const t of targets.values()) {
        if (ov.querySelector(`[data-nca-key="${CSS.escape(t.key)}"]`)) continue;
        const g = document.createElementNS(SVG_NS, "g");
        g.setAttribute("data-nca-key", t.key);
        const color = t.best ? "#e11d48" : "#f59e0b";
        const r = t.best ? 22 : 13;
        // 바깥 링: 커졌다 작아지며 깜빡임 (SVG 애니메이션)
        const ring = document.createElementNS(SVG_NS, "circle");
        ring.setAttribute("cx", String(t.x));
        ring.setAttribute("cy", String(t.y));
        ring.setAttribute("r", String(r));
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", color);
        ring.setAttribute("stroke-width", t.best ? "4" : "3");
        const anim = document.createElementNS(SVG_NS, "animate");
        anim.setAttribute("attributeName", "r");
        anim.setAttribute("values", `${r};${r * 1.8};${r}`);
        anim.setAttribute("dur", "1s");
        anim.setAttribute("repeatCount", "indefinite");
        ring.append(anim);
        // 가운데 점
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(t.x));
        dot.setAttribute("cy", String(t.y));
        dot.setAttribute("r", String(t.best ? 7 : 5));
        dot.setAttribute("fill", color);
        g.append(ring, dot);
        ov.append(g);
      }
    }

    function syncConfirm() {
      const text = assist.confirmButtonText ?? "";
      for (const b of document.querySelectorAll(assist.confirmButtonSelector)) {
        const on = targets.size > 0 && (!text || (b.textContent ?? "").includes(text));
        b.classList.toggle(CONFIRM_CLASS, on);
      }
    }

    function syncBanner() {
      let el = document.getElementById(BANNER_ID);
      if (!bannerText || bannerClosed) {
        el?.remove();
        return;
      }
      if (!el) {
        el = document.createElement("div");
        el.id = BANNER_ID;
        el.setAttribute("role", "status");
        const span = document.createElement("span");
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "닫기";
        close.addEventListener("click", () => { bannerClosed = true; syncBanner(); });
        el.append(span, close);
        (document.body || document.documentElement).append(el);
      }
      /** @type {HTMLElement} */ (el.firstChild).textContent = bannerText;
      el.classList.toggle("nca-muted", targets.size === 0);
    }

    function render() {
      scheduled = false;
      ensureStyle();
      syncOverlay();
      syncConfirm();
      syncBanner();
    }

    /** 사이트가 지도를 다시 그리면(확대 시 좌석 SVG 교체 등) 다시 맞춘다 */
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(render);
    }

    function observe() {
      if (observer || !document.body) return;
      observer = new MutationObserver((records) => {
        // 우리 요소 변화로 다시 그리는 무한 반복을 막는다
        if (records.every((r) => /** @type {Element} */ (r.target).closest?.(`#${OVERLAY_ID}, #${BANNER_ID}`))) return;
        if (targets.size > 0 || document.getElementById(OVERLAY_ID)) schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["viewBox", "style", "disabled"] });
    }

    /**
     * SW가 보낸 강조 계획 적용.
     * @param {{ add?: Target[], remove?: string[], banner?: string | null }} plan
     */
    function apply(plan) {
      for (const k of plan.remove ?? []) targets.delete(k);
      for (const t of plan.add ?? []) {
        if (typeof t?.key !== "string" || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
        targets.set(t.key, { key: t.key, x: t.x, y: t.y, best: !!t.best });
      }
      // 새 1순위가 오면 이전 1순위 표시는 일반으로
      if ((plan.add ?? []).some((t) => t.best)) {
        const bestKeys = new Set((plan.add ?? []).filter((t) => t.best).map((t) => t.key));
        for (const t of targets.values()) t.best = bestKeys.has(t.key);
        document.getElementById(OVERLAY_ID)?.replaceChildren();
      }
      if (plan.banner) {
        bannerText = plan.banner;
        bannerClosed = false;
      } else if (targets.size === 0 && bannerText) {
        bannerText = "표시했던 좌석이 다시 팔렸습니다. 계속 감시 중입니다";
      }
      observe();
      render();
    }

    function clear() {
      targets.clear();
      bannerText = null;
      render();
    }

    return { apply, clear, size: () => targets.size };
  }

  (root.NCA ??= {}).createHighlighter = createHighlighter;
})(globalThis);
