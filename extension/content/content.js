// @ts-check
// 좌석 화면 content script (ISOLATED world, DESIGN 3, 7.1).
// net-tap(MAIN)이 넘긴 좌석 응답을 seat-parse 누적기로 해석해 SW에 스냅샷으로 보낸다.
"use strict";

(function () {
  const NCA = /** @type {any} */ (globalThis).NCA;
  if (!NCA?.seatParse) return;
  if (/** @type {any} */ (window).__ncaContent) return;
  /** @type {any} */ (window).__ncaContent = true;

  const ORIGIN = location.origin;
  const acc = NCA.seatParse.createAccumulator();

  /** @type {{ meta: RegExp, status: RegExp, patterns: string[] } | null} */
  let cfg = null;

  // ── SW 포트: SW가 재시작되면 끊기므로 보낼 때 다시 연결한다 (DESIGN 3.3) ──
  // 사이트 설정도 이 포트로 받는다. content script는 확장 파일을 fetch로 읽을 수 없고
  // (web_accessible_resources로 공개하면 사이트가 확장을 알아챌 수 있어 쓰지 않음), SW는 읽을 수 있다.
  /** @type {chrome.runtime.Port | null} */
  let port = null;

  function connect() {
    port = chrome.runtime.connect({ name: "nca-content" });
    port.onDisconnect.addListener(() => { port = null; });
    port.onMessage.addListener((msg) => {
      if (msg?.type === "CONFIG") applyConfig(msg.net);
    });
    return port;
  }

  /** @param {any} msg */
  function send(msg) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        (port ?? connect()).postMessage(msg);
        return;
      } catch {
        port = null; // 끊긴 포트: 한 번 다시 연결
      }
    }
  }

  function postConfig() {
    if (cfg) window.postMessage({ type: "NCA_CONFIG", urlPatterns: cfg.patterns }, ORIGIN);
  }

  /** @param {any} net */
  function applyConfig(net) {
    const metaP = net?.metaUrlPattern;
    const statusP = net?.statusUrlPattern;
    if (typeof metaP !== "string" || typeof statusP !== "string") return;
    try {
      cfg = { meta: new RegExp(metaP), status: new RegExp(statusP), patterns: [metaP, statusP] };
    } catch {
      return;
    }
    postConfig();
  }

  /** @param {any} d */
  function validNet(d) {
    return d && d.type === "NCA_NET" && typeof d.url === "string" && typeof d.body === "string" && typeof d.status === "number";
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const d = event.data;
    if (d?.type === "NCA_TAP_READY") { postConfig(); return; }
    if (!cfg || !validNet(d) || d.status !== 200) return;

    if (cfg.meta.test(d.url)) {
      const r = acc.addMeta(d.url, d.body);
      if ("error" in r) send({ type: "BLIND", reason: r.error, detail: r.detail, ...ids(d.url) });
      return;
    }
    if (cfg.status.test(d.url)) {
      const r = acc.addStatus(d.url, d.body);
      if ("error" in r) {
        send({ type: "BLIND", reason: r.error, detail: r.detail, ...ids(d.url) });
        return;
      }
      if (acc.blockCount() === 0) return; // 배치가 아직 없어 해석한 구역이 없음
      send({ type: "SNAPSHOT", goodsCode: r.goodsCode, snapshot: r.snapshot, newBlocks: r.newBlocks });
    }
  });

  /** @param {string} url */
  function ids(url) {
    try {
      const q = NCA.seatParse.parseQuery(url);
      return { goodsCode: q.goodsCode, playSeq: q.playSeq };
    } catch {
      return {};
    }
  }

  // 연결하면 SW가 바로 CONFIG를 보낸다
  try { connect(); } catch (e) { console.error("[nca] 확장과 연결하지 못했습니다", e); }
})();
