// 並べ直し（format）。揃える（既定）と、組み直す（rebuild）。
// 表のテストは、どの行も、置いた場所に加えて、もう一度かけても何も動かないことを確かめる。
// 乱数のテストの回数は、XWB_FUZZ_SEEDS=3000 bun test test/format.test.ts で増やせる。
import { describe, expect, test } from "bun:test";
import { FORMAT_MAX_COLS, planAlign, planRebuild } from "../src/shared/format.ts";
import { applyOps, boxOf, emptyDoc, parseEl, summaryHeight, type Applied, type Doc, type El } from "../src/shared/model.ts";
import { agentOp, formatViolations, messyBoard, rng, tidyBoard, type FormatOp } from "./random.ts";

type Raw = Record<string, unknown>;
const add = (el: Raw) => ({ op: "add", el });
/** 自由に置くセクション（幅 504）。高さを書かなければ 100 */
const sec = (id: string, x: number, y: number, extra: Raw = {}): Raw => ({ id, type: "container", x, y, w: 504, h: 100, ...extra });
const note = (id: string, x: number, y: number, extra: Raw = {}): Raw => ({ id, type: "shape", x, y, w: 220, h: 110, ...extra });
const band = (id: string, x: number, y: number, extra: Raw = {}): Raw => ({ id, type: "summary", show: "decided", x, y, ...extra });
/** 行が 1 つ（か 0）の帯の高さ */
const BAND_H = summaryHeight(1);

function build(ops: unknown[], base: Doc = emptyDoc("t")): Doc {
  const r = applyOps(base, ops);
  if (!r.ok) throw new Error(r.error);
  return r.value.doc;
}
const board = (els: Raw[]): Doc => build(els.map(add));

