import { describe, expect, test } from "bun:test";
import { checkBoard, type IssueKind } from "../src/shared/check.ts";
import { keptOnFocus } from "../src/shared/focus.ts";
import { SUMMARY_HEAD_H, SUMMARY_MIN_W, SUMMARY_PAD_BOTTOM, SUMMARY_ROW_H, SUMMARY_W, applyOps, boxOf, emptyDoc, parseDoc, parseEl, serialize, summaryHeight, type Doc, type El } from "../src/shared/model.ts";
import { itemsOf, summarize, withSummaryHeights } from "../src/shared/summary.ts";

const add = (el: Record<string, unknown>) => ({ op: "add", el });
const band = (extra: Record<string, unknown> = {}) => ({ id: "sum", type: "summary", show: "decided", x: 0, y: 0, ...extra });
const note = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "shape", x: 0, y: 1000, w: 220, h: 110, ...extra });
const section = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ id, type: "container", x, y, w: 500, h: 300, ...extra });

function build(ops: unknown[]): Doc {
  const r = applyOps(emptyDoc("t"), ops);
  if (!r.ok) throw new Error(r.error);
  return r.value.doc;
}
const ids = (doc: Doc, show: "decided" | "open" | "todo" | "carried" | "priority"): string[] => summarize(doc.elements)[show].map((i) => i.id);

