// @ts-check
// 옵션 폼 값 ↔ userConfig 변환 (DESIGN 12.5). DOM 없이 순수 함수로 두어 Node에서 왕복 테스트한다.
// DESIGN 2.1 형식: 브라우저에서는 globalThis.NCA.formModel.

/**
 * 폼 필드 값. 텍스트 입력은 문자열, 체크박스는 boolean.
 * @typedef {Object} FormValues
 * @property {string} goodsCode
 * @property {string} playSeq
 * @property {string} grades
 * @property {string} zones
 * @property {string} rowFrom
 * @property {string} rowTo
 * @property {string} rows
 * @property {string} adjacent
 * @property {string} regex
 * @property {boolean} alertOnFirst
 * @property {boolean} refreshEnabled
 * @property {string} intervalSec
 * @property {string} windows
 * @property {boolean} sound
 * @property {boolean} desktop
 * @property {boolean} telegramEnabled
 * @property {string} telegramToken
 * @property {string} telegramChatId
 * @property {string} profileName
 * @property {string} profilePhone
 * @property {string} profileEmail
 */

(function (root) {
  "use strict";

  /** "a, b ,c" → ["a","b","c"] @param {string} s */
  const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

  /** @param {string} s */
  const numOrNull = (s) => (s.trim() === "" ? null : Number(s));

  /**
   * userConfig(검증된 값) → 폼 값. 폼은 첫 번째 대상 공연만 편집한다.
   * @param {any} c
   * @returns {FormValues}
   */
  function configToForm(c) {
    const t = c.targets[0] ?? { goodsCode: "", playSeq: [], filter: {} };
    const f = t.filter ?? {};
    return {
      goodsCode: t.goodsCode ?? "",
      playSeq: (t.playSeq ?? []).join(", "),
      grades: (f.grades ?? []).join(", "),
      zones: (f.zones ?? []).join(", "),
      rowFrom: f.rowRange ? String(f.rowRange.from) : "",
      rowTo: f.rowRange ? String(f.rowRange.to) : "",
      rows: (f.rows ?? []).join(", "),
      adjacent: String(f.adjacent ?? 1),
      regex: f.regex ?? "",
      alertOnFirst: !!f.alertOnFirst,
      refreshEnabled: !!c.refresh.enabled,
      intervalSec: String(c.refresh.intervalSec),
      windows: c.refresh.windows.map((/** @type {any} */ w) => `${w.from}-${w.to}`).join("\n"),
      sound: !!c.notify.sound,
      desktop: !!c.notify.desktop,
      telegramEnabled: !!c.notify.telegram.enabled,
      telegramToken: c.notify.telegram.token ?? "",
      telegramChatId: c.notify.telegram.chatId ?? "",
      profileName: c.profile.name ?? "",
      profilePhone: c.profile.phone ?? "",
      profileEmail: c.profile.email ?? "",
    };
  }

  /**
   * 폼 값 → userConfig 원본(검증 전).
   * 저장하면 입력이 사라지는 경우는 저장하지 않고 error를 돌려준다.
   *
   * @param {FormValues} v
   * @param {any} prevConfig  저장돼 있던 설정. 폼에 없는 대상 공연(targets[1] 이후)을 보존한다.
   * @returns {{ input: any, error: null } | { input: null, error: string }}
   */
  function formToConfig(v, prevConfig) {
    const goodsCode = v.goodsCode.trim();
    const filterTouched = [v.playSeq, v.grades, v.zones, v.rowFrom, v.rowTo, v.rows, v.regex].some(
      (x) => x.trim() !== "",
    );
    if (!goodsCode && filterTouched) {
      return { input: null, error: "상품코드를 입력해야 대상 공연 조건이 저장됩니다." };
    }

    const rowFrom = numOrNull(v.rowFrom);
    const rowTo = numOrNull(v.rowTo);
    if ((rowFrom === null) !== (rowTo === null)) {
      return { input: null, error: "열 범위는 시작과 끝을 모두 입력하거나 모두 비워 주세요." };
    }

    const rows = list(v.rows);
    const windows = v.windows
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [from = "", to = ""] = line.split(/[-~]/).map((x) => x.trim());
        return { from, to };
      });

    const restTargets = Array.isArray(prevConfig?.targets) ? prevConfig.targets.slice(1) : [];
    const first = goodsCode
      ? [{
          goodsCode,
          playSeq: list(v.playSeq),
          filter: {
            grades: list(v.grades),
            zones: list(v.zones),
            rowRange: rowFrom === null ? null : { from: rowFrom, to: rowTo },
            rows: rows.length > 0 ? rows : null,
            adjacent: Number(v.adjacent),
            regex: v.regex.trim() || null,
            alertOnFirst: v.alertOnFirst,
          },
        }]
      : [];

    return {
      error: null,
      input: {
        targets: [...first, ...restTargets],
        refresh: { enabled: v.refreshEnabled, intervalSec: Number(v.intervalSec), windows },
        notify: {
          sound: v.sound,
          desktop: v.desktop,
          telegram: { enabled: v.telegramEnabled, token: v.telegramToken.trim(), chatId: v.telegramChatId.trim() },
        },
        profile: { name: v.profileName, phone: v.profilePhone, email: v.profileEmail },
      },
    };
  }

  const api = { configToForm, formToConfig };

  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.NCA ??= {}).formModel = api;
})(globalThis);
