// 좌석 감지 전체 경로 점검 (headless Chromium + 로컬 가짜 좌석 화면).
// 실제 사이트에는 접속하지 않는다: 크롬의 --host-resolver-rules로 tickets.interpark.com을 로컬 HTTPS 서버에 연결한다.
//
// 흐름: 가짜 좌석 화면이 seatMeta를 받고 seatStatus를 0.5초마다 받는다 (실제는 약 3.8초)
//   → 확장(net-tap → content → SW)이 해석 → 매진 상태에서 좌석 두 개를 풀면 "취소표 생김" 크롬 알림이 생겨야 한다
//
// 사용: node e2e/seat-e2e.mjs [chrome 경로]   (openssl 필요: 임시 인증서 생성)
import { spawn, execFileSync } from "node:child_process";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extPath = path.join(root, "extension");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "fixtures/seat-soldout.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[seat-e2e]", ...a);

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

// ── 가짜 좌석 화면 서버 ──────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nca-seat-e2e-"));
const keyFile = path.join(tmp, "key.pem");
const certFile = path.join(tmp, "cert.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-keyout", keyFile, "-out", certFile, "-subj", "/CN=tickets.interpark.com",
  "-addext", "subjectAltName=DNS:tickets.interpark.com",
], { stdio: "ignore" });

const metaPath = new URL(fixture.meta[0].url);
const statusPath = new URL(fixture.status[0].url);
const seats = fixture.meta[0].body.data[0].seats;
let statusBody = structuredClone(fixture.status[0].body);
let statusHits = 0;
let expired = false;   // ExpiredSession 응답 값
const gqlOps = [];     // 받은 GraphQL operation 기록

/** 첫 구역 i번째 좌석 비트를 1로 (상위 비트부터) */
function release(seatInfoIdSuffix) {
  const i = seats.findIndex((s) => s.seatInfoId.endsWith(`:${seatInfoIdSuffix}`));
  const chars = statusBody.data[0].split("");
  const c = Math.floor(i / 4);
  chars[c] = (parseInt(chars[c], 16) | (8 >> (i % 4))).toString(16);
  statusBody.data[0] = chars.join("");
}

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>가짜 좌석 화면</title></head>
<body><h1>e2e 가짜 좌석 화면</h1><button>선택 완료</button>
<script>
  function xhr(url) {
    return new Promise((ok) => { const x = new XMLHttpRequest(); x.open("GET", url); x.onload = () => ok(x.responseText); x.send(); });
  }
  function gql(operationName) {
    return fetch("/onestop/gql", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationName, query: "query { x }", variables: {} }) }).then((r) => r.text());
  }
  // 실제 화면처럼: 입장 때 세션 만료 확인 질의(false), 보안문자 확인 등 다른 GraphQL도 호출
  window.__checkExpired = () => gql("ExpiredSession");
  (async () => {
    await gql("VerifyCaptcha");
    await gql("ExpiredSession");
    await xhr(${JSON.stringify(metaPath.pathname + metaPath.search)});
    setInterval(() => xhr(${JSON.stringify(statusPath.pathname + statusPath.search)}), 500);
  })();