describe("まとめの帯（summary）の形", () => {
  test.each([
    ["show が無い", { id: "sum", type: "summary", x: 0, y: 0 }, "summary には show が要る"],
    ["知らない状態", band({ show: "done" }), "show は decided | open | todo | carried | priority のどれか 1 つ"],
    ["状態を 2 つ書いた", band({ show: ["decided", "open"] }), "show は"],
    ["text を書いた", band({ text: "x" }), "summary に text は無い"],
    ["cols を書いた", band({ cols: 2 }), "summary に cols は無い"],
    ["幅が下限より狭い", band({ w: SUMMARY_MIN_W - 1 }), "summary の w は 240 以上"],
    ["title が文字でない", band({ title: 1 }), "title は文字列"],
  ])("%s は断る", (_name, raw, message) => {
    const r = parseEl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  test.each([
    ["decided", band({ show: "decided" })],
    ["open", band({ show: "open" })],
    ["todo", band({ show: "todo" })],
    ["carried", band({ show: "carried" })],
    ["priority", band({ show: "priority" })],
    ["題名、色、固定", band({ title: "決定事項", color: "green", locked: true })],
    ["幅が下限ちょうど", band({ w: SUMMARY_MIN_W })],
  ])("%s は通る", (_name, raw) => {
    expect(parseEl(raw).ok).toBe(true);
  });

  // 画面の「元に戻す」とファイルが、h の付いた帯を渡す。断らずに捨てる（列で並べるセクションの h と同じ扱い）
  test.each<[string, (h: number) => El | undefined]>([
    ["add", (h) => build([add(band({ h }))]).elements[0]],
    ["set", (h) => build([add(band()), { op: "set", id: "sum", patch: { h } }]).elements[0]],
    [
      "ファイル",
      (h) => {
        const r = parseDoc(serialize(build([add(band())])).replace('"show":"decided"', `"show":"decided","h":${h}`));
        if (!r.ok) throw new Error(r.error);
        return r.value.elements[0];
      },
    ],
  ])("h は、%s で書かれても、受け取って捨てる", (_name, make) => {
    expect(make(999)?.h).toBeUndefined();
  });

  test.each<[string, Record<string, unknown>, string | null]>([
    ["show を別の状態へ変える", { show: "todo" }, null],
    ["題名を消す", { title: null }, null],
    ["幅を変える", { w: 600 }, null],
    ["show を消す", { show: null }, "summary には show が要る"],
    ["幅を下限より狭くする", { w: 100 }, "summary の w は 240 以上"],
  ])("set: %s", (_name, patch, error) => {
    const r = applyOps(emptyDoc("t"), [add(band({ title: "決定事項" })), { op: "set", id: "sum", patch }]);
    if (error === null) expect(r.ok).toBe(true);
    else expect(r.ok ? "" : r.error).toContain(error);
  });

  test("ファイルに書いて読み直すと同じ", () => {
    const doc = build([add(band({ title: "決定事項", color: "green", w: 600 })), add(note("a", { status: "decided" }))]);
    const r = parseDoc(serialize(doc));
    expect(r.ok && r.value.elements).toEqual(doc.elements);
  });
});

describe("帯が集める付箋", () => {
  test.each<[string, Record<string, unknown>, Partial<Record<"decided" | "open" | "todo" | "carried" | "priority", string[]>>]>([
    ["状態が同じ付箋", { status: "decided" }, { decided: ["a"] }],
    ["持ち越しの日付だけを書いた付箋は、持ち越し", { carriedFrom: "2026-11-11" }, { carried: ["a"] }],
    ["状態が持ち越しで、日付もある付箋は、持ち越しに 1 回だけ", { status: "carried", carriedFrom: "2026-11-11" }, { carried: ["a"] }],
    ["持ち越しの宿題は、宿題にだけ出る", { status: "todo", carriedFrom: "2026-11-11" }, { todo: ["a"] }],
    ["持ち越しの未決は、未決にだけ出る", { status: "open", carriedFrom: "2026-11-11" }, { open: ["a"] }],
    ["状態も持ち越しの日付も無い付箋は、どこにも出ない", { text: "ふつうの付箋" }, {}],
    ["付箋でない図形も、状態があれば出る", { shape: "rect", status: "open" }, { open: ["a"] }],
  ])("%s", (_name, extra, expected) => {
    const got = summarize(build([add(note("a", extra))]).elements);
    expect({ decided: got.decided.map((i) => i.id), open: got.open.map((i) => i.id), todo: got.todo.map((i) => i.id), carried: got.carried.map((i) => i.id), priority: got.priority.map((i) => i.id) }).toEqual({
      decided: [],
      open: [],
      todo: [],
      carried: [],
      priority: [],
      ...expected,
    });
  });

  test("付箋と図形のほか（文字、表、セクション、コメント、帯）は集めない", () => {
    const doc = build([
      add({ id: "t", type: "text", x: 0, y: 0, text: "決定" }),
      add({ id: "tb", type: "table", x: 0, y: 200, rows: [["決定"]] }),
      add(section("s", 0, 400, { title: "決定事項" })),
      add({ id: "c", type: "comment", x: 600, y: 0 }),
      add(band({ x: 600, y: 400 })),
    ]);
    expect(Object.values(summarize(doc.elements)).flat()).toEqual([]);
  });

  // 並ぶ順は、ボードの上の位置の順。要素の並び（足した順、前面と背面）には関わらない
  const d = (id: string, x: number, y: number) => add(note(id, { x, y, status: "decided" }));
  test.each<[string, unknown[], string[]]>([
    ["セクションに入っていない付箋は、上から", [d("low", 0, 900), d("high", 0, 0)], ["high", "low"]],
    ["同じ高さなら、左から", [d("right", 600, 0), d("left", 0, 0)], ["left", "right"]],
    ["前面へ動かしても、順は変わらない", [d("a", 0, 0), d("b", 300, 0), { op: "order", id: "a", to: "front" }], ["a", "b"]],
    [
      "セクションの順（上から）に、まとまる。足した順には交じらない",
      [add(section("s2", 0, 400)), add(section("s1", 0, 0)), d("b1", 20, 460), d("a1", 20, 60), d("b2", 260, 460), d("a2", 260, 60)],
      ["a1", "a2", "b1", "b2"],
    ],
    ["同じ高さのセクションは、左から", [add(section("r", 600, 0)), add(section("l", 0, 0)), d("r1", 620, 60), d("l1", 20, 60)], ["l1", "r1"]],
    ["同じセクションの中では、上から、同じ高さなら左から", [add(section("s1", 0, 0, { h: 500 })), d("c", 20, 200), d("b", 260, 60), d("a", 20, 60)], ["a", "b", "c"]],
    [
      "セクションに入っていない付箋は、入っている付箋の後ろ（上にあっても）",
      [add(section("s1", 0, 400)), d("free", 900, 0), d("in", 20, 460)],
      ["in", "free"],
    ],
    [
      "入れ子の付箋は、面積の小さいセクションの場所で並ぶ",
      [add(section("big", 0, 0, { w: 1200, h: 900 })), add(section("small", 20, 500, { w: 400, h: 300 })), d("inSmall", 40, 560), d("inBig", 600, 60)],
      ["inBig", "inSmall"],
    ],
  ])("並ぶ順は、位置の順: %s", (_name, ops, expected) => {
    expect(ids(build(ops), "decided")).toEqual(expected);
  });

  test("列で並べるセクションの中で付箋を入れ替えると、行も入れ替わる", () => {
    const base = [add({ id: "t", type: "container", x: 0, y: 0, w: 520, cols: 2 }), { op: "add", in: "t", el: { id: "a", type: "shape", text: "A", status: "decided" } }, { op: "add", in: "t", el: { id: "b", type: "shape", text: "B", status: "decided" } }];
    expect(ids(build(base), "decided")).toEqual(["a", "b"]);
    // b を、a より左へ動かす。詰め直しが b を先頭に並べる
    expect(ids(build([...base, { op: "set", id: "b", patch: { x: 0, y: 40 } }]), "decided")).toEqual(["b", "a"]);
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["見出しがあれば見出し", { title: "見積もり", text: "来週まで" }, "見積もり"],
    ["見出しの前後の空白は除く", { title: "  見積もり ", text: "来週まで" }, "見積もり"],
    ["見出しが無ければ、本文の 1 行め", { text: "1 行め\n2 行め" }, "1 行め"],
    ["見出しが空なら、本文", { title: "", text: "本文" }, "本文"],
    ["見出しが空白だけなら、本文", { title: "   ", text: "本文" }, "本文"],
    ["本文の空の行は飛ばす", { text: "\n\n3 行め" }, "3 行め"],
    ["装飾の記号は除く", { text: "**大事**な話と`コード`と==帯==" }, "大事な話とコードと帯"],
    ["リンクは、表示の文字だけ", { text: "[仕様](https://example.com/a)を読む" }, "仕様を読む"],
    ["箇条書きの印は除く", { text: "- 1 つめ\n- 2 つめ" }, "1 つめ"],
    ["番号の印は除く", { text: "1. 最初にやる" }, "最初にやる"],
    ["見出しも本文も無ければ id", {}, "a"],
    ["本文が空の文字なら id", { text: "" }, "a"],
  ])("行に出す文字: %s", (_name, extra, expected) => {
    expect(summarize(build([add(note("a", { status: "decided", ...extra }))]).elements).decided[0]?.label).toBe(expected);
  });

  test.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["担当と期限と持ち越しの日付", { status: "todo", who: "竹内", due: "2026-11-20", carriedFrom: "2026-11-11" }, { id: "a", label: "a", who: "竹内", due: "2026-11-20", carriedFrom: "2026-11-11" }],
    ["無い値のキーは省く", { status: "todo" }, { id: "a", label: "a" }],
  ])("行の項目: %s", (_name, extra, expected) => {
    expect<unknown>(summarize(build([add(note("a", extra))]).elements).todo[0]).toEqual(expected);
  });

  test.each<[string, unknown[], unknown]>([
    ["中心が枠の中。セクションの id と題名", [add(section("s", 0, 0, { title: "議題 1" })), add(note("a", { x: 20, y: 60 }))], { id: "s", title: "議題 1" }],
    ["どのセクションにも入らない", [add(section("s", 0, 0, { title: "議題 1" })), add(note("a", { x: 900, y: 60 }))], undefined],
    ["中心が、ちょうど枠の辺の上", [add(section("s", 0, 0, { title: "議題 1" })), add(note("a", { x: 390, y: 60 }))], { id: "s", title: "議題 1" }],
    ["一部がかかるだけで、中心が外", [add(section("s", 0, 0, { title: "議題 1" })), add(note("a", { x: 400, y: 60 }))], undefined],
    ["題名が無ければ論点", [add(section("s", 0, 0, { question: "何人採るか" })), add(note("a", { x: 20, y: 120 }))], { id: "s", title: "何人採るか" }],
    ["題名が空白だけなら論点", [add(section("s", 0, 0, { title: "  ", question: "何人採るか" })), add(note("a", { x: 20, y: 120 }))], { id: "s", title: "何人採るか" }],
    ["題名も論点も無ければ、id だけ", [add(section("s", 0, 0)), add(note("a", { x: 20, y: 60 }))], { id: "s" }],
    [
      "2 つの枠に中心が入る付箋は、面積の小さい枠のセクション",
      [add(section("big", 0, 0, { title: "大", w: 900, h: 600 })), add(section("small", 10, 50, { title: "小", w: 300, h: 200 })), add(note("a", { x: 20, y: 60 }))],
      { id: "small", title: "小" },
    ],
    ["固定したセクションの中の付箋も、同じに集める", [add(section("s", 0, 0, { title: "まとめ", locked: true })), add(note("a", { x: 20, y: 60 }))], { id: "s", title: "まとめ" }],
  ])("どのセクションの付箋か: %s", (_name, ops, expected) => {
    const withStatus = ops.map((op) => (JSON.stringify(op).includes('"id":"a"') ? add(note("a", { ...Object(op).el, status: "decided" })) : op));
    expect<unknown>(summarize(build(withStatus).elements).decided[0]?.section).toEqual(expected);
  });

  test.each<[string, unknown[]]>([
    ["空のボード", []],
    ["帯が無く、状態の無い付箋だけ", [add(note("a"))]],
  ])("状態のキーは、0 件でも 5 つ返す: %s", (_name, ops) => {
    expect(summarize(build(ops).elements)).toEqual({ decided: [], open: [], todo: [], carried: [], priority: [] });
  });

  test("帯の要素が無くても、状態ごとに集める", () => {
    const doc = build([add(note("a", { status: "decided" })), add(note("b", { x: 300, status: "todo" }))]);
    expect([ids(doc, "decided"), ids(doc, "todo")]).toEqual([["a"], ["b"]]);
  });

  test("帯の要素が集める行は、その帯の show の状態", () => {
    const doc = build([add(band({ show: "todo" })), add(note("a", { status: "decided" })), add(note("b", { x: 300, status: "todo" }))]);
    const all = summarize(doc.elements);
    expect(doc.elements.map((el) => itemsOf(all, el).map((i) => i.id))).toEqual([["b"], [], []]);
  });
});

