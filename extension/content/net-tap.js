// 페이지 컨텍스트(MAIN world)에서 좌석 응답을 읽기만 한다 (DESIGN 3.1).
// - fetch / XMLHttpRequest를 감싸 응답 본문을 복사해 content script(ISOLATED)로 넘긴다
// - 요청을 바꾸거나 다시 보내지 않는다. 사이트에 추가 요청을 만들지 않는다
// - URL 패턴은 content script가 NCA_CONFIG로 알려준다. 받기 전 응답은 제한된 버퍼에 보관한다
// - chrome.* API가 없는 세계이므로 다른 파일을 불러오지 않는다
(function () {
  "use strict";
  if (window.__ncaNetTap) return;
  Object.defineProperty(window, "__ncaNetTap", { value: true });

  const ORIGIN = location.origin;
  const BUFFER_MAX = 60;        // 좌석 배치 응답이 한 번에 15개 안팎 오므로 넉넉히
  const BUFFER_MS = 15000;      // 페이지 로드 후 이 시간까지만 보관
  const BODY_MAX = 2 * 1024 * 1024;
  const started = Date.now();

  /** @type {RegExp[] | null} */
  let patterns = null;
  /** @type {Array<{url: string, status: number, body: string}>} */
  let buffer = [];

  /** @param {string} url */
  const wanted = (url) => patterns !== null && patterns.some((re) => re.test(url));
  /** 패턴을 모를 때는 JSON처럼 보이는 같은 출처 응답만 잠시 보관 */
  /** @param {string} url @param {string} contentType */
  const maybeWanted = (url, contentType) =>
    patterns === null && Date.now() - started < BUFFER_MS && /json/i.test(contentType) && url.startsWith(ORIGIN);

  /** @param {string} url @param {number} status @param {string} body */
  function emit(url, status, body) {
    if (typeof body !== "string" || body.length > BODY_MAX) return;
    if (patterns === null) {
      if (buffer.length < BUFFER_MAX) buffer.push({ url, status, body });
      return;
    }
    window.postMessage({ type: "NCA_NET", url, status, body }, ORIGIN);
  }

  // ── fetch ──
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = res.url || (args[0] instanceof Request ? args[0].url : String(args[0]));
      const ct = res.headers.get("content-type") || "";
      // 패턴이 맞을 때만 복제한다 (스트리밍 응답을 불필요하게 붙잡지 않게)
      if (wanted(url) || maybeWanted(url, ct)) {
        res.clone().text().then((body) => emit(url, res.status, body), () => {});
      }
    } catch {
      // 읽기 실패는 페이지 동작에 영향을 주지 않는다
    }
    return res;
  };

  // ── XMLHttpRequest ──
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (method, url, ...rest) {
    try { this.__ncaUrl = new URL(String(url), location.href).href; } catch { this.__ncaUrl = ""; }
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function (...args) {
    const xhr = this;
    xhr.addEventListener("load", () => {
      try {
        const url = xhr.responseURL || xhr.__ncaUrl || "";
        const ct = xhr.getResponseHeader("content-type") || "";
        if (!(wanted(url) || maybeWanted(url, ct))) return;
        let body = "";
        if (xhr.responseType === "" || xhr.responseType === "text") body = xhr.responseText;
        else if (xhr.responseType === "json") body = JSON.stringify(xhr.response);
        else return;
        emit(url, xhr.status, body);
      } catch {
        // 무시
      }
    });
    return origSend.apply(this, args);
  };

  // ── content script와 연락 ──
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const d = event.data;
    if (!d || d.type !== "NCA_CONFIG" || !Array.isArray(d.urlPatterns)) return;
    try {
      patterns = d.urlPatterns.filter((p) => typeof p === "string").map((p) => new RegExp(p));
    } catch {
      return;
    }
    const pending = buffer;
    buffer = [];
    for (const item of pending) {
      if (wanted(item.url)) window.postMessage({ type: "NCA_NET", ...item }, ORIGIN);
    }
  });

  // content script가 먼저 설정을 보냈다가 못 받았을 수 있으니 준비됐다고 알린다
  window.postMessage({ type: "NCA_TAP_READY" }, ORIGIN);
})();
