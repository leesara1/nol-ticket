// @ts-check
// 좌석 응답 해석 (DESIGN 7.1). seatMeta(배치) + seatStatus(16진수 비트맵) → Snapshot.
// 순수 모듈 (DESIGN 2.1): content script와 Node 테스트에서 같이 쓴다.

(function (root) {
  "use strict";

  /** @type {{ makeSeatKey: (playSeq: string, id: string) => string }} */
  const types =
    typeof module === "object" && module.exports ? require("./types.js") : root.NCA?.types;
  if (!types) throw new Error("[nca] seat-parse.js보다 shared/types.js를 먼저 불러와야 합니다");

  /**
   * @typedef {import("./types.js").Seat} Seat
   * @typedef {import("./types.js").Snapshot} Snapshot
   *
   * @typedef {Object} MetaSeat  seatMeta 응답의 좌석 (필요한 필드만)
   * @property {string} seatInfoId
   * @property {string} [seatGradeName]
   * @property {string} [floor]
   * @property {string} [rowNo]
   * @property {string|number} [seatNo]
   * @property {number} [colIdx]
   * @property {boolean} [isExposable]
   *
   * @typedef {Object} BlockLayout  구역 하나의 좌석 배치 (변환 완료)
   * @property {Seat[]} seats          seatMeta 순서 그대로 (비트맵 순서)
   * @property {boolean[]} exposable
   */

  /**
   * URL 쿼리에서 goodsCode·playSeq·blockKeys(여러 개)를 읽는다.
   * @param {string} url
   */
  function parseQuery(url) {
    const q = new URL(url).searchParams;
    return { goodsCode: q.get("goodsCode") ?? "", playSeq: q.get("playSeq") ?? "", blockKeys: q.getAll("blockKeys") };
  }

  /**
   * rowNo("A구역 10열", "B구역10열", "차액")를 구역·열로 나눈다.
   * @param {string} rowNo
   * @returns {{ area: string, row: string }}
   */
  function splitRowNo(rowNo) {
    const s = (rowNo ?? "").trim();
    const m = /^(.*?구역)\s*(.+?)열$/.exec(s);
    if (m) return { area: m[1], row: m[2] };
    const r = /^(.+?)열$/.exec(s);
    if (r) return { area: "", row: r[1] };
    return { area: "", row: s };
  }

  /**
   * 16진수 비트맵 → 비트 배열 (상위 비트부터). 형식이 틀리면 null.
   * @param {string} hex
   * @param {number} n  좌석 수
   * @returns {number[] | null}
   */
  function decodeBits(hex, n) {
    if (typeof hex !== "string" || !/^[0-9a-fA-F]*$/.test(hex)) return null;
    if (hex.length !== Math.ceil(n / 4)) return null;
    /** @type {number[]} */
    const bits = [];
    for (const ch of hex) {
      const v = parseInt(ch, 16);
      bits.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
    }
    return bits.slice(0, n);
  }

  /**
   * seatMeta 구역 하나 → Seat 배열. 통로(같은 구역·열에서 colIdx가 2 이상 벌어짐)마다 block 조각을 나눈다.
   * @param {string} blockKey
   * @param {string} playSeq
   * @param {MetaSeat[]} metaSeats
   * @returns {BlockLayout}
   */
  function layoutBlock(blockKey, playSeq, metaSeats) {
    const seats = metaSeats.map((m, i) => {
      const { area, row } = splitRowNo(String(m.rowNo ?? ""));
      const no = String(m.seatNo ?? "");
      const col = /^\d+$/.test(no) ? Number(no) : (Number(m.colIdx) || 0) + 1;
      const floor = String(m.floor ?? "").trim();
      return {
        key: types.makeSeatKey(playSeq, String(m.seatInfoId)),
        id: String(m.seatInfoId),
        playSeq,
        grade: String(m.seatGradeName ?? ""),
        zone: [floor, area].filter(Boolean).join(" "),
        block: blockKey, // 아래에서 조각 번호를 붙인다
        row,
        col,
        seenAt: 0,
        _colIdx: Number(m.colIdx) || 0,
        _i: i,
      };
    });

    // 같은 (zone, row)에서 colIdx 순으로 보고 틈마다 조각 번호를 올린다
    /** @type {Map<string, typeof seats>} */
    const byRow = new Map();
    for (const s of seats) {
      const k = `${s.zone}\u0000${s.row}`;
      const list = byRow.get(k);
      if (list) list.push(s);
      else byRow.set(k, [s]);
    }
    for (const list of byRow.values()) {
      list.sort((a, b) => a._colIdx - b._colIdx);
      let seg = 0;
      for (let i = 0; i < list.length; i++) {
        if (i > 0 && list[i]._colIdx - list[i - 1]._colIdx > 1) seg++;
        list[i].block = `${blockKey}#${seg}`;
      }
    }

    return {
      seats: seats.map(({ _colIdx, _i, ...s }) => /** @type {Seat} */ (s)),
      exposable: metaSeats.map((m) => m.isExposable !== false),
    };
  }

  /**
   * 탭 하나의 좌석 응답을 누적한다 (DESIGN 7.1).
   * - 배치(seatMeta)는 구역마다 기억
   * - 상태(seatStatus)는 구역마다 최신 비트를 기억하고, 지금까지 본 모든 구역을 합쳐 스냅샷을 만든다
   */
  function createAccumulator() {
    let playSeq = "";
    let goodsCode = "";
    /** @type {Map<string, BlockLayout>} */
    let layouts = new Map();
    /** @type {Map<string, number[]>} */
    let statusBits = new Map();

    /** @param {string} nextPlaySeq @param {string} nextGoods */
    function switchShow(nextPlaySeq, nextGoods) {
      if (nextPlaySeq === playSeq && nextGoods === goodsCode) return;
      playSeq = nextPlaySeq;
      goodsCode = nextGoods;
      layouts = new Map();
      statusBits = new Map();
    }

    /**
     * @param {string} url
     * @param {unknown} body  JSON 문자열 또는 객체
     * @returns {{ ok: true, blocks: number } | { error: "selector_mismatch", detail: string }}
     */
    function addMeta(url, body) {
      const q = parseQuery(url);
      const j = typeof body === "string" ? safeJson(body) : body;
      const data = /** @type {any} */ (j)?.data;
      if (!Array.isArray(data)) return { error: "selector_mismatch", detail: "seatMeta.data가 배열이 아님" };
      switchShow(q.playSeq, q.goodsCode);
      for (const b of data) {
        if (typeof b?.blockKey !== "string" || !Array.isArray(b.seats)) {
          return { error: "selector_mismatch", detail: "seatMeta 구역 형식이 다름" };
        }
        layouts.set(b.blockKey, layoutBlock(b.blockKey, q.playSeq, b.seats));
      }
      return { ok: true, blocks: data.length };
    }

    /**
     * @param {string} url
     * @param {unknown} body
     * @param {number} [now]
     * @returns {{ goodsCode: string, snapshot: Snapshot, newBlocks: string[], skipped: string[] }
     *   | { error: "selector_mismatch" | "parse_failed", detail: string }}
     */
    function addStatus(url, body, now = Date.now()) {
      const q = parseQuery(url);
      const j = typeof body === "string" ? safeJson(body) : body;
      const data = /** @type {any} */ (j)?.data;
      if (!Array.isArray(data) || data.length !== q.blockKeys.length) {
        return { error: "selector_mismatch", detail: "seatStatus.data와 blockKeys 개수가 다름" };
      }
      switchShow(q.playSeq, q.goodsCode);

      /** @type {string[]} */
      const newBlocks = [];
      /** @type {string[]} */
      const skipped = [];
      for (let i = 0; i < q.blockKeys.length; i++) {
        const key = q.blockKeys[i];
        const layout = layouts.get(key);
        if (!layout) { skipped.push(key); continue; } // 배치를 아직 못 받은 구역: 다음 갱신 때 반영
        const bits = decodeBits(data[i], layout.seats.length);
        if (!bits) {
          return { error: "selector_mismatch", detail: `구역 ${key} 상태 문자열 길이·형식이 배치와 맞지 않음` };
        }
        if (!statusBits.has(key)) newBlocks.push(key);
        statusBits.set(key, bits);
      }

      /** @type {Seat[]} */
      const available = [];
      let totalSeats = 0;
      for (const [key, bits] of statusBits) {
        const layout = /** @type {BlockLayout} */ (layouts.get(key));
        totalSeats += layout.seats.length;
        for (let i = 0; i < bits.length; i++) {
          if (bits[i] === 1 && layout.exposable[i]) available.push({ ...layout.seats[i], seenAt: now });
        }
      }
      if (statusBits.size > 0 && totalSeats === 0) return { error: "parse_failed", detail: "좌석이 0개" };

      return {
        goodsCode,
        snapshot: { playSeq, source: "net", available, totalSeats, takenAt: now },
        newBlocks,
        skipped,
      };
    }

    return { addMeta, addStatus, blockCount: () => statusBits.size };
  }

  /**
   * 처음 보는 구역의 기존 빈 좌석은 "생김"으로 알리지 않도록 prev에 미리 넣는다 (DESIGN 7.1, D10).
   * @param {Snapshot | null} prev
   * @param {Snapshot} curr
   * @param {string[]} newBlocks
   * @returns {Snapshot | null}
   */
  function withBaseline(prev, curr, newBlocks) {
    if (!prev || prev.playSeq !== curr.playSeq || newBlocks.length === 0) return prev;
    const fresh = new Set(newBlocks);
    const extra = curr.available.filter((s) => fresh.has(s.block.split("#")[0]));
    if (extra.length === 0) return prev;
    const have = new Set(prev.available.map((s) => s.key));
    return { ...prev, available: [...prev.available, ...extra.filter((s) => !have.has(s.key))] };
  }

  /** @param {string} s */
  function safeJson(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  const api = { parseQuery, splitRowNo, decodeBits, layoutBlock, createAccumulator, withBaseline };

  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.NCA ??= {}).seatParse = api;
})(globalThis);
