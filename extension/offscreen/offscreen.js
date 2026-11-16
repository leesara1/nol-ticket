// @ts-check
// 신호음 재생 (DESIGN 3.2, 10.1). service worker는 오디오를 못 내므로 offscreen 문서에서 WebAudio로 만든다.
"use strict";

/** @type {Record<string, Array<[number, number]>>} 패턴별 [주파수 Hz, 길이 ms] */
const PATTERNS = {
  found: [[1200, 220], [1500, 220], [1800, 320]], // 높아지는 3음
  blind: [[600, 300], [450, 400]],                 // 낮은 2음
};

/** @type {AudioContext | null} */
let ctx = null;

/** @param {keyof typeof PATTERNS} name */
async function play(name) {
  const notes = PATTERNS[name];
  if (!notes) throw new Error(`unknown pattern: ${name}`);
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  let t = ctx.currentTime + 0.02;
  const gap = 0.08;
  for (const [freq, ms] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const dur = ms / 1000;
    // 딸깍 소리 없게 짧게 키우고 줄인다
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.35, t + 0.01);
    gain.gain.setValueAtTime(0.35, t + dur - 0.03);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
    t += dur + gap;
  }
  const totalMs = (t - ctx.currentTime) * 1000;
  await new Promise((r) => setTimeout(r, totalMs));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen" || msg.type !== "PLAY") return false;
  play(msg.pattern).then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
  );
  return true; // 비동기 응답
});
