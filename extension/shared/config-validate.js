// @ts-check
// 설정 검증 (DESIGN 12.3). 잘못된 값은 안전한 값으로 고치고 경고를 반환한다.

(function (root) {
  "use strict";

  /** @type {{ normalizeFilter: (filter: import("./types.js").Filter | undefined) => Required<import("./types.js").Filter> }} */
  const detector =
    typeof module === "object" && module.exports ? require("./detector.js") : root.NCA?.detector;
  if (!detector) throw new Error("[nca] config-validate.js보다 shared/detector.js를 먼저 불러와야 합니다");

  /**
   * @typedef {import("./types.js").Filter} Filter
   *
   * @typedef {Object} TargetConfig
   * @property {string} goodsCode
   * @property {string[]} playSeq
   * @property {Required<Filter>} filter
   *
     * @typedef {Object} UserConfig
   * @property {TargetConfig[]} targets
   * @property {{ sound: boolean, desktop: boolean, telegram: { enabled: boolean, token: string, chatId: string } }} notify
   * @property {{ name: string, phone: string, email: string }} profile
   */

  /** @returns {UserConfig} */
  function defaultUserConfig() {
    return {
      targets: [],
      notify: {
        sound: true,
        desktop: true,
        telegram: { enabled: false, token: "", chatId: "" },
      },
      profile: { name: "", phone: "", email: "" },
    };
  }

  /** @param {unknown} v */
  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  /**
   * @param {unknown} filterInput
   * @param {string[]} warnings
   * @param {string} pathPrefix
   * @returns {Required<Filter>}
   */
  function validateFilter(filterInput, warnings, pathPrefix) {
    const raw = isPlainObject(filterInput) ? /** @type {Filter} */ (filterInput) : undefined;
    const f = detector.normalizeFilter(raw);

    let rowRange = f.rowRange;
    if (rowRange !== null) {
      const fromOk = Number.isInteger(rowRange.from);
      const toOk = Number.isInteger(rowRange.to);
      if (!fromOk || !toOk || rowRange.from > rowRange.to) {
        warnings.push(
          `${pathPrefix}.rowRange ${JSON.stringify(rowRange)} → null (from·to는 from ≤ to인 정수여야 함)`,
        );
        rowRange = null;
      } else {
        rowRange = { from: rowRange.from, to: rowRange.to };
      }
    }

    let regex = f.regex;
    if (regex !== null) {
      try {
        new RegExp(regex);
      } catch {
        warnings.push(`${pathPrefix}.regex ${JSON.stringify(regex)} → null (정규식 컴파일 실패)`);
        regex = null;
      }
    }

    /**
     * 문자열 배열만 남긴다. 배열이 아니거나 문자열이 아닌 원소가 있으면 경고.
     * @param {string} name @param {unknown} v @param {string[] | null} fallback
     */
    const stringList = (name, v, fallback) => {
      if (v == null) return fallback;
      if (!Array.isArray(v)) {
        warnings.push(`${pathPrefix}.${name} ${JSON.stringify(v)} → ${JSON.stringify(fallback)} (배열이 아님)`);
        return fallback;
      }
      const kept = v.filter((x) => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
      if (kept.length !== v.length) warnings.push(`${pathPrefix}.${name}: 문자열이 아닌·빈 항목 제거`);
      return kept;
    };

    const rawObj = /** @type {Record<string, unknown>} */ (raw ?? {});
    if ("adjacent" in rawObj && rawObj.adjacent !== f.adjacent) {
      warnings.push(`${pathPrefix}.adjacent ${JSON.stringify(rawObj.adjacent)} → ${f.adjacent} (1 이상 정수여야 함)`);
    }

    const rows = stringList("rows", rawObj.rows, null);

    return {
      grades: /** @type {string[]} */ (stringList("grades", rawObj.grades, [])),
      zones: /** @type {string[]} */ (stringList("zones", rawObj.zones, [])),
      rowRange,
      rows: rows && rows.length > 0 ? rows : null,
      adjacent: f.adjacent,
      regex,
      alertOnFirst: f.alertOnFirst,
    };
  }

  /**
   * @param {unknown} input
   * @returns {{ config: UserConfig, warnings: string[] }}
   */
  function validateUserConfig(input) {
    /** @type {string[]} */
    const warnings = [];

    if (!isPlainObject(input)) {
      warnings.push("입력이 객체가 아님 → 기본값 사용");
      return { config: defaultUserConfig(), warnings };
    }

    const src = /** @type {Record<string, unknown>} */ (input);
    const defaults = defaultUserConfig();

    // ── targets ──
    /** @type {TargetConfig[]} */
    let targets = [];
    if (!Array.isArray(src.targets)) {
      warnings.push("targets 배열이 아님 → []");
    } else {
      for (let i = 0; i < src.targets.length; i++) {
        const t = src.targets[i];
        if (!isPlainObject(t)) {
          warnings.push(`targets[${i}] 객체가 아님 → 제거`);
          continue;
        }
        const tr = /** @type {Record<string, unknown>} */ (t);
        const goodsCode = tr.goodsCode;
        if (typeof goodsCode !== "string" || !/^\d+$/.test(goodsCode)) {
          warnings.push(
            `targets[${i}].goodsCode ${JSON.stringify(goodsCode)} → 제거 (숫자 문자열 아님)`,
          );
          continue;
        }

        /** @type {string[]} */
        let playSeq = [];
        if (Array.isArray(tr.playSeq)) {
          for (const p of tr.playSeq) {
            if (typeof p === "string" && p !== "") playSeq.push(p);
          }
        }

        const filter = validateFilter(tr.filter, warnings, `targets[${i}].filter`);
        targets.push({ goodsCode, playSeq, filter });
      }
    }

    // refresh(자동 새로고침)는 없앴다: 좌석맵이 스스로 갱신한다 (DESIGN 9). 예전 설정의 refresh 키는 모르는 키로 버린다.

    // ── notify ──
    const notifySrc = isPlainObject(src.notify)
      ? /** @type {Record<string, unknown>} */ (src.notify)
      : {};
    const sound = typeof notifySrc.sound === "boolean" ? notifySrc.sound : defaults.notify.sound;
    const desktop =
      typeof notifySrc.desktop === "boolean" ? notifySrc.desktop : defaults.notify.desktop;

    const tgSrc = isPlainObject(notifySrc.telegram)
      ? /** @type {Record<string, unknown>} */ (notifySrc.telegram)
      : {};
    const token = typeof tgSrc.token === "string" ? tgSrc.token : "";
    const chatId = typeof tgSrc.chatId === "string" ? tgSrc.chatId : "";
    let tgEnabled = typeof tgSrc.enabled === "boolean" ? tgSrc.enabled : false;
    if (tgEnabled && (token.trim() === "" || chatId.trim() === "")) {
      warnings.push("notify.telegram.enabled true → false (token·chatId 비어 있음)");
      tgEnabled = false;
    }

    // ── profile ──
    const profileSrc = isPlainObject(src.profile)
      ? /** @type {Record<string, unknown>} */ (src.profile)
      : {};
    /** @param {unknown} v */
    const strField = (v) => (typeof v === "string" ? v.trim() : "");

    /** @type {UserConfig} */
    const config = {
      targets,
      notify: {
        sound,
        desktop,
        telegram: { enabled: tgEnabled, token, chatId },
      },
      profile: {
        name: strField(profileSrc.name),
        phone: strField(profileSrc.phone),
        email: strField(profileSrc.email),
      },
    };

    return { config, warnings };
  }

  /**
   * 값이 없거나 빈 문자열이거나 "TODO"로 시작하면 누락.
   * @param {unknown} v
   */
  function isBlankOrTodo(v) {
    if (v == null) return true;
    if (typeof v !== "string") return true;
    if (v === "") return true;
    if (v.startsWith("TODO")) return true;
    return false;
  }

  /**
   * 사이트 설정 점검 (DESIGN 12.1). 비었거나 "TODO"로 시작하거나 정규식이 컴파일되지 않는 필수 항목의 경로를 돌려준다.
   * @param {unknown} site
   * @returns {{ missing: string[] }}
   */
  function validateSiteConfig(site) {
    /** @type {string[]} */
    const missing = [];
    const s = isPlainObject(site) ? /** @type {Record<string, any>} */ (site) : {};
    /** @param {string} path */
    const get = (path) => path.split(".").reduce((o, k) => (isPlainObject(o) ? o[k] : undefined), /** @type {any} */ (s));

    for (const path of ["seatMapFrame.urlPattern", "net.metaUrlPattern", "net.statusUrlPattern", "pageState.gqlUrlPattern"]) {
      const v = get(path);
      if (isBlankOrTodo(v)) { missing.push(path); continue; }
      try { new RegExp(/** @type {string} */ (v)); } catch { missing.push(path); }
    }
    if (get("net.statusEncoding") !== "hex-msb") missing.push("net.statusEncoding");
    if (isBlankOrTodo(get("pageState.expiredOperation"))) missing.push("pageState.expiredOperation");
    for (const path of ["assist.seatMapSelector", "assist.seatSvgSelector", "assist.confirmButtonSelector"]) {
      if (isBlankOrTodo(get(path))) missing.push(path);
    }
    return { missing };
  }

  const api = { defaultUserConfig, validateUserConfig, validateSiteConfig };

  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.NCA ??= {}).configValidate = api;
})(globalThis);