</script></body></html>`;

const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
  const u = new URL(req.url, "https://tickets.interpark.com");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/onestop/seat") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
  if (u.pathname === "/onestop/api/seatMeta") { json(fixture.meta[0].body); return; }
  if (u.pathname === "/onestop/api/seatStatus") { statusHits++; json(statusBody); return; }
  if (u.pathname === "/onestop/gql" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const op = (() => { try { return JSON.parse(raw).operationName; } catch { return null; } })();
      gqlOps.push(op);
      if (op === "ExpiredSession") json({ data: { isExpiredSession: expired } });
      else json({ data: { verifyCaptcha: true } });
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = /** @type {any} */ (server.address()).port;

// ── 크롬 ────────────────────────────────────────────────

const profile = path.join(tmp, "profile");
const chrome = spawn(findChrome(), [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-gpu",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0",
  `--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`,
  `--host-resolver-rules=MAP tickets.interpark.com 127.0.0.1:${port}`, "--ignore-certificate-errors",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
chrome.stderr.on("data", (d) => { stderr += d; });

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", name, detail); };
let ws;

try {
  const pf = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(pf); i++) await sleep(100);
  const [dport, wsPath] = fs.readFileSync(pf, "utf8").trim().split("\n");
  ws = new WebSocket(`ws://127.0.0.1:${dport}${wsPath}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 1;
  const pending = new Map();
  const pageConsole = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled") pageConsole.push(`${m.params.type} ${m.params.args.map((x) => x.value ?? x.description).join(" ")}`);
    if (m.method === "Runtime.exceptionThrown") pageConsole.push(`EXCEPTION ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === "Log.entryAdded") pageConsole.push(`LOG ${m.params.entry.level} ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = id++; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const attach = async (targetId) => {
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    return sessionId;
  };
  const evalIn = async (s, expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (s, expr, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await evalIn(s, expr).catch(() => null);
      if (v) return v;
      await sleep(150);
    }
    return null;
  };

  // 우리 확장의 SW (내장 확장과 구분: 매니페스트 이름)
  let swS = null;
  for (let i = 0; i < 50 && !swS; i++) {
    const { targetInfos } = await send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.endsWith("/background.js"))) {
      const s = await attach(t.targetId);
      if ((await evalIn(s, "chrome.runtime.getManifest?.().name").catch(() => null)) === "NOL 취소표 알리미") { swS = s; break; }
      await send("Target.detachFromTarget", { sessionId: s });
    }
    if (!swS) await sleep(200);
  }
  check("확장 SW 시작", !!swS);
  if (!swS) throw new Error("SW 없음");
  await waitFor(swS, "!!globalThis.NCA?.seatParse");

  // 대상 공연 설정: 성시경 26015783, VIP, 2연석 (소리는 끄고 크롬 알림만)
  await evalIn(swS, `chrome.storage.local.set({ userConfig: {
    targets: [{ goodsCode: "26015783", playSeq: [], filter: { grades: ["VIP"], adjacent: 2 } }],
    notify: { sound: false, desktop: true, telegram: { enabled: false, token: "", chatId: "" } },
    profile: { name: "", phone: "", email: "" } } }).then(() => true)`);

  // 가짜 좌석 화면 열기
  const { targetId } = await send("Target.createTarget", { url: "https://tickets.interpark.com/onestop/seat" });
  const page = await attach(targetId);
  await send("Log.enable", {}, page).catch(() => {});
  const tapped = await waitFor(page, "document.readyState === 'complete' && document.title");
  check("가짜 좌석 화면 열림 (host-resolver-rules)", tapped === "가짜 좌석 화면", String(tapped));
  const tapInstalled = await evalIn(page, "!!window.__ncaNetTap");
  check("net-tap 주입됨 (MAIN world)", tapInstalled === true, String(tapInstalled));

  // 매진 상태가 몇 번 지나가게 둔다 → 감시 중
  await sleep(2500);
  const watching = await evalIn(swS, "chrome.storage.session.get(null).then(d => Object.entries(d).filter(([k]) => k.startsWith('tab:')).map(([, v]) => v.watch))");
  check("매진 상태에서 감시 중 (알림 없음)", watching.includes("WATCHING"), JSON.stringify(watching));
  const before = await evalIn(swS, "new Promise(r => chrome.notifications.getAll(r)).then(n => Object.keys(n))");
  check("매진 상태에서는 알림 없음", before.length === 0, JSON.stringify(before));

  const notes = () => evalIn(swS, "new Promise(r => chrome.notifications.getAll(r)).then(n => Object.keys(n))");
  const tabWatch = () => evalIn(swS, "chrome.storage.session.get(null).then(d => Object.entries(d).filter(([k]) => k.startsWith('tab:')).map(([, v]) => v.watch + (v.blindReason ? ':' + v.blindReason : '')))");
  check("입장 때 ExpiredSession=false는 감시 불능 아님", !(await notes()).some((k) => k.startsWith("blind:")), JSON.stringify(gqlOps));

  // 세션 만료: 응답 값이 true면 감시 불능 알림
  expired = true;
  await evalIn(page, "window.__checkExpired().then(() => true)");
  const blindId = await waitFor(swS, "new Promise(r => chrome.notifications.getAll(r)).then(n => Object.keys(n).find(k => k.startsWith('blind:')))", 5000);
  const blindMsg = blindId ? await evalIn(swS, `new Promise(r => chrome.notifications.getAll(r)).then(() => true)`) : null;
  check("세션 만료(true) → 감시 불능 알림", !!blindId && blindMsg === true, String(blindId));
  check("탭 상태 BLIND:expired", (await tabWatch()).includes("BLIND:expired"), JSON.stringify(await tabWatch()));

  // 정상 스냅샷이 다시 오면 복구
  expired = false;
  const recovered = await waitFor(swS, "new Promise(r => chrome.notifications.getAll(r)).then(n => Object.keys(n).find(k => k.startsWith('recovered:')))", 5000);
  check("정상 응답이 다시 오면 감시 복구 알림", !!recovered, String(recovered));

  // 취소표: FLOOR A구역 10열 10·11번
  release(66233);
  release(66234);
  const found = await waitFor(swS, "new Promise(r => chrome.notifications.getAll(r)).then(n => Object.keys(n).find(k => k.startsWith('found:')))", 8000);
  check("취소표 생김 → 크롬 알림 생성", !!found, String(found));
  const state = await evalIn(swS, "chrome.storage.session.get(null).then(d => Object.entries(d).filter(([k]) => k.startsWith('tab:')).map(([, v]) => v.watch))");
  check("탭 상태 FOUND", state.includes("FOUND"), JSON.stringify(state));
  const logs = await evalIn(swS, "chrome.storage.local.get(null).then(d => Object.entries(d).filter(([k]) => k.startsWith('log:')).flatMap(([, v]) => v))");
  const hit = logs.find((e) => e.kind === "appeared" && e.matched);
  check("이벤트 로그 기록", !!hit && hit.seats.map((s) => s.col).join(",") === "10,11", JSON.stringify(hit?.seats));
  check("좌석 상태를 반복해서 받음 (페이지 갱신 흉내)", statusHits >= 5, `seatStatus ${statusHits}회`);

  // 결제 단계로 주소만 바뀜 (한 페이지 안 이동) → 조용히 IDLE
  const notesBefore = (await notes()).length;
  await evalIn(page, "history.pushState({}, '', '/onestop/price'), true");
  const idle = await waitFor(swS, "chrome.storage.session.get(null).then(d => Object.entries(d).filter(([k]) => k.startsWith('tab:')).some(([, v]) => v.watch === 'IDLE'))", 6000);
  check("좌석 화면을 벗어나면(LEAVE) IDLE, 알림 없음", idle === true && (await notes()).length === notesBefore, JSON.stringify(await tabWatch()));
  if (results.some((r) => !r.ok)) log("페이지 콘솔:\n  " + pageConsole.slice(-15).join("\n  "));
} catch (e) {
  check("실행", false, e.stack ?? String(e));
} finally {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  log(`결과: ${results.length - failed}/${results.length} 통과`);
  if (failed) fs.writeFileSync(path.join(os.tmpdir(), "nca-seat-e2e-stderr.txt"), stderr);
  process.exit(failed ? 1 : 0);
}