describe("帯の高さ", () => {
  // 画面の CSS（board.css の .summary の .shead の height、.srow の height）と同じ値。変えるときは、CSS も変える
  test("題名の帯 52、1 行 28、下の余白 12。既定の幅 480", () => {
    expect([SUMMARY_HEAD_H, SUMMARY_ROW_H, SUMMARY_PAD_BOTTOM, SUMMARY_W]).toEqual([52, 28, 12, 480]);
  });

  test.each([
    ["0 行は、「無し」の 1 行ぶん", 0, 92],
    ["1 行", 1, 92],
    ["2 行", 2, 120],
    ["30 行", 30, 904],
  ])("%s", (_name, rows, expected) => {
    expect(summaryHeight(rows)).toBe(expected);
  });

  const notes = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => add(note(`n${i}`, { x: i * 240, status: "decided", ...extra })));
  test.each<[string, unknown[], number]>([
    ["集める付箋が無い", [add(band())], 92],
    ["1 枚", [add(band()), ...notes(1)], 92],
    ["3 枚", [add(band()), ...notes(3)], 148],
    ["別の状態の付箋は数えない", [add(band()), ...notes(3, { status: "open" })], 92],
    ["幅に入りきらない長い見出しでも、折り返さないので変わらない", [add(band({ w: 240 })), ...notes(2, { title: "とても長い見出し".repeat(10) })], 120],
    ["幅を変えても変わらない", [add(band({ w: 900 })), ...notes(2)], 120],
    ["show を変えると、集め直す", [add(band()), ...notes(3), { op: "set", id: "sum", patch: { show: "open" } }], 92],
    ["付箋を消すと減る", [add(band()), ...notes(3), { op: "rm", id: "n0" }], 120],
  ])("今の行の数からの高さ: %s", (_name, ops, expected) => {
    const sum = withSummaryHeights(build(ops).elements).find((e) => e.id === "sum");
    expect(sum ? boxOf(sum) : null).toMatchObject({ h: expected });
  });

  test("帯の無いボードは、そのまま返す", () => {
    const doc = build([add(note("a", { status: "decided" }))]);
    expect(withSummaryHeights(doc.elements)).toEqual(doc.elements);
  });

  test("高さをまだ入れていない帯は、1 行ぶんの大きさ", () => {
    expect(boxOf(build([add(band())]).elements[0] ?? { id: "x", type: "summary" })).toEqual({ x: 0, y: 0, w: 480, h: 92 });
  });
});

