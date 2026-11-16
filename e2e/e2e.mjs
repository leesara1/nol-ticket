// 확장 실제 로드 점검 (headless Chromium + CDP). 외부 패키지 없음, Node 24 내장 WebSocket 사용.
// NOL 사이트에는 접속하지 않고 확장 내부 페이지(팝업·옵션·SW)만 확인한다.
//
// 사용: node e2e/e2e.mjs [chrome 경로]
//   chrome 경로 생략 시: 환경변수 CHROME → ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 최신
//   결과(스크린샷·콘솔·results.json)는 OS 임시 폴더의 nca-e2e-out-* 에 남는다.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extPath = path.resolve(here, "../extension");

function findChrome() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), ".cache/ms-playwright");
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
  for (const d of dirs) {
    const p = path.join(base, d, "chrome-linux64/chrome");
    if (fs.existsSync(p)) return p;
  }
  console.error("Chromium을 찾지 못했습니다. 경로를 인자로 주거나 CHROME 환경변수를 설정하세요.");
  process.exit(2);
}
const chromePath = findChrome();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "nca-e2e-out-"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nca-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[e2e]", ...a);

const chrome = spawn(chromePath, [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-gpu",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0",
  `--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`,
  "--window-size=900,1000", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (d) => { stderr += d; });

let ws;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", name, detail); };

try {
  // DevToolsActivePort 대기
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else for (const fn of listeners) fn(m);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  // 콘솔·예외 수집
  const consoleLines = [];
  listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") consoleLines.push(`EXCEPTION ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === "Runtime.consoleAPICalled") consoleLines.push(`${m.params.type} ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  });

  const attach = async (targetId) => {
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    return sessionId;
  };
  const evalIn = async (sessionId, expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  // 확장 SW 찾기: Chrome for Testing 내장 확장에도 background.js가 있으므로 매니페스트 이름으로 고른다
  let sw, swS;
  for (let i = 0; i < 50 && !sw; i++) {
    const { targetInfos } = await send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.endsWith("/background.js"))) {
      const s = await attach(t.targetId);
      const name = await evalIn(s, "chrome.runtime.getManifest?.().name").catch(() => null);
      if (name === "NOL 취소표 알리미") { sw = t; swS = s; break; }
      await send("Target.detachFromTarget", { sessionId: s });
    }
    if (!sw) await sleep(200);
  }
  check("service worker 시작", !!sw, sw?.url ?? "SW 없음");
  if (!sw) throw new Error("SW 없음");
  const extId = new URL(sw.url).host;

  const waitFor = async (sessionId, expr, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await evalIn(sessionId, expr).catch(() => null);
      if (v) return v;
      await sleep(100);
    }
    return null;
  };
  const openPage = async (url) => {
    const { targetId } = await send("Target.createTarget", { url });
    const s = await attach(targetId);
    await send("Page.enable", {}, s);
    await waitFor(s, "document.readyState === 'complete'");
    return s;
  };
  const shot = async (sessionId, name, clip) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) }, sessionId);
    fs.writeFileSync(path.join(outDir, name), Buffer.from(data, "base64"));
  };

  const ns = await waitFor(swS, "typeof chrome?.storage?.local === 'object' && Object.keys(globalThis.NCA ?? {}).length >= 5 && Object.keys(globalThis.NCA).sort().join(',')", 10000);
  check("SW에서 공용 모듈 로드 (globalThis.NCA)", ns === "configValidate,detector,format,seatParse,types", ns);

  // onInstalled → 옵션 페이지 자동 열림
  await sleep(1500);
  const { targetInfos } = await send("Target.getTargets");
  const autoOptions = targetInfos.find((t) => t.url === `chrome-extension://${extId}/options/options.html`);
  check("설치 시 옵션 페이지 자동 열림", !!autoOptions);
  const cfg = await evalIn(swS, "chrome.storage.local.get('userConfig').then(r => r.userConfig)");
  check("설치 시 기본 설정 저장", !!cfg && Array.isArray(cfg.targets), JSON.stringify(cfg?.notify));

  // 팝업
  const pop = await openPage(`chrome-extension://${extId}/popup/popup.html`);
  await send("Emulation.setDeviceMetricsOverride", { width: 340, height: 420, deviceScaleFactor: 1, mobile: false }, pop);
  const tabsText = await waitFor(pop, "document.getElementById('tabs').textContent.includes('감시') && document.getElementById('tabs').textContent");
  check("팝업 상태 표시", !!tabsText, tabsText ?? "");
  await shot(pop, "popup-1.png");
  await evalIn(pop, "document.getElementById('test').click(), true");
  const resultText = await waitFor(pop, "(t => t && !t.includes('보내는 중') && t)(document.getElementById('result').textContent)", 8000);
  check("팝업 알림 테스트 응답", /크롬 알림: 보냄/.test(resultText ?? "") && /소리: 보냄/.test(resultText ?? ""), resultText ?? "응답 없음");
  await shot(pop, "popup-2.png");
  const notes = await evalIn(swS, "new Promise(r => chrome.notifications.getAll(r))");
  check("크롬 알림 생성됨", Object.keys(notes ?? {}).some((k) => k.startsWith("test:")), JSON.stringify(Object.keys(notes ?? {})));
  const offs = await evalIn(swS, "chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(c => c.map(x => x.documentUrl))");
  check("offscreen 문서 생성 (소리)", offs.length === 1, JSON.stringify(offs));

  // 옵션: 저장 + 잘못된 값 보정
  const opt = await openPage(`chrome-extension://${extId}/options/options.html`);
  await waitFor(opt, "document.querySelector('[name=adjacent]').value === '1'");
  await evalIn(opt, `(() => {
    const f = (n) => document.querySelector('[name=' + n + ']');
    f('goodsCode').value = '26015783';
    f('grades').value = 'R, VIP';
    f('adjacent').value = '2';
    f('regex').value = '[';
    document.querySelector('button[type=submit]').click();
    return true;
  })()`);
  const status = await waitFor(opt, "document.getElementById('status').textContent");
  const warns = await evalIn(opt, "[...document.querySelectorAll('#warnings li')].map(li => li.textContent)");
  check("옵션 저장 + 경고 표시", /저장됨/.test(status ?? "") && warns.some((w) => w.includes("regex")), `${status} | ${warns.join(" / ")}`);
  const saved = await evalIn(swS, "chrome.storage.local.get('userConfig').then(r => r.userConfig)");
  check("저장 값 검증 반영 (잘못된 정규식 제거, 연석 2)",
    saved.targets[0]?.filter.regex === null && saved.targets[0]?.filter.adjacent === 2 && !("refresh" in saved),
    JSON.stringify({ filter: saved.targets[0]?.filter }));
  // 상품코드 없이 조건만 → 저장 거부
  await evalIn(opt, `(() => { document.querySelector('[name=goodsCode]').value=''; document.querySelector('button[type=submit]').click(); return true; })()`);
  const status2 = await waitFor(opt, "(t => t.includes('상품코드') && t)(document.getElementById('status').textContent)");
  check("상품코드 없이 조건만 입력 시 저장 거부", !!status2, status2 ?? "");
  // 로그 내보내기 (가짜 로그 1건 넣고)
  await evalIn(swS, `chrome.storage.local.set({['log:2026-11-16']: [{t: Date.now(), kind: 'blind', goodsCode: '26015783', playSeq: '001', matched: false, seats: [], reason: 'expired'}]}).then(() => true)`);
  await evalIn(opt, "document.getElementById('exportCsv').click(), true");
  const logStatus = await waitFor(opt, "(t => t.includes('건') && t)(document.getElementById('logStatus').textContent)");
  check("로그 내보내기", logStatus === "1건 내보냄", logStatus ?? "");
  await send("Emulation.setDeviceMetricsOverride", { width: 760, height: 1700, deviceScaleFactor: 1, mobile: false }, opt);
  await sleep(200);
  await shot(opt, "options.png");

  const exc = consoleLines.filter((l) => l.startsWith("EXCEPTION"));
  check("예외 없음", exc.length === 0, exc.join(" | "));
  fs.writeFileSync(path.join(outDir, "console.txt"), consoleLines.join("\n"));
} catch (e) {
  check("실행", false, e.stack ?? String(e));
} finally {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  fs.rmSync(profile, { recursive: true, force: true });
  fs.writeFileSync(path.join(outDir, "chrome-stderr.txt"), stderr);
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  log(`결과: ${results.length - failed}/${results.length} 통과 (출력: ${outDir})`);
  process.exit(failed ? 1 : 0);
}
