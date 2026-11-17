// @ts-check
// 좌석 화면 content script (ISOLATED world, DESIGN 3, 7.1, 8).
// net-tap(MAIN)이 넘긴 좌석 응답을 seat-parse 누적기로 해석해 SW에 스냅샷으로 보낸다.
// 세션 만료 확인 응답(ExpiredSession)이 true면 SW에 감시 불능(expired)을 알린다.
"use strict";

(function () {
  const NCA = /** @type {any} */ (globalThis).NCA;
  if (!NCA?.seatParse || !NCA?.pageSignals) return;
  if (/** @type {any} */ (window).__ncaContent) return;
  /** @type {any} */ (window).__ncaContent = true;

  const ORIGIN = location.origin;
  const acc = NCA.seatParse.createAccumulator();

  /** @type {{ meta: RegExp, status: RegExp, patterns: string[], gql: RegExp | null, gqlPattern: string | null, expiredOp: string | null } | null} */
  let cfg = null;
  /** 좌석 화면 주소 패턴 (CONFIG로 받음). 이 주소가 아니면 좌석 응답을 무시한다 */
  /** @type {RegExp | null} */
  let seatPageRe = null;
  /** 진단 (팝업 표시용): 연결·설정·받은 응답 수·마지막 오류 */
  const diag = { config: false, net: 0, meta: 0, status: 0, offSeat: 0, lastError: "" };
  let diagSent = "";
  function sendDiag() {
    const d = JSON.stringify(diag);
    if (d === diagSent) return;
    diagSent = d;
    send({ type: "DIAG", diag: { ...diag, url: location.pathname } });
  }
  setInterval(sendDiag, 5000);
  /** 마지막으로 본 좌석 응답의 공연·회차 (GraphQL 응답에는 없으므로) */
  let last = { goodsCode: "", playSeq: "" };

  // ── SW 포트: SW가 재시작되면 끊기므로 보낼 때 다시 연결한다 (DESIGN 3.3) ──
  // 사이트 설정도 이 포트로 받는다. content script는 확장 파일을 fetch로 읽을 수 없고
  // (web_accessible_resources로 공개하면 사이트가 확장을 알아챌 수 있어 쓰지 않음), SW는 읽을 수 있다.
  /** @type {chrome.runtime.Port | null} */
  let port = null;
  /** 좌석 강조 (content/highlight.js, 7단계) */
  /** @type {any} */
  let highlighter = null;

  function connect() {
    port = chrome.runtime.connect({ name: "nca-content" });
    port.onDisconnect.addListener(() => { port = null; });
    port.onMessage.addListener((msg) => {
      if (msg?.type === "CONFIG") {
        applyConfig(msg.net, msg.pageState);
        if (typeof msg.seatPageUrlPattern === "string") watchLocation(msg.seatPageUrlPattern);
        if (msg.assist && typeof NCA.createHighlighter === "function" && !highlighter) {
          highlighter = NCA.createHighlighter(msg.assist);
        }
      } else if (msg?.type === "HIGHLIGHT") {
        highlighter?.apply(msg);
      }
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
    if (!cfg) return;
    window.postMessage({
      type: "NCA_CONFIG",
      urlPatterns: cfg.patterns,
      gqlPattern: cfg.gqlPattern,
      gqlOps: cfg.expiredOp ? [cfg.expiredOp] : [],
    }, ORIGIN);
  }

  /** @param {any} net @param {any} pageState */
  function applyConfig(net, pageState) {
    const metaP = net?.metaUrlPattern;
    const statusP = net?.statusUrlPattern;
    if (typeof metaP !== "string" || typeof statusP !== "string") return;
    const gqlP = typeof pageState?.gqlUrlPattern === "string" ? pageState.gqlUrlPattern : null;
    const expiredOp = typeof pageState?.expiredOperation === "string" ? pageState.expiredOperation : null;
    try {
      cfg = {
        meta: new RegExp(metaP), status: new RegExp(statusP), patterns: [metaP, statusP],
        gql: gqlP ? new RegExp(gqlP) : null, gqlPattern: gqlP, expiredOp,
      };
    } catch {
      return;
    }
    diag.config = true;
    postConfig();
    sendDiag();
  }

  /** @param {any} d */
  function validNet(d) {
    return d && d.type === "NCA_NET" && typeof d.url === "string" && typeof d.body === "string" && typeof d.status === "number";
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const d = event.data;
    if (d?.type === "NCA_TAP_READY") { postConfig(); return; }
    if (!cfg || !validNet(d)) return;
    diag.net++;
    if (d.status !== 200) { diag.lastError = `HTTP ${d.status}`; return; }

    // 세션 만료 확인 응답 (입장 때마다 false로 오고, 만료면 true)
    if (cfg.gql && cfg.gql.test(d.url)) {
      if (cfg.expiredOp && d.op === cfg.expiredOp && NCA.pageSignals.parseExpired(d.body) === true) {
        send({ type: "BLIND", reason: "expired", ...last });
      }
      return;
    }

    // 좌석 화면을 벗어난 뒤(결제 단계 등)에 오는 좌석 응답은 감시에 쓰지 않는다
    if (seatPageRe && !seatPageRe.test(location.href)) { diag.offSeat++; return; }

    if (cfg.meta.test(d.url)) {
      diag.meta++;
      const r = acc.addMeta(d.url, d.body);
      if ("error" in r) diag.lastError = `${r.error}: ${r.detail}`;
      if ("error" in r) send({ type: "BLIND", reason: r.error, detail: r.detail, ...ids(d.url) });
      return;
    }
    if (cfg.status.test(d.url)) {
      diag.status++;
      const r = acc.addStatus(d.url, d.body);
      if ("error" in r) {
        diag.lastError = `${r.error}: ${r.detail}`;
        send({ type: "BLIND", reason: r.error, detail: r.detail, ...ids(d.url) });
        return;
      }
      if (acc.blockCount() === 0) return; // 배치가 아직 없어 해석한 구역이 없음
      last = { goodsCode: r.goodsCode, playSeq: r.snapshot.playSeq };
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

  // ── 좌석 화면을 떠났는지: 예매 단계는 한 페이지 안에서 주소만 바뀌는 방식일 수 있어 주소를 본다 (DESIGN 5.3) ──
  /** @type {ReturnType<typeof setInterval> | null} */
  let locTimer = null;
  /** @param {string} pattern */
  function watchLocation(pattern) {
    if (locTimer) return;
    /** @type {RegExp} */
    let re;
    try { re = new RegExp(pattern); } catch { return; }
    seatPageRe = re;
    let onSeat = re.test(location.href);
    locTimer = setInterval(() => {
      const now = re.test(location.href);
      if (onSeat && !now) {
        send({ type: "LEAVE" });
        highlighter?.clear();
      }
      onSeat = now;
    }, 2000);
  }

  // 연결하면 SW가 바로 CONFIG를 보낸다.
  // SW가 막 시작되는 중이면 CONFIG를 못 받을 수 있으므로, 3초마다 최대 5번 다시 연결해 다시 받는다
  try { connect(); } catch (e) { console.error("[nca] 확장과 연결하지 못했습니다", e); }
  let configRetries = 0;
  const configTimer = setInterval(() => {
    if (cfg || ++configRetries > 5) { clearInterval(configTimer); return; }
    try { port?.disconnect(); } catch { /* 무시 */ }
    port = null;
    try { connect(); } catch { /* 다음 시도 */ }
  }, 3000);
})();