describe("帯の検査", () => {
  const kinds = (ops: unknown[]): string[] =>
    checkBoard(build(ops))
      .filter((i) => i.kind.includes("summary"))
      .map((i) => `${i.kind}:${i.ids.join(",")}`);
  const locked = (extra: Record<string, unknown> = {}) => add(section("m", 0, 400, { title: "決定事項", locked: true, ...extra }));
  const inM = (id: string, i: number, extra: Record<string, unknown>) => add(note(id, { x: 20 + i * 240, y: 460, ...extra }));

  test.each<[string, unknown[], string[]]>([
    ["同じ show の帯が 2 つ", [add(band({ id: "s1" })), add(band({ id: "s2", x: 600 }))], ["duplicate-summary:s1,s2"]],
    ["同じ show の帯が 3 つ。1 件で、要素の並びの順に全部", [add(band({ id: "s1" })), add(band({ id: "s2", x: 600 })), add(band({ id: "s3", x: 1200 }))], ["duplicate-summary:s1,s2,s3"]],
    ["show が別々の帯", [add(band({ id: "s1" })), add(band({ id: "s2", x: 600, show: "open" }))], []],
    [
      "2 つの状態で、それぞれ重なっている。show ごとに 1 件",
      [add(band({ id: "s1" })), add(band({ id: "s2", x: 600, show: "open" })), add(band({ id: "s3", x: 1200 })), add(band({ id: "s4", x: 1800, show: "open" }))],
      ["duplicate-summary:s1,s3", "duplicate-summary:s2,s4"],
    ],
    ["固定したセクションに、同じ状態の付箋が 2 枚", [locked(), inM("a", 0, { status: "decided" }), inM("b", 1, { status: "decided" })], ["manual-summary:m"]],
    ["同じ状態の帯がボードにあっても知らせる", [add(band()), locked(), inM("a", 0, { status: "decided" }), inM("b", 1, { status: "decided" })], ["manual-summary:m"]],
    ["状態の無い付箋が混ざっていても、状態つきが 2 枚そろえば知らせる", [locked(), inM("a", 0, { status: "todo" }), inM("b", 1, { status: "todo" }), add(note("c", { x: 20, y: 580, h: 100 }))], ["manual-summary:m"]],
    ["固定していないセクション", [locked({ locked: false }), inM("a", 0, { status: "decided" }), inM("b", 1, { status: "decided" })], []],
    ["固定したセクションに、状態の無い付箋だけ", [locked(), inM("a", 0, {}), inM("b", 1, {})], []],
    ["状態つきの付箋が 1 枚だけ", [locked(), inM("a", 0, { status: "decided" }), inM("b", 1, {})], []],
    ["状態が別々の付箋", [locked(), inM("a", 0, { status: "decided" }), inM("b", 1, { status: "open" })], []],
    ["セクションに入っていない、固定した状態つきの付箋", [inM("a", 0, { status: "decided", locked: true }), inM("b", 1, { status: "decided", locked: true })], []],
    ["帯の中心がセクションの枠の中", [add(section("c", 0, 400, { w: 900 })), add(band({ x: 20, y: 460 }))], ["summary-in-section:sum,c"]],
    ["帯がセクションの外", [add(section("c", 0, 400)), add(band())], []],
  ])("%s", (_name, ops, expected) => {
    expect(kinds(ops)).toEqual(expected);
  });

  // 知らせの直し方を当てた後に、もう一度検査をかける。どの種類の知らせも残らない
  test.each<[string, unknown[], IssueKind, unknown[]]>([
    ["同じ show の帯は、1 つを残して消す", [add(band({ id: "s1" })), add(band({ id: "s2", x: 600 }))], "duplicate-summary", [{ op: "rm", id: "s2" }]],
    [
      "手で写したまとめは、セクションと付箋を消して、知らせに出た形の帯を足す",
      [locked(), inM("a", 0, { status: "decided" }), inM("b", 1, { status: "decided" })],
      "manual-summary",
      [{ op: "rm", id: "m" }, { op: "rm", id: "a" }, { op: "rm", id: "b" }, add({ type: "summary", show: "decided", x: 0, y: 400 })],
    ],
    ["セクションの中の帯は、外へ動かす", [add(section("c", 0, 400, { w: 900 })), add(band({ x: 20, y: 460 }))], "summary-in-section", [{ op: "set", id: "sum", patch: { x: 0, y: 0 } }]],
  ])("案内どおりに直すと、知らせが残らない: %s", (_name, ops, kind, fix) => {
    expect(checkBoard(build(ops)).map((i) => i.kind)).toEqual([kind]);
    expect(checkBoard(build([...ops, ...fix]))).toEqual([]);
  });

  // 帯は、列で並べるセクションの中身として並べない（並べると、幅を列の幅に書き換えられて、下限を割る）
  const cols = add({ id: "t", type: "container", title: "議題", x: 0, y: 400, w: 740, cols: 3 });
  const inCols = { op: "add", in: "t", el: { id: "a", type: "shape", text: "A" } };
  test.each<[string, unknown[]]>([
    ["set で、帯を列のセクションの枠の中へ動かす", [cols, inCols, add(band({ w: 480 })), { op: "set", id: "sum", patch: { x: 20, y: 450 } }]],
    ["帯を、はじめから列のセクションの枠の中に足す", [cols, inCols, add(band({ w: 480, x: 20, y: 450 }))]],
    ["帯が中にある列のセクションに、付箋を足す", [cols, inCols, add(band({ w: 480, x: 20, y: 450 })), { op: "add", in: "t", el: { id: "b", type: "shape", text: "B" } }]],
  ])("列で並べるセクションの中に帯があっても、帯の場所と幅は変わらず、外へ動かせば知らせが消える: %s", (_name, ops) => {
    const doc = build(ops);
    expect(doc.elements.find((e) => e.id === "sum")).toMatchObject({ x: 20, y: 450, w: 480 });
    expect(kinds(ops)).toEqual(["summary-in-section:sum,t"]);
    // 知らせの直し方（x・y を set）が通り、知らせが残らない
    const fixed = build([...ops, { op: "set", id: "sum", patch: { x: 0, y: 0 } }]);
    expect(fixed.elements.find((e) => e.id === "sum")).toMatchObject({ x: 0, y: 0, w: 480 });
    expect(checkBoard(fixed)).toEqual([]);
  });

  test("手で写したまとめの知らせに、足す帯の形が出る", () => {
    const message = checkBoard(build([locked(), inM("a", 0, { status: "decided" }), inM("b", 1, { status: "decided" })]))[0]?.message;
    expect(message).toContain('{"type":"summary","show":"decided","x":0,"y":400}');
  });

  const rows = (n: number) => Array.from({ length: n }, (_, i) => add(note(`n${i}`, { x: i * 240, y: 2000, status: "decided" })));
  test.each<[string, unknown[], string[]]>([
    ["帯と付箋が重なる", [add(band()), add(note("a", { x: 100, y: 20 }))], ["overlap:sum,a"]],
    ["間を空けて置いた帯と付箋", [add(band()), add(note("a", { x: 0, y: 200 }))], []],
    ["帯が伸びたぶんも、重なりに数える（1 行なら届かない付箋に、4 行で届く）", [add(band()), add(note("a", { x: 0, y: 120 })), ...rows(4)], ["overlap:sum,a"]],
    ["帯がセクションの枠にかかる", [add(section("c", 300, 0)), add(band())], ["on-section-edge:sum,c"]],
  ])("帯は、場所をふさぐ: %s", (_name, ops, expected) => {
    expect(checkBoard(build(ops)).map((i) => `${i.kind}:${i.ids.join(",")}`)).toEqual(expected);
  });

  test("帯の行は要素でないので、繰り返しの検査に数えない", () => {
    const doc = build([add(band()), add(note("a", { status: "decided", text: "来期は 2 人採る。4 月入社を目標に、12 月から媒体に出す" }))]);
    expect(checkBoard(doc)).toEqual([]);
  });
});

describe("注目の間、帯は薄くしない", () => {
  const s: El = { id: "s", type: "container", x: 0, y: 0, w: 500, h: 300 };
  const u: El = { id: "u", type: "container", x: 0, y: 800, w: 900, h: 400 };
  const sum = (x: number, y: number): El => ({ id: "sum", type: "summary", show: "decided", x, y, w: 480 });
  test.each<[string, El[], string[]]>([
    ["セクションに入っていない、固定していない帯", [s, sum(1000, 0)], ["s", "sum"]],
    ["固定していないセクションの中の帯。帯だけ残り、そのセクションは残らない", [s, u, sum(20, 860)], ["s", "sum"]],
    ["帯を指すコメントも残る", [s, sum(1000, 0), { id: "k", type: "comment", x: 2000, y: 2000, on: "sum" }], ["k", "s", "sum"]],
  ])("%s", (_name, els, expected) => {
    expect([...(keptOnFocus(els, "s") ?? [])].sort()).toEqual(expected);
  });
});
