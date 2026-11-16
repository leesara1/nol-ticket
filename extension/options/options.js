// @ts-check
// 옵션 페이지 (DESIGN 12.5). 폼 ↔ userConfig 변환, 저장 시 검증하고 경고를 보여준다.
"use strict";

(function () {
  const { configValidate } = /** @type {any} */ (globalThis).NCA;
  const form = /** @type {HTMLFormElement} */ (document.getElementById("form"));
  const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));
  const warningsEl = /** @type {HTMLUListElement} */ (document.getElementById("warnings"));

  /** @param {string} name */
  const field = (name) => /** @type {HTMLInputElement} */ (form.elements.namedItem(name));

  /** "a, b ,c" → ["a","b","c"] @param {string} s */
  const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

  /** 빈 문자열이면 null, 아니면 숫자 @param {string} s */
  const numOrNull = (s) => (s.trim() === "" ? null : Number(s));

  /** userConfig → 폼 @param {any} c */
  function fill(c) {
    const t = c.targets[0] ?? { goodsCode: "", playSeq: [], filter: {} };
    const f = t.filter ?? {};
    field("goodsCode").value = t.goodsCode ?? "";
    field("playSeq").value = (t.playSeq ?? []).join(", ");
    field("grades").value = (f.grades ?? []).join(", ");
    field("zones").value = (f.zones ?? []).join(", ");
    field("rowFrom").value = f.rowRange ? String(f.rowRange.from) : "";
    field("rowTo").value = f.rowRange ? String(f.rowRange.to) : "";
    field("rows").value = (f.rows ?? []).join(", ");
    field("adjacent").value = String(f.adjacent ?? 1);
    field("regex").value = f.regex ?? "";
    field("alertOnFirst").checked = !!f.alertOnFirst;

    field("refreshEnabled").checked = !!c.refresh.enabled;
    field("intervalSec").value = String(c.refresh.intervalSec);
    field("windows").value = c.refresh.windows.map((/** @type {any} */ w) => `${w.from}-${w.to}`).join("\n");

    field("sound").checked = !!c.notify.sound;
    field("desktop").checked = !!c.notify.desktop;
    field("telegramEnabled").checked = !!c.notify.telegram.enabled;
    field("telegramToken").value = c.notify.telegram.token ?? "";
    field("telegramChatId").value = c.notify.telegram.chatId ?? "";

    field("profileName").value = c.profile.name ?? "";
    field("profilePhone").value = c.profile.phone ?? "";
    field("profileEmail").value = c.profile.email ?? "";
  }

  /** 폼 → userConfig (검증 전 원본) */
  function read() {
    const goodsCode = field("goodsCode").value.trim();
    const rowFrom = numOrNull(field("rowFrom").value);
    const rowTo = numOrNull(field("rowTo").value);
    const rows = list(field("rows").value);
    const windows = field("windows").value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [from = "", to = ""] = line.split("-").map((x) => x.trim());
        return { from, to };
      });

    return {
      targets: goodsCode
        ? [{
            goodsCode,
            playSeq: list(field("playSeq").value),
            filter: {
              grades: list(field("grades").value),
              zones: list(field("zones").value),
              rowRange: rowFrom === null && rowTo === null ? null : { from: rowFrom, to: rowTo },
              rows: rows.length > 0 ? rows : null,
              adjacent: Number(field("adjacent").value),
              regex: field("regex").value.trim() || null,
              alertOnFirst: field("alertOnFirst").checked,
            },
          }]
        : [],
      refresh: {
        enabled: field("refreshEnabled").checked,
        intervalSec: Number(field("intervalSec").value),
        windows,
      },
      notify: {
        sound: field("sound").checked,
        desktop: field("desktop").checked,
        telegram: {
          enabled: field("telegramEnabled").checked,
          token: field("telegramToken").value.trim(),
          chatId: field("telegramChatId").value.trim(),
        },
      },
      profile: {
        name: field("profileName").value,
        phone: field("profilePhone").value,
        email: field("profileEmail").value,
      },
    };
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

  async function load() {
    const { userConfig } = await chrome.storage.local.get("userConfig");
    const { config, warnings } = configValidate.validateUserConfig(userConfig ?? configValidate.defaultUserConfig());
    fill(config);
    showWarnings(warnings);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { config, warnings } = configValidate.validateUserConfig(read());
    await chrome.storage.local.set({ userConfig: config });
    fill(config); // 고쳐진 값을 화면에 반영
    showWarnings(warnings);
    statusEl.textContent = warnings.length > 0 ? "저장됨 (일부 값을 고쳤습니다)" : "저장됨";
    setTimeout(() => (statusEl.textContent = ""), 3000);
  });

  load().catch((err) => {
    statusEl.textContent = "설정을 불러오지 못했습니다";
    console.error("[nca] options load 실패", err);
  });
})();