function format(doc: Doc, cols?: number): Applied {
  const r = applyOps(doc, [{ op: "format", rebuild: true, ...(cols === undefined ? {} : { cols }) }]);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
const ids = (applied: Applied): string[] => applied.updated.map((e) => e.id).sort();
const errorOf = (doc: Doc, ops: unknown[]): string => {
  const r = applyOps(doc, ops);
  return r.ok ? "" : r.error;
};

type Want = Record<string, Raw>;
/** 並べ直した結果が期待どおりで、もう一度かけても、関係のない操作をしても、何も動かない */
function expectFormatted(doc: Doc, cols: number | undefined, want: Want): Applied {
  const first = format(doc, cols);
  for (const [id, w] of Object.entries(want)) expect(first.doc.elements.find((e) => e.id === id)).toMatchObject(w);
  const again = format(first.doc, cols);
  expect(ids(again)).toEqual([]);
  expect(again.doc.elements).toEqual(first.doc.elements);
  const idle = applyOps(first.doc, [{ op: "title", title: "x" }]);
  expect(idle.ok && idle.value.updated.map((e) => e.id)).toEqual([]);
  return first;
}

describe("format の項目", () => {
  const two = board([sec("a", 0, 0), sec("b", 600, 400), sec("c", 0, 800)]);

  test("組み直すときに cols を書かなければ、2 列と同じ結果", () => {
    expect(format(two).doc.elements).toEqual(format(two, 2).doc.elements);
  });

  test.each([[1], [FORMAT_MAX_COLS]])("組み直すときの cols の %d は通る", (cols) => {
    expect(applyOps(two, [{ op: "format", rebuild: true, cols }]).ok).toBe(true);
  });

  test.each([
    ["rebuild: false は、揃える", { rebuild: false }],
    ["何も書かなければ、揃える", {}],
  ])("%s", (_name, extra) => {
    const r = applyOps(two, [{ op: "format", ...extra }]);
    const plan = planAlign(two.elements);
    expect(r.ok && plan.ok && r.value.updated).toEqual(plan.ok ? plan.value.moved : []);
  });

  test.each([
    ["0", { rebuild: true, cols: 0 }, "format の cols は 1〜6 の整数: 0"],
    ["上限より大きい", { rebuild: true, cols: 7 }, "format の cols は 1〜6 の整数: 7"],
    ["小数", { rebuild: true, cols: 1.5 }, "format の cols は 1〜6 の整数: 1.5"],
    ["文字列", { rebuild: true, cols: "2" }, 'format の cols は 1〜6 の整数: "2"'],
    ["null", { rebuild: true, cols: null }, "format の cols は 1〜6 の整数: null"],
    ["揃えるときの cols", { cols: 2 }, "format の cols は、組み直すとき（\"rebuild\": true。CLI では --rebuild）だけ書ける"],
    ["rebuild: false と cols", { rebuild: false, cols: 2 }, "format の cols は、組み直すとき"],
    ["揃えるときの、範囲の外の cols も、範囲より先に、書けないことを言う", { cols: 0 }, "format の cols は、組み直すとき"],
    ["真偽でない rebuild", { rebuild: "true" }, 'format の rebuild は true か false: "true"'],
    ["rebuild に 1", { rebuild: 1, cols: 2 }, "format の rebuild は true か false: 1"],
    ["知らない項目", { col: 2 }, "format に col は無い"],
    ["dry-run を操作に書いた", { rebuild: true, cols: 2, dryRun: true }, "format に dryRun は無い"],
  ])("%s は断る", (_name, extra, message) => {
    expect(errorOf(two, [{ op: "format", ...extra }])).toContain(`ops[0]: ${message}`);
  });

  test("揃えるときの cols を断る文の直し方（rebuild: true を足す）を当てると、通る", () => {
    expect(applyOps(two, [{ op: "format", rebuild: true, cols: 2 }]).ok).toBe(true);
  });

  test.each([[{ op: "format" }], [{ op: "format", rebuild: true }]])("同じまとまりの別の操作が失敗したら、並べ直しも取りやめる（%o）", (op) => {
    const r = applyOps(two, [op, { op: "rm", id: "none" }]);
    expect(r.ok).toBe(false);
    expect(two.elements.find((e) => e.id === "b")).toMatchObject({ x: 600, y: 400 });
  });
});

describe("下の段は、今の順（上から、同じ高さなら左から）で、列に上から詰める", () => {
  const rows: [string, Raw[], number, Want][] = [
    ["いちばん低い列に入れる", [sec("A", 0, 0, { h: 300 }), sec("B", 600, 0), sec("C", 0, 400), sec("D", 600, 400)], 2, { A: { x: 0, y: 0 }, B: { x: 564, y: 0 }, C: { x: 564, y: 160 }, D: { x: 564, y: 320 } }],
    ["同じ低さなら、左の列", [sec("A", 0, 0), sec("B", 600, 0), sec("C", 300, 900)], 2, { A: { x: 0, y: 0 }, B: { x: 564, y: 0 }, C: { x: 0, y: 160 } }],
    ["列の数より少なければ、横に並ぶ", [sec("A", 0, 0), sec("B", 0, 700)], 6, { A: { x: 0, y: 0 }, B: { x: 564, y: 0 } }],
    ["1 列なら、縦に並ぶ。間は 60", [sec("A", 0, 0, { h: 300 }), sec("B", 900, 0)], 1, { A: { x: 0, y: 0 }, B: { x: 0, y: 360 } }],
    ["列の幅は、いちばん広いセクションの幅。セクションの幅は変えず、左に寄せる", [sec("A", 0, 0), sec("B", 0, 300, { w: 740 }), sec("C", 0, 600)], 2, { A: { x: 0, y: 0, w: 504 }, B: { x: 800, y: 0, w: 740 }, C: { x: 0, y: 160, w: 504 } }],
    ["高さが同じなら、左が先", [sec("R", 900, 0), sec("L", 100, 0, { h: 200 })], 1, { L: { x: 100, y: 0 }, R: { x: 100, y: 260 } }],
    ["高さが 1 でも違えば、上が先（同じ段とみなす幅は無い）", [sec("L", 0, 1), sec("R", 900, 0)], 2, { R: { x: 0, y: 0 }, L: { x: 564, y: 0 } }],
    ["横に 3 つ並んだ真ん中を消した後は、右のセクションが詰まる", [sec("A", 0, 0), sec("C", 1128, 0)], 3, { A: { x: 0, y: 0 }, C: { x: 564, y: 0 } }],
    ["縦に並んだ途中を消した隙間が詰まる", [sec("A", 0, 0), sec("C", 0, 900), sec("D", 0, 1060)], 1, { A: { x: 0, y: 0 }, C: { x: 0, y: 160 }, D: { x: 0, y: 320 } }],
    ["全体の左上は変わらない（負の座標でも）", [sec("A", -300, -200), sec("B", 500, 700)], 2, { A: { x: -300, y: -200 }, B: { x: 264, y: -200 } }],
    ["左上にあるのが下の段の先頭でなくても、起点は、全体の左上", [sec("A", 400, 0), sec("B", 0, 300)], 2, { A: { x: 0, y: 0 }, B: { x: 564, y: 0 } }],
  ];
  test.each(rows)("%s", (_name, els, cols, want) => {
    expectFormatted(board(els), cols, want);
  });

  test("セクションが 1 つだけなら、動かない", () => {
    expect(ids(format(board([sec("A", 40, 70)])))).toEqual([]);
  });
});

describe("組み直すときは、上の段に、固定していないまとめの帯を横に並べる", () => {
  const L = (x: number, y: number, extra: Raw = {}): Raw => sec("L", x, y, { h: 200, locked: true, ...extra });
  const rows: [string, Raw[], number, Want][] = [
    ["今の左からの順で、上の端をそろえ、間を 60 空ける", [band("s", 0, 300), band("o", 700, 50, { show: "open" })], 2, { s: { x: 0, y: 50 }, o: { x: 540, y: 50 } }],
    ["上の段だけでもよい", [band("s", 0, 0, { w: 300 }), band("o", 900, 40, { show: "open" })], 2, { s: { x: 0, y: 0 }, o: { x: 360, y: 0 } }],
    ["左の端が同じなら、上が先", [band("o", 0, 300, { show: "open" }), band("s", 0, 0)], 2, { s: { x: 0, y: 0 }, o: { x: 540, y: 0 } }],
    ["固定していない帯も、上の段に入る。上の段の間隔は、下の段の列と関係しない", [band("s", 0, 0, { w: 300 }), sec("A", 0, 400), sec("B", 0, 700)], 2, { s: { x: 0, y: 0 }, A: { x: 0, y: BAND_H + 60 }, B: { x: 564, y: BAND_H + 60 } }],
    ["固定したセクションは、動かず、上の段にも入らない。ほかのセクションは、それをよけて置く", [sec("A", 0, 0), sec("B", 600, 0), L(0, 400)], 2, { L: { x: 0, y: 400 }, A: { x: 0, y: 0 }, B: { x: 564, y: 0 } }],
    ["固定したセクションの所へ入るセクションは、その下 60 へよける", [L(0, 0), sec("A", 600, 0), sec("B", 0, 400)], 1, { L: { x: 0, y: 0 }, A: { x: 0, y: 260 }, B: { x: 0, y: 420 } }],
    ["固定した帯は、動かず、上の段に入らない", [band("s", 0, 0, { locked: true }), band("o", 900, 300, { show: "open" }), sec("A", 0, 900)], 1, { s: { x: 0, y: 0 }, o: { x: 0, y: 300 }, A: { x: 0, y: 300 + BAND_H + 60 } }],
  ];
  test.each(rows)("%s", (_name, els, cols, want) => {
    expectFormatted(board(els), cols, want);
  });

  test("帯の高さは、要素に書かれていなくても、行の数から測る", () => {
    const doc = board([band("s", 0, 0), sec("A", 0, 900), note("n1", 24, 960, { status: "decided", h: 30 }), note("n2", 260, 960, { status: "decided", h: 30 }), note("n3", 24, 1000, { status: "decided", h: 30 })]);
    expect(format(doc).doc.elements.find((e) => e.id === "A")).toMatchObject({ x: 0, y: summaryHeight(3) + 60 });
  });
});

describe("セクションを動かすと、枠の中に中心がある要素が、同じだけ、1 回だけ動く", () => {
  // S は (0,500) から (0,160) へ、340 だけ上がる。右の辺は x=504
  const base = [sec("A", 0, 0), sec("S", 0, 500, { h: 400 })];
  const rows: [string, Raw[], Want][] = [
    ["付箋", [note("a", 24, 552)], { a: { x: 24, y: 212 } }],
    ["固定した付箋", [note("a", 24, 552, { locked: true })], { a: { x: 24, y: 212 } }],
    ["文字、表、画像、ガント", [{ id: "t", type: "text", x: 24, y: 560, text: "x" }, { id: "tb", type: "table", x: 24, y: 600, rows: [["a"]] }, { id: "im", type: "image", x: 200, y: 600, w: 100, h: 100, src: "x.png" }], { t: { y: 220 }, tb: { y: 260 }, im: { y: 260 } }],
    ["範囲のコメント", [{ id: "k", type: "comment", x: 30, y: 560, w: 80, h: 60 }], { k: { x: 30, y: 220 } }],
    ["枠の外にあって、中身を指すコメント", [note("a", 24, 552), { id: "k", type: "comment", x: 700, y: 520, on: "a" }], { a: { y: 212 }, k: { x: 700, y: 180 } }],
    ["手書きの線", [{ id: "l", type: "stroke", points: [[30, 560], [90, 600]] }], { l: { points: [[30, 220], [90, 260]] } }],
    ["両端を座標で書いた矢印", [{ id: "r", type: "arrow", from: [30, 560], to: [200, 700] }], { r: { from: [30, 220], to: [200, 360] } }],
    ["中のセクションと、その中身", [sec("in", 100, 650, { w: 200 }), note("a", 110, 690, { w: 100, h: 40 })], { in: { x: 100, y: 310 }, a: { x: 110, y: 350 } }],
    ["中心がちょうど枠の辺の上の付箋", [note("a", 454, 600, { w: 100 })], { a: { x: 454, y: 260 } }],
    ["枠の中の、まとめの帯（上の段に並べず、セクションと動かす）", [band("s", 24, 560, { w: 300 })], { s: { x: 24, y: 220 } }],
  ];
  test.each(rows)("%s", (_name, els, want) => {
    expectFormatted(board([...base, ...els]), 1, { S: { x: 0, y: 160 }, ...want });
  });

  test("一部がかかるだけで、中心が外の付箋は、動かない", () => {
    const first = expectFormatted(board([...base, note("a", 460, 700, { w: 100 })]), 1, { S: { x: 0, y: 160 }, a: { x: 460, y: 700 } });
    expect(ids(first)).toEqual(["S"]);
  });

  test("移る先に、まだ動かす前の別のセクションの枠があっても、中身は混ざらない", () => {
    // C は、B が今ある場所へ移る。b は B と、c は C と、同じだけ動く
    const doc = board([sec("A", 0, 0), sec("B", 0, 160, { h: 300 }), note("b", 24, 220), sec("C", 0, 520), note("c", 24, 530, { h: 40 })]);
    expectFormatted(doc, 2, { B: { x: 564, y: 0 }, b: { x: 588, y: 60 }, C: { x: 0, y: 160 }, c: { x: 24, y: 170 } });
  });

  test("動いたセクションと、その中身の全部が updated に入る。動かなかった要素は入らない。並びは変わらない", () => {
    const doc = board([sec("A", 0, 0), note("a", 24, 40, { h: 40 }), sec("S", 0, 500, { h: 400 }), note("m", 24, 552), { id: "k", type: "comment", x: 30, y: 560, w: 80, h: 60 }, note("far", 3000, 0)]);
    const res = format(doc, 1);
    expect(ids(res)).toEqual(["S", "k", "m"]);
    expect(res.added).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(res.order).toBeUndefined();
    expect(res.doc.elements.map((e) => e.id)).toEqual(doc.elements.map((e) => e.id));
  });
});

describe("列で並べるセクション（cols）", () => {
  const cols = (id: string, x: number, y: number, extra: Raw = {}): Raw => ({ id, type: "container", x, y, w: 504, cols: 2, ...extra });
  const into = (section: string, el: Raw) => ({ op: "add", in: section, el: { type: "shape", ...el } });
  // s は、付箋 3 枚で高さ 328（52 + 110 + 16 + 110 + 24… の並び）。t の下にある
  const filled = build([add(sec("A", 0, 0)), add(cols("s", 0, 600)), into("s", { id: "a" }), into("s", { id: "b" }), into("s", { id: "c" })]);

  test("中身ごと動き、列の並びは変わらない", () => {
    const h = filled.elements.find((e) => e.id === "s")?.h;
    expectFormatted(filled, 1, { s: { x: 0, y: 160, h }, a: { x: 24, y: 212 }, b: { x: 260, y: 212 }, c: { x: 24, y: 338 } });
  });

  test("背の違う行があっても、移った後に、位置から並ぶ順を読み直さない", () => {
    const doc = build([add(sec("A", 0, 0)), add(cols("s", 0, 600)), into("s", { id: "a", h: 40 }), into("s", { id: "T", h: 200 }), into("s", { id: "c" }), into("s", { id: "d" })]);
    const before = doc.elements.map((e) => e.id);
    const res = expectFormatted(doc, 1, { a: { x: 24, y: 212 }, T: { x: 260, y: 212 }, c: { x: 24, y: 428 } });
    expect(res.doc.elements.map((e) => e.id)).toEqual(before);
  });

  test("同じまとまりで in で足して伸びた後は、伸びた高さで詰める", () => {
    const doc = build([add(cols("s", 0, 0)), add(sec("B", 0, 300))]);
    const res = build([into("s", { id: "a" }), { op: "format", rebuild: true, cols: 1 }], doc);
    expect(res.elements.find((e) => e.id === "s")).toMatchObject({ h: 186 });
    expect(res.elements.find((e) => e.id === "B")).toMatchObject({ x: 0, y: 246 });
  });

  test("同じまとまりで、format の後に in で足すと、移った先で伸び、下を押し下げる", () => {
    const doc = build([add(sec("A", 0, 0)), add(cols("s", 0, 500)), add(sec("B", 0, 900))]);
    const res = build([{ op: "format", rebuild: true, cols: 1 }, into("s", { id: "a" })], doc);
    expect(res.elements.find((e) => e.id === "s")).toMatchObject({ y: 160, h: 186 });
    expect(res.elements.find((e) => e.id === "a")).toMatchObject({ x: 24, y: 212 });
    expect(res.elements.find((e) => e.id === "B")).toMatchObject({ y: 406 });
  });

  test("中身が無く、題名の帯だけに畳まれたセクションは、高さ 52 で詰める", () => {
    expectFormatted(board([cols("s", 0, 0), sec("B", 0, 500)]), 1, { s: { y: 0, h: 52 }, B: { y: 112 } });
  });
});

describe("セクションに入っていない要素は、動かさない。場所をふさぐ要素は、障害物としてよける", () => {
  const rows: [string, Raw[], number, Want, string[]][] = [
    ["離れた所の付箋は、動かず、動いた一覧に入らない", [sec("A", 0, 0), sec("B", 0, 500), note("n", 3000, 0)], 1, { B: { y: 160 }, n: { x: 3000, y: 0 } }, ["B"]],
    ["固定した付箋も同じ", [sec("A", 0, 0), sec("B", 0, 500), note("n", 3000, 0, { locked: true })], 1, { n: { x: 3000, y: 0 } }, ["B"]],
    ["列の中の付箋の下へ、間を 60 空けて置く", [sec("A", 0, 0), note("n", 100, 200), sec("B", 0, 900)], 1, { n: { x: 100, y: 200 }, B: { x: 0, y: 370 } }, ["B"]],
    ["文字と表も障害物", [sec("A", 0, 0), { id: "t", type: "table", x: 100, y: 200, rows: [["a"]] }, sec("B", 0, 900)], 1, { B: { y: 295 } }, ["B"]],
    ["列との間が 60 より狭い、横の付箋もよける", [sec("A", 0, 0), note("n", 550, 200), sec("B", 0, 900)], 1, { B: { y: 370 } }, ["B"]],
    ["列からちょうど 60 離れた付箋は、よけない", [sec("A", 0, 0), note("n", 564, 200), sec("B", 0, 900)], 1, { B: { y: 160 } }, ["B"]],
    ["よけた列より、別の列のほうが上に置けるなら、そちらに置く", [sec("A", 0, 0), note("n", 100, 200), sec("B", 0, 900)], 2, { B: { x: 564, y: 0 } }, ["B"]],
    ["線、コメント、座標の矢印は、障害物にしない。動かさない", [sec("A", 0, 0), { id: "l", type: "stroke", points: [[100, 200], [200, 240]] }, { id: "k", type: "comment", x: 100, y: 220, w: 80, h: 30 }, { id: "r", type: "arrow", from: [300, 200], to: [400, 240] }, sec("B", 0, 900)], 1, { B: { y: 160 }, l: { points: [[100, 200], [200, 240]] }, k: { x: 100, y: 220 }, r: { from: [300, 200] } }, ["B"]],
    ["上の段は、段ごと、障害物の下へ飛ばす（上の端をそろえたまま）", [band("s", 0, 0, { w: 300 }), band("o", 900, 0, { show: "open", w: 300 }), note("n", 400, 0)], 2, { s: { x: 0, y: 170 }, o: { x: 360, y: 170 }, n: { x: 400, y: 0 } }, ["o", "s"]],
    ["まとめの帯は、障害物にしない（上の段に並べる）", [sec("A", 0, 300), band("s", 100, 0)], 1, { s: { x: 0, y: 0 }, A: { x: 0, y: BAND_H + 60 } }, ["A", "s"]],
    ["動かさない付箋が左上にあっても、起点は、並べる要素の左上", [note("n", -500, -500), sec("A", 0, 0), sec("B", 0, 500)], 1, { A: { x: 0, y: 0 }, B: { y: 160 } }, ["B"]],
    ["コメントだけが左上にはみ出していても、起点は変わらない", [sec("A", 0, 0), { id: "k", type: "comment", x: -50, y: -50, w: 80, h: 80 }, sec("B", 0, 500)], 1, { A: { x: 0, y: 0 }, k: { x: -50, y: -50 } }, ["B"]],
    ["先頭のセクションは、障害物をよけても、左の端の列に置く（全体の左上を保つ）", [sec("A", 0, 0), note("n", 100, -300), sec("B", 600, 0)], 2, { A: { x: 0, y: 0 }, B: { x: 564, y: 0 } }, ["B"]],
    ["先頭のセクションが、今の場所で障害物に近ければ、下へよける", [note("n", 100, -100), sec("A", 0, 20), sec("B", 600, 500)], 2, { A: { x: 0, y: 70 }, B: { x: 564, y: 70 } }, ["A", "B"]],
    ["障害物をよけて下に置いた後のセクションは、それより上には置かない", [sec("A", 0, 0, { h: 300 }), note("n", 600, 100), sec("B", 0, 400), sec("C", 0, 600, { h: 30 })], 2, { A: { x: 0, y: 0 }, B: { x: 564, y: 270 }, C: { x: 0, y: 360 } }, ["B", "C"]],
  ];
  test.each(rows)("%s", (_name, els, cols, want, moved) => {
    expect(ids(expectFormatted(board(els), cols, want))).toEqual(moved);
  });
});

describe("矢印", () => {
  // S は (0,500) から (0,160) へ、340 だけ上がる
  const base = [sec("A", 0, 0), sec("S", 0, 500, { h: 400 }), note("a", 24, 552, { w: 100, h: 60 }), note("b", 300, 700, { w: 100, h: 60 })];
  const arrow = (extra: Raw): Raw => ({ id: "r", type: "arrow", from: "a", to: "b", ...extra });
  const rows: [string, Raw[], Want, string[]][] = [
    ["同じセクションの 2 つを結ぶ矢印は、書き換えない。動いた一覧に入らない", [arrow({})], { r: { from: "a", to: "b" } }, ["S", "a", "b"]],
    ["動いたセクションと、動かなかったセクションの要素を結ぶ矢印も、書き換えない", [note("o", 24, 20, { w: 100, h: 40 }), arrow({ to: "o", route: "elbow", bends: [200] })], { r: { bends: [200] } }, ["S", "a", "b"]],
    ["片方が座標の矢印は、座標の端が枠の中なら、同じだけ動く", [arrow({ to: [200, 800] })], { r: { from: "a", to: [200, 460] } }, ["S", "a", "b", "r"]],
    ["座標の端が枠の外なら、動かない", [arrow({ to: [900, 800] })], { r: { to: [900, 800] } }, ["S", "a", "b"]],
    ["両端が同じだけ動いた矢印の折れ目は、同じだけずらす（左右へ出るなら x・y の順）", [arrow({ route: "elbow", fromSide: "right", bends: [200, 650] })], { r: { bends: [200, 310] } }, ["S", "a", "b", "r"]],
    ["上下へ出る折れ目は、y・x の順", [arrow({ route: "elbow", fromSide: "bottom", bends: [650, 200, 700] })], { r: { bends: [310, 200, 360] } }, ["S", "a", "b", "r"]],
    ["出る辺を書いていなければ、相手のいる向きから読む（b は a の右）", [arrow({ route: "elbow", bends: [200, 650] })], { r: { bends: [200, 310] } }, ["S", "a", "b", "r"]],
    ["相手のいる向きは、要素の中心どうしで読む（b は a の右下で、横に遠い）", [note("c", 130, 700, { w: 300, h: 60 }), arrow({ to: "c", route: "elbow", bends: [200, 650] })], { r: { bends: [200, 310] } }, ["S", "a", "b", "c", "r"]],
    ["座標の端を持つ矢印の折れ目も、同じだけずらす", [arrow({ to: [200, 800], route: "elbow", fromSide: "bottom", bends: [700] })], { r: { to: [200, 460], bends: [360] } }, ["S", "a", "b", "r"]],
  ];
  test.each(rows)("%s", (_name, els, want, moved) => {
    expect(ids(expectFormatted(board([...base, ...els]), 1, { S: { y: 160 }, ...want }))).toEqual(moved);
  });

  test("横に動いたセクションの中の折れ目は、x がずれる", () => {
    const doc = board([sec("A", 0, 0), sec("S", 0, 500, { h: 400 }), note("a", 24, 552, { w: 100, h: 60 }), note("b", 300, 700, { w: 100, h: 60 }), { id: "r", type: "arrow", from: "a", to: "b", route: "elbow", fromSide: "right", bends: [200, 650] }]);
    expectFormatted(doc, 2, { S: { x: 564, y: 0 }, r: { bends: [764, 150] } });
  });
});

describe("並べるものが無いボード", () => {
  test.each([
    ["空のボード", []],
    ["付箋だけ", [note("a", 0, 0), note("b", 500, 300)]],
    ["帯が 1 つだけ", [band("s", 40, 70)]],
  ])("%s は、断らず、何も動かない", (_name, els) => {
    expect(ids(format(board(els)))).toEqual([]);
  });
});

describe("枠が重なるセクション", () => {
  // n は B だけの中身
  const lapped = board([sec("A", 0, 0, { h: 300 }), sec("B", 400, 200, { h: 300 }), note("n", 600, 400, { w: 80, h: 60 })]);

  test("重なる相手の id を付けて断る", () => {
    expect(errorOf(lapped, [{ op: "format", rebuild: true }])).toContain("ops[0]: セクション A と B の枠が重なっている");
  });

  test("断る文に書いた直し方（枠と、cols の無いセクションの中身を、同じだけ set で動かす）を当てると、通り、中身はセクションと動く", () => {
    const fixed = build([{ op: "set", id: "B", patch: { x: 700 } }, { op: "set", id: "n", patch: { x: 900 } }], lapped);
    const r = applyOps(fixed, [{ op: "format", rebuild: true }]);
    expect(r.ok && r.value.doc.elements.filter((e) => e.id === "B" || e.id === "n").map((e) => [e.x, e.y])).toEqual([[564, 0], [764, 200]]);
  });

  test("同じ枠の 2 つのセクションも断る（どちらが外側かを決められない）", () => {
    expect(errorOf(board([sec("A", 0, 0), sec("B", 0, 0)]), [{ op: "format", rebuild: true }])).toContain("A と B の枠が重なっている");
  });

  test.each([
    ["左のセクションが先", [sec("A", 0, 0), sec("B", 504, 0)]],
    ["右のセクションが先", [sec("B", 504, 0), sec("A", 0, 0)]],
  ])("接するだけなら、重なりに数えない（%s）", (_name, els) => {
    expectFormatted(board(els), 2, { A: { x: 0 }, B: { x: 564 } });
  });

  test("左の辺がそろった中のセクションも、外のセクションと一緒に動く", () => {
    expectFormatted(board([sec("X", 0, 0), sec("O", 0, 500, { h: 400 }), sec("I", 0, 600, { w: 200 })]), 2, { O: { x: 564, y: 0 }, I: { x: 564, y: 100 } });
  });

  test("枠に収まった中のセクションは、外のセクションと一緒に動き、並べる対象にしない", () => {
    const doc = board([sec("X", 0, 0), sec("O", 0, 500, { h: 400 }), sec("I", 50, 600, { w: 200 }), sec("J", 60, 620, { w: 100, h: 50 })]);
    expect(ids(expectFormatted(doc, 2, { O: { x: 564, y: 0 }, I: { x: 614, y: 100 }, J: { x: 624, y: 120 } }))).toEqual(["I", "J", "O"]);
  });
});

describe("ほかの操作と同じまとまりに書く", () => {
  test("場所を書かない add で足したセクションも、並べる", () => {
    const doc = board([sec("A", 0, 0), sec("B", 0, 500)]);
    const res = build([add({ id: "N", type: "container", w: 504, h: 100 }), { op: "format", rebuild: true, cols: 2 }], doc);
    // N は全体の右（564,0）に置かれてから、順（上から、左から）で 2 番めになる
    expect(res.elements.find((e) => e.id === "N")).toMatchObject({ x: 564, y: 0 });
    expect(res.elements.find((e) => e.id === "B")).toMatchObject({ x: 0, y: 160 });
  });

  test("format の後の compact では、何も変わらない", () => {
    const done = format(board([band("s", 0, 0), sec("L", 900, 0, { locked: true, h: 200 }), sec("A", 0, 900, { h: 300 }), sec("B", 0, 1300), sec("C", 0, 1500)])).doc;
    const r = applyOps(done, [{ op: "compact" }]);
    expect(r.ok && r.value.updated.map((e) => e.id)).toEqual([]);
  });

  test("付箋に状態を付けて帯が伸びる操作と同じまとまりなら、伸びた高さで下の段を置く", () => {
    const doc = board([band("s", 0, 0), sec("A", 0, 400, { h: 300 }), note("n1", 24, 460, { status: "decided", h: 40 }), note("n2", 24, 510, { h: 40 }), note("n3", 24, 560, { h: 40 })]);
    const res = build([{ op: "set", id: "n2", patch: { status: "decided" } }, { op: "set", id: "n3", patch: { status: "decided" } }, { op: "format", rebuild: true }], doc);
    expect(res.elements.find((e) => e.id === "A")).toMatchObject({ y: summaryHeight(3) + 60 });
  });

  test("format で動かした、列で並べるセクションに、同じまとまりで別のセクションを重ねる操作は断る", () => {
    const doc = board([sec("A", 0, 0), { id: "s", type: "container", x: 0, y: 500, w: 504, cols: 2 }, sec("B", 2000, 0)]);
    expect(errorOf(doc, [{ op: "format", rebuild: true, cols: 1 }, { op: "set", id: "B", patch: { x: 100, y: 330 } }])).toContain("重なる");
  });
});

describe("planRebuild は、ボードを書き換えずに、動かした後の要素を返す", () => {
  test("渡した要素は変わらず、返る要素は、操作（format）で動く要素と同じ", () => {
    const doc = board([sec("A", 0, 0), sec("B", 0, 500), note("b", 24, 552), band("s", 900, 300)]);
    const snapshot = structuredClone(doc.elements);
    const plan = planRebuild(doc.elements, 2);
    expect(doc.elements).toEqual(snapshot);
    expect(plan.ok && plan.value.moved).toEqual(format(doc, 2).updated);
  });
});

// ---- 揃える（既定） ----

/** 見出しの文字（幅 200。横の中心は x + 100） */
const head = (id: string, x: number, y: number): Raw => ({ id, type: "text", x, y, w: 200, text: "見出し" });
/** 見出しの文字の高さ */
const TH = boxOf(parseOk(head("t", 0, 0)))?.h ?? 0;
function parseOk(raw: Raw): El {
  const r = parseEl(raw);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function align(doc: Doc): Applied {
  const r = applyOps(doc, [{ op: "format" }]);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
/** 揃えた結果が期待どおりで、動いた id が moved と同じ。もう一度かけても、関係のない操作をしても、何も動かない */
function expectAligned(doc: Doc, want: Want, moved: string[]): Applied {
  const first = align(doc);
  for (const [id, w] of Object.entries(want)) expect(first.doc.elements.find((e) => e.id === id)).toMatchObject(w);
  expect(ids(first)).toEqual([...moved].sort());
  const again = align(first.doc);
  expect(ids(again)).toEqual([]);
  expect(again.doc.elements).toEqual(first.doc.elements);
  const idle = applyOps(first.doc, [{ op: "title", title: "x" }]);
  expect(idle.ok && idle.value.updated.map((e) => e.id)).toEqual([]);
  return first;
}
type Row = [string, Raw[], Want, string[]];

describe("揃える: 確かめる形", () => {
  // 前                    後
  // A1 B1 C1              A1 B1 C1
  //    B2                 A2 B2 C2
  //       C2
  // A2
  const bands3 = [band("s1", 0, 0), band("s2", 540, 0, { show: "todo" }), band("s3", 1080, 0, { show: "open" })];
  const shape = [sec("A1", 0, 0), sec("B1", 600, 0), sec("C1", 1200, 0), sec("B2", 600, 200), sec("C2", 1200, 400), sec("A2", 0, 600)];
  const rows: Row[] = [
    ["列の数と列の中の順を保ち、列ごとに上から間 60 で詰める", shape, { A1: { x: 0, y: 0 }, A2: { x: 0, y: 160 }, B1: { x: 564, y: 0 }, B2: { x: 564, y: 160 }, C1: { x: 1128, y: 0 }, C2: { x: 1128, y: 160 } }, ["A2", "B1", "B2", "C1", "C2"]],
    ["段は揃えない。列ごとに、上から詰めた位置になる", [sec("A1", 0, 0, { h: 300 }), sec("A2", 0, 500), sec("B1", 600, 0), sec("B2", 600, 400)], { A2: { x: 0, y: 360 }, B2: { x: 564, y: 160 } }, ["A2", "B1", "B2"]],
    ["見出しの付いた列（経営会議の形）。見出しも列の先頭と一緒に動く", [...shape, head("hA", 0, -40 - TH), head("hB", 600, -40 - TH), head("hC", 1200, -40 - TH)], { hA: { x: 0, y: -40 - TH }, hB: { x: 564, y: -40 - TH }, hC: { x: 1128, y: -40 - TH } }, ["A2", "B1", "B2", "C1", "C2", "hB", "hC"]],
    ["帯の下に大きく空いた議題の列も、帯の下 60 まで上がる", [...bands3, sec("A", 0, 360), sec("B", 564, 360)], { A: { x: 0, y: BAND_H + 60 }, B: { x: 564, y: BAND_H + 60 } }, ["A", "B"]],
    ["帯の右にはみ出した列（帯の下に無い列）は、帯の上の端に揃う", [...bands3, sec("A", 0, 300), sec("B", 564, 300), sec("C", 1128, 300), sec("D", 1700, 300)], { A: { y: BAND_H + 60 }, C: { x: 1128, y: BAND_H + 60 }, D: { x: 1692, y: 0 } }, ["A", "B", "C", "D"]],
    ["セクションが 1 つだけでも、帯の下に空いていれば上がる", [band("s1", 0, 0), sec("A", 0, 500)], { A: { x: 0, y: BAND_H + 60 } }, ["A"]],
    ["帯の無いボードは、セクションのいちばん上に揃う", [sec("A", 0, 300), sec("B", 564, 500)], { A: { y: 300 }, B: { y: 300 } }, ["B"]],
    ["帯 3 つを上に、議題 2 列をその下に。帯は動かず、議題は 2 列のまま詰まる", [...bands3, sec("A", 12, 400), sec("A2", 0, 800), sec("B", 588, 300)], { s1: { x: 0, y: 0 }, s2: { x: 540, y: 0 }, s3: { x: 1080, y: 0 }, A: { x: 0, y: BAND_H + 60 }, A2: { x: 0, y: BAND_H + 220 }, B: { x: 564, y: BAND_H + 60 } }, ["A", "A2", "B"]],
    ["議題の列が帯 3 と横に重なっても、帯は議題の列に入らない", [...bands3, sec("A", 0, 300), sec("B", 600, 300), sec("B2", 600, 700)], { s2: { x: 540, y: 0 }, s3: { x: 1080, y: 0 }, A: { x: 0, y: BAND_H + 60 }, B: { x: 564, y: BAND_H + 60 }, B2: { x: 564, y: BAND_H + 220 } }, ["A", "B", "B2"]],
    ["議題の列の先頭は、帯の下の端から 60 より上に置かない", [...bands3, sec("A", 0, 100), sec("B", 564, 400)], { A: { x: 0, y: BAND_H + 60 }, B: { x: 564, y: BAND_H + 60 } }, ["A", "B"]],
  ];
  test.each(rows)("%s", (_name, els, want, moved) => {
    expectAligned(board(els), want, moved);
  });
});

describe("揃える: 列を読む", () => {
  const rows: Row[] = [
    ["横の範囲が 1 でも重なれば、同じ列", [sec("A", 0, 0), sec("B", 503, 300)], { A: { x: 0, y: 0 }, B: { x: 0, y: 160 } }, ["B"]],
    ["横の範囲が接するだけなら、別の列", [sec("A", 0, 0), sec("B", 504, 300)], { A: { x: 0, y: 0 }, B: { x: 564, y: 0 } }, ["B"]],
    ["重なりのつながりで 1 つの列にする（A と C は直接は重ならない）", [sec("A", 0, 0), sec("B", 400, 200), sec("C", 800, 400)], { B: { x: 0, y: 160 }, C: { x: 0, y: 320 } }, ["B", "C"]],
    ["列は左の端の順。要素の並びと上下には関わらない", [sec("R", 900, 0), sec("L", 0, 500)], { L: { x: 0, y: 0 }, R: { x: 564, y: 0 } }, ["L", "R"]],
    ["列の中は上の端の順。要素の並びには関わらない", [sec("B", 0, 300), sec("A", 100, 0)], { A: { x: 0, y: 0 }, B: { x: 0, y: 160 } }, ["A", "B"]],
  ];
  test.each(rows)("%s", (_name, els, want, moved) => {
    expectAligned(board(els), want, moved);
  });

  test.each([
    ["空のボード", []],
    ["付箋と文字だけ", [note("n", 0, 0), head("t", 0, 300)]],
    ["セクションが 1 つだけ", [sec("A", 40, 70)]],
  ])("%s は、断らず、何も動かない", (_name, els) => {
    expect(ids(align(board(els)))).toEqual([]);
  });
});

describe("揃える: 列の位置と縦の間", () => {
  const rows: Row[] = [
    ["いちばん左の列は、列の中でいちばん左の左端に揃う", [sec("B", 0, 300), sec("A", 100, 0)], { A: { x: 0 }, B: { x: 0 } }, ["A", "B"]],
    ["次の列は、前の列でいちばん幅の広いものの右の端から 60。幅は変えない", [sec("A", 0, 0), sec("B", 0, 300, { w: 740 }), sec("C", 1000, 0)], { B: { x: 0, y: 160, w: 740 }, C: { x: 800, y: 0 } }, ["B", "C"]],
    ["横の間が 61 なら 60 に詰める", [sec("A", 0, 0), sec("B", 565, 0)], { B: { x: 564 } }, ["B"]],
    ["横の間が 59 なら 60 に広げる", [sec("A", 0, 0), sec("B", 563, 0)], { B: { x: 564 } }, ["B"]],
    ["縦の間が 61 なら 60 に詰める", [sec("A", 0, 0), sec("B", 0, 161)], { B: { y: 160 } }, ["B"]],
    ["縦の間が 59 なら 60 に広げる", [sec("A", 0, 0), sec("B", 0, 159)], { B: { y: 160 } }, ["B"]],
    ["列の先頭は、全体の上の端に揃う", [sec("A", 0, 0), sec("B", 600, 250)], { B: { x: 564, y: 0 } }, ["B"]],
    ["負の座標でも、1 列めの左の端と全体の上の端は変わらない", [sec("A", -300, -200), sec("B", 500, 700)], { A: { x: -300, y: -200 }, B: { x: 264, y: -200 } }, ["B"]],
  ];
  test.each(rows)("%s", (_name, els, want, moved) => {
    expectAligned(board(els), want, moved);
  });

  test.each([
    ["横の間がちょうど 60", [sec("A", 0, 0), sec("B", 564, 0)]],
    ["縦の間がちょうど 60", [sec("A", 0, 0), sec("B", 0, 160)]],
  ])("%s なら、何も動かない", (_name, els) => {
    expect(ids(align(board(els)))).toEqual([]);
  });
});

describe("揃える: 障害物", () => {
  const rows: Row[] = [
    ["置く場所が付箋に近ければ、付箋の下の端から 60 まで下げる", [sec("A", 0, 0), sec("B", 0, 500), note("n", 100, 200)], { n: { x: 100, y: 200 }, B: { x: 0, y: 370 } }, ["B"]],
    ["下げたものの下も、その下から続ける", [sec("A", 0, 0), sec("B", 0, 500), note("n", 100, 200), sec("C", 0, 700)], { B: { y: 370 }, C: { y: 530 } }, ["B", "C"]],
    ["横に寄せた先の障害物も、よける", [sec("X", 0, 0), sec("B", 900, 0), note("n", 600, 0)], { B: { x: 564, y: 170 } }, ["B"]],
    ["列の先頭も、全体の上の端で障害物に近ければ下げる", [sec("A", 0, 0), sec("B", 600, 0), note("n", 900, -100, { h: 100 })], { A: { y: 0 }, B: { x: 564, y: 60 } }, ["B"]],
    ["障害物とちょうど 60 離れて置けるなら、下げない", [sec("A", 0, 0), sec("B", 0, 500), note("n", 100, 320)], { B: { y: 160 } }, ["B"]],
    ["障害物と 59 しか離れないなら、下げる", [sec("A", 0, 0), sec("B", 0, 500), note("n", 100, 319)], { B: { y: 489 } }, ["B"]],
    ["表も障害物", [sec("A", 0, 0), { id: "t", type: "table", x: 100, y: 200, rows: [["a"]] }, sec("B", 0, 900)], { B: { y: 295 } }, ["B"]],
    ["固定した付箋も、動かない障害物", [sec("A", 0, 0), sec("B", 0, 500), note("n", 100, 200, { locked: true })], { n: { x: 100, y: 200 }, B: { y: 370 } }, ["B"]],
    ["列の先頭より下にある文字は、見出しでなく障害物", [sec("A", 0, 0), sec("B", 0, 500), head("t", 24, 180)], { t: { x: 24, y: 180 }, B: { y: 240 + TH } }, ["B"]],
    ["線、コメント、座標の矢印は、障害物にしない。動かさない", [sec("A", 0, 0), { id: "l", type: "stroke", points: [[100, 200], [200, 240]] }, { id: "k", type: "comment", x: 100, y: 220, w: 80, h: 30 }, { id: "r", type: "arrow", from: [300, 200], to: [400, 240] }, sec("B", 0, 900)], { B: { y: 160 }, l: { points: [[100, 200], [200, 240]] }, k: { x: 100, y: 220 }, r: { from: [300, 200] } }, ["B"]],
  ];
  test.each(rows)("%s", (_name, els, want, moved) => {
    expectAligned(board(els), want, moved);
  });
});

describe("揃える: 固定したセクションと帯は動かさない", () => {
  const L = (x: number, y: number, extra: Raw = {}): Raw => sec("L", x, y, { h: 200, locked: true, ...extra });
  const rows: Row[] = [
    ["列の途中にある固定したセクションは、動かず、後のものはその下へよける", [sec("A", 0, 0), L(0, 300), sec("B", 0, 700)], { A: { y: 0 }, L: { x: 0, y: 300 }, B: { x: 0, y: 560 } }, ["B"]],
    ["列の先頭の固定したセクションは、動かず、列を読むときにも数えない", [L(0, 0), sec("A", 0, 400), sec("B", 600, 100)], { L: { x: 0, y: 0 }, A: { x: 0, y: 260 }, B: { x: 564, y: 100 } }, ["A", "B"]],
    ["列と列の間の固定したセクションと横が重なっても、列はつながらない", [sec("A", 0, 0), L(300, 400, { w: 600 }), sec("B", 700, 0)], { L: { x: 300, y: 400 }, A: { x: 0, y: 0 }, B: { x: 564, y: 0 } }, ["B"]],
    ["固定したセクションの中身も動かない", [sec("A", 0, 0), L(600, 300), note("n", 624, 352, { w: 100, h: 40 }), sec("B", 1200, 0)], { L: { x: 600, y: 300 }, n: { x: 624, y: 352 }, B: { x: 564, y: 0 } }, ["B"]],
    ["固定した帯は動かず、障害物になる", [band("s", 0, 0, { locked: true }), sec("A", 0, 500), sec("B", 600, 0)], { s: { x: 0, y: 0 }, A: { x: 0, y: BAND_H + 60 }, B: { x: 564, y: 0 } }, ["A", "B"]],
  ];
  test.each(rows)("%s", (_name, els, want, moved) => {
    expectAligned(board(els), want, moved);
  });

  test("組み直すときも、固定したセクションと帯と、その中身は動かない", () => {
    const doc = board([L(0, 300), note("n", 24, 352, { w: 100, h: 40 }), band("s", 900, 900, { locked: true }), sec("A", 2000, 0), sec("B", 2000, 500)]);
    // 起点は、固定していないものの左上（A）。B は A の右の列へ
    const res = expectFormatted(doc, 2, { L: { x: 0, y: 300 }, n: { x: 24, y: 352 }, s: { x: 900, y: 900 }, A: { x: 2000, y: 0 }, B: { x: 2564, y: 0 } });
    expect(ids(res)).toEqual(["B"]);
  });
});

describe("揃える: 見出し", () => {
  // X は動かない。B は (700,300) から (564,0) へ、(-136,-300) 動く。B の横の範囲は 700〜1204
  const base = [sec("X", 0, 0), sec("B", 700, 300)];
  const rows: Row[] = [
    ["間がちょうど 40 なら見出し。列の先頭と同じだけ動く", [head("h", 750, 260 - TH)], { h: { x: 614, y: -40 - TH } }, ["B", "h"]],
    ["間が 1 なら見出し", [head("h", 750, 299 - TH)], { h: { x: 614, y: -1 - TH } }, ["B", "h"]],
    ["間が 41 なら見出しでない。動かない", [head("h", 750, 259 - TH)], { h: { x: 750, y: 259 - TH } }, ["B"]],
    ["間が 0（下の端と先頭の上の端が同じ高さ）なら、見出しでない", [head("h", 750, 300 - TH)], { h: { x: 750, y: 300 - TH } }, ["B"]],
    ["横の中心が先頭の右の端ちょうどなら、見出し", [head("h", 1104, 280 - TH)], { h: { x: 968, y: -20 - TH } }, ["B", "h"]],
    ["横の中心が先頭の右の端から 1 外なら、見出しでない", [head("h", 1105, 280 - TH)], { h: { x: 1105 } }, ["B"]],
    ["横の中心が先頭の左の端ちょうどなら、見出し", [head("h", 600, 280 - TH)], { h: { x: 464, y: -20 - TH } }, ["B", "h"]],
    ["横の中心が先頭の左の端から 1 外なら、見出しでない", [head("h", 599, 280 - TH)], { h: { x: 599 } }, ["B"]],
    ["候補が 2 つなら、先頭にいちばん近いものだけ", [head("far", 750, 265 - TH - TH), head("near", 750, 280 - TH)], { near: { x: 614, y: -20 - TH }, far: { x: 750 } }, ["B", "near"]],
    ["候補が 2 つなら、要素の並びに関わらず、先頭にいちばん近いものだけ", [head("near", 750, 280 - TH), head("far", 750, 265 - TH - TH)], { near: { x: 614, y: -20 - TH }, far: { x: 750 } }, ["B", "near"]],
    ["下の端が同じ高さの候補は、要素の並びで先のものだけ", [head("first", 650, 280 - TH), head("second", 850, 280 - TH)], { first: { x: 514, y: -20 - TH }, second: { x: 850 } }, ["B", "first"]],
    ["付箋は、真上 40 以内にあっても見出しにならず、障害物", [note("n", 750, 280 - 110)], { n: { x: 750, y: 170 }, B: { x: 564, y: 0 } }, ["B"]],
  ];
  test.each(rows)("%s", (_name, els, want, moved) => {
    expectAligned(board([...base, ...els]), want, moved);
  });

  test("見出しは障害物にしない（列の先頭が上がる先に、見出しの元の場所があっても、よけない）", () => {
    expectAligned(board([sec("X", 0, 200), sec("B", 700, 300), head("h", 750, 280 - TH)]), { B: { x: 564, y: 200 }, h: { x: 614, y: 180 - TH } }, ["B", "h"]);
  });

  test("列の先頭が障害物で下がったぶんも、見出しは同じだけ動く", () => {
    expectAligned(board([sec("X", 0, 0), sec("A", 600, 300), head("h", 650, 280 - TH), note("n", 900, -100, { h: 100 })]), { A: { x: 564, y: 60 }, h: { x: 614, y: 40 - TH } }, ["A", "h"]);
  });

  // 乱数のテストで見つかった形。文字が、列の先頭の上の辺に 4 だけかかる。
  // 見出しの間を 120 にしていたときは、1 回めで文字の下 60 へよけ、2 回めにその文字が見出しになって、もう一度かけると変わった
  test.each([
    ["上の辺に 4 かかる文字", 4, 64, ["B"]],
    ["間が 41 の文字", -41, 19, ["B"]],
    ["間が 60 の文字（よけた後の形）", -60, 0, []],
  ])("%s は障害物。先頭は、その下 60 より上に置かず、2 回めは変わらない", (_name, bottom, want, moved) => {
    // X は別の列で、全体の上の端（0）を決める
    expectAligned(board([sec("B", 0, 0), sec("X", 600, 0), head("t", 50, bottom - TH)]), { t: { x: 50, y: bottom - TH }, B: { x: 0, y: want } }, ["X", ...moved]);
  });
});

describe("揃える: 帯、入れ子、中身", () => {
  test("帯の高さが違うときは、列ごとに、その上の帯の下 60 に揃う", () => {
    // 帯の高さは、集めた付箋の数（3、1、0）で決まる
    const inA = [1, 2, 3].map((i) => note(`d${i}`, 24, 600 + i * 50, { h: 30, w: 100, status: "decided" }));
    const doc = board([...[band("s1", 0, 0), band("s2", 540, 0, { show: "todo" }), band("s3", 1080, 0, { show: "open" })], sec("A", 0, 600, { h: 300 }), ...inA, sec("B", 564, 700, { h: 300 }), note("t1", 588, 760, { h: 30, w: 100, status: "todo" }), sec("C", 1128, 800)]);
    const first = expectAligned(doc, { A: { x: 0, y: summaryHeight(3) + 60 }, B: { x: 564, y: summaryHeight(1) + 60 }, C: { x: 1128, y: summaryHeight(0) + 60 } }, ["A", "B", "C", "d1", "d2", "d3", "t1"]);
    expect(first.doc.elements.find((e) => e.id === "d1")).toMatchObject({ x: 24, y: summaryHeight(3) + 60 + 50 });
  });

  test("まとめの帯は動かさない障害物。行の数から決まった帯の高さの下 60 へよける", () => {
    // X が全体の上の端（100）を決める。A の列は、帯（行 3 つ）の下へよける
    const doc = board([band("s", 0, 0), sec("A", 0, 900), note("n1", 24, 960, { status: "decided", h: 30 }), note("n2", 260, 960, { status: "decided", h: 30 }), note("n3", 24, 1000, { status: "decided", h: 30 }), sec("X", 600, 100)]);
    const res = align(doc).doc.elements;
    expect(res.find((e) => e.id === "s")).toMatchObject({ x: 0, y: 0 });
    expect(res.find((e) => e.id === "A")).toMatchObject({ x: 0, y: summaryHeight(3) + 60 });
  });

  const rows: Row[] = [
    ["セクションの枠の中の帯は、セクションと動く", [sec("X", 0, 0), sec("S", 700, 300, { h: 400 }), band("s", 724, 360, { w: 300 })], { S: { x: 564, y: 0 }, s: { x: 588, y: 60 } }, ["S", "s"]],
    ["入れ子のセクションは、外と同じだけ動く（列の左の端に揃えない）", [sec("X", 0, 0), sec("O", 0, 500, { h: 400 }), sec("I", 50, 600, { w: 200 }), note("a", 60, 650, { w: 100, h: 40 })], { O: { x: 0, y: 160 }, I: { x: 50, y: 260 }, a: { x: 60, y: 310 } }, ["I", "O", "a"]],
    ["自由に置くセクションの中身（付箋、線）と、中身を指すコメントが、同じだけ動く", [sec("X", 0, 0), sec("S", 700, 300, { h: 400 }), note("a", 724, 352), { id: "l", type: "stroke", points: [[730, 360], [790, 400]] }, { id: "k", type: "comment", x: 1400, y: 320, on: "a" }], { a: { x: 588, y: 52 }, l: { points: [[594, 60], [654, 100]] }, k: { x: 1264, y: 20 } }, ["S", "a", "k", "l"]],
  ];
  test.each(rows)("%s", (_name, els, want, moved) => {
    expectAligned(board(els), want, moved);
  });

  test("列で並べるセクションは、中身ごと動き、列の並びと高さは変わらない", () => {
    const into = (el: Raw) => ({ op: "add", in: "K", el: { type: "shape", ...el } });
    const doc = build([add(sec("X", 0, 0)), add({ id: "K", type: "container", x: 700, y: 300, w: 504, cols: 2 }), into({ id: "a" }), into({ id: "b" })]);
    const h = doc.elements.find((e) => e.id === "K")?.h;
    expectAligned(doc, { K: { x: 564, y: 0, h }, a: { x: 588, y: 52 }, b: { x: 824, y: 52 } }, ["K", "a", "b"]);
  });

  test("同じまとまりで in で足して伸びたセクションは、伸びた高さで揃える", () => {
    const doc = build([add({ id: "s", type: "container", x: 0, y: 0, w: 504, cols: 2 }), add(sec("B", 0, 300))]);
    const res = build([{ op: "add", in: "s", el: { id: "a", type: "shape" } }, { op: "format" }], doc);
    expect(res.elements.find((e) => e.id === "B")).toMatchObject({ x: 0, y: 246 });
  });

  test("枠がかかり合うセクションのあるボードは、揃えるときも断る", () => {
    expect(errorOf(board([sec("A", 0, 0, { h: 300 }), sec("B", 400, 200, { h: 300 })]), [{ op: "format" }])).toContain("ops[0]: セクション A と B の枠が重なっている");
  });
});

describe("planAlign は、ボードを書き換えずに、動かした後の要素を返す", () => {
  test("渡した要素は変わらず、返る要素は、操作（format）で動く要素と同じ", () => {
    const doc = board([sec("A", 0, 0), sec("B", 600, 500), note("b", 624, 552), band("s", 1200, 300), head("h", 650, 480 - TH)]);
    const snapshot = structuredClone(doc.elements);
    const plan = planAlign(doc.elements);
    expect(doc.elements).toEqual(snapshot);
    expect(plan.ok && plan.value.moved).toEqual(align(doc).updated);
  });

  test("断るボードでは ok: false", () => {
    expect(planAlign(board([sec("A", 0, 0, { h: 300 }), sec("B", 400, 200, { h: 300 })]).elements).ok).toBe(false);
  });
});

// ---- 乱数で確かめる決まり ----

const SEEDS = Number(process.env.XWB_FUZZ_SEEDS ?? 150);
const TIMEOUT = 5000 + SEEDS * 80;

/** 乱数で、揃えるか、組み直す（列の数も乱数）かを選ぶ */
const pickOp = (r: () => number, mode: "align" | "rebuild"): FormatOp => (mode === "align" ? { op: "format" } : { op: "format", rebuild: true, cols: 1 + Math.floor(r() * FORMAT_MAX_COLS) });

describe.each([["align"], ["rebuild"]] as const)("乱数のボードでも、並べ直しの決まりが破れない（%s）", (mode) => {
  test("重ならずに置いたボード（セクション、帯、中身、見出し、外の付箋）", () => {
    const broken: unknown[] = [];
    let moved = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      const doc = tidyBoard(r);
      const op = pickOp(r, mode);
      const res = applyOps(doc, [op]);
      // 重ならずに置いたボードは、断られない
      if (!res.ok) {
        broken.push({ seed, op, error: res.error });
        continue;
      }
      if (res.value.updated.length > 0) moved++;
      const kinds = formatViolations(doc, op, true);
      if (kinds.length > 0) broken.push({ seed, op, kinds });
    }
    expect(broken).toEqual([]);
    expect(moved).toBeGreaterThan(SEEDS * 0.8);
  }, TIMEOUT);

  test("座標を乱数で決めたボード（重なり、入れ子、枠にかかる要素あり）", () => {
    const broken: unknown[] = [];
    let accepted = 0;
    for (let seed = 1; seed <= SEEDS * 3; seed++) {
      const r = rng(seed);
      const doc = messyBoard(r);
      const op = pickOp(r, mode);
      if (!applyOps(doc, [op]).ok) continue;
      accepted++;
      const kinds = formatViolations(doc, op, false);
      if (kinds.length > 0) broken.push({ seed, op, kinds });
    }
    expect(broken).toEqual([]);
    expect(accepted).toBeGreaterThan(SEEDS);
  }, TIMEOUT);

  test("エージェントの操作を続けたボードに、どの時点でかけても", () => {
    const broken: unknown[] = [];
    let accepted = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      let doc = emptyDoc("t");
      for (let step = 0; step < 16; step++) {
        const res = applyOps(doc, [agentOp(r, doc, step)]);
        if (res.ok) doc = res.value.doc;
        if (step % 4 !== 3) continue;
        const op = pickOp(r, mode);
        const done = applyOps(doc, [op]);
        if (!done.ok) continue;
        accepted++;
        const kinds = formatViolations(doc, op, false);
        if (kinds.length > 0) {
          broken.push({ seed, step, op, kinds });
          break;
        }
        // 半分は、並べ直した後のボードで続ける
        if (r() < 0.5) doc = done.value.doc;
      }
    }
    expect(broken).toEqual([]);
    expect(accepted).toBeGreaterThan(SEEDS * 2);
  }, TIMEOUT);
});
