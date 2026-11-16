// @ts-check
// 옵션 페이지 (DESIGN 12.5). 폼 ↔ 값 변환은 form-model.js, 검증은 config-validate.js가 맡는다.
"use strict";

(function () {
  const { configValidate, formModel } = /** @type {any} */ (globalThis).NCA;
  const form = /** @type {HTMLFormElement} */ (document.getElementById("form"));
  const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));
  const warningsEl = /** @type {HTMLUListElement} */ (document.getElementById("warnings"));

  /** 마지막으로 저장된 설정. 폼에 없는 대상 공연(targets[1] 이후)을 보존하는 데 쓴다. */
  let saved = configValidate.defaultUserConfig();

  /** @param {string} name */
  const field = (name) => /** @type {HTMLInputElement} */ (form.elements.namedItem(name));

  /** @param {Record<string, string | boolean>} values */
  function writeForm(values) {
    for (const [name, value] of Object.entries(values)) {
      const el = field(name);
      if (!el) continue;
      if (typeof value === "boolean") el.checked = value;
      else el.value = value;
    }
  }

  /** @returns {any} */
  function readForm() {
    const empty = formModel.configToForm(configValidate.defaultUserConfig());
    /** @type {Record<string, string | boolean>} */
    const out = {};
    for (const [name, def] of Object.entries(empty)) {
      const el = field(name);
      out[name] = typeof def === "boolean" ? !!el?.checked : el?.value ?? "";
    }
    return out;
  }

  /** @param {string[]} warnings */
  function showWarnings(warnings) {
    warningsEl.replaceChildren(
      ...warnings.map((w) => {
        const li = document.createElement("li");
        li.textContent = w;
        return li;
      }),
    );
    warningsEl.hidden = warnings.length === 0;
  }

  /** @param {string} text @param {boolean} [sticky] */
  function setStatus(text, sticky = false) {
    statusEl.textContent = text;
    if (!sticky) setTimeout(() => { if (statusEl.textContent === text) statusEl.textContent = ""; }, 3000);
  }

  async function load() {
    const { userConfig } = await chrome.storage.local.get("userConfig");
    const { config, warnings } = configValidate.validateUserConfig(userConfig ?? configValidate.defaultUserConfig());
    saved = config;
    writeForm(formModel.configToForm(config));
    showWarnings(warnings);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { input, error } = formModel.formToConfig(readForm(), saved);
    if (error) {
      setStatus(error, true); // 입력은 그대로 두고 저장하지 않는다
      return;
    }
    const { config, warnings } = configValidate.validateUserConfig(input);
    await chrome.storage.local.set({ userConfig: config });
    saved = config;
    writeForm(formModel.configToForm(config)); // 고쳐진 값을 화면에 반영
    showWarnings(warnings);
    setStatus(warnings.length > 0 ? "저장됨 (일부 값을 고쳤습니다)" : "저장됨");
  });

  // ── 로그 내보내기 (DESIGN 16.1) ──
  const { format } = /** @type {any} */ (globalThis).NCA;
  const logStatusEl = /** @type {HTMLElement} */ (document.getElementById("logStatus"));

  /** @param {string} content @param {string} filename @param {string} mime */
  function download(content, filename, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /** @param {"csv"|"json"} kind */
  async function exportLog(kind) {
    logStatusEl.textContent = "불러오는 중…";
    try {
      const r = await chrome.runtime.sendMessage({ type: "LOG_LIST" });
      if (!r?.ok) throw new Error(r?.error ?? "응답 없음");
      const stamp = format.dayKey(Date.now());
      if (kind === "csv") {
        // 엑셀에서 한글이 깨지지 않도록 BOM을 붙인다
        download("\uFEFF" + format.logToCsv(r.entries), `nol-cancel-alert-log-${stamp}.csv`, "text/csv;charset=utf-8");
      } else {
        download(JSON.stringify(r.entries, null, 2), `nol-cancel-alert-log-${stamp}.json`, "application/json");
      }
      logStatusEl.textContent = `${r.entries.length}건 내보냄`;
    } catch (e) {
      logStatusEl.textContent = `내보내기 실패: ${/** @type {Error} */ (e).message}`;
    }
  }

  document.getElementById("exportCsv")?.addEventListener("click", () => exportLog("csv"));
  document.getElementById("exportJson")?.addEventListener("click", () => exportLog("json"));

  load().catch((err) => {
    setStatus("설정을 불러오지 못했습니다", true);
    console.error("[nca] options load 실패", err);
  });
})();
