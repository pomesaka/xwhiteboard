import { describe, expect, test } from "bun:test";
import { checkBoard } from "./check-style.ts";
import { applyOps, boxOf, emptyDoc, type Doc, type El } from "../src/shared/model.ts";

const cell = (title: string, items: unknown[] = []) => ({ title, items });
const matrix = {
  op: "template",
  kind: "matrix",
  id: "mx",
  title: "誰から巻き込むか",
  xAxis: { label: "やり方を知っているか", low: "知らない", high: "知っている" },
  yAxis: { label: "共感しているか", low: "していない", high: "している" },
  cells: [
    [cell("教える", ["営業の 2 人", { title: "新人", text: "研修から", who: "山田", status: "priority" }, { text: "総務", color: "green" }]), cell("任せる", [{ text: "開発", due: "2026-11-20" }])],
    [cell("後回し"), cell("話を聞く", ["経理"])],
  ],
};
const versus = { op: "template", kind: "versus", id: "vs", title: "単価を上げるか", left: cell("上げる", ["原価が上がった", "他社も上げた"]), right: cell("据え置く", ["更新の直前"]) };
const tree = {
  op: "template",
  kind: "tree",
  id: "tr",
  title: "売上が伸びない理由",
  root: { text: "売上が伸びない", children: [{ text: "客数が少ない", children: ["新規が来ない", "再来が少ない"] }, { text: "単価が低い", children: [{ title: "値引きが多い", status: "open" }] }] },
};
/** 根から 1 列に、節を n 個つないだ木 */
const chain = (n: number): unknown => ({ text: "節", children: n > 1 ? [chain(n - 1)] : [] });

function build(ops: unknown[]): Doc {
  const r = applyOps(emptyDoc("t"), ops);
  if (!r.ok) throw new Error(r.error);
  return r.value.doc;
}

function get(doc: Doc, id: string): El {
  const el = doc.elements.find((e) => e.id === id);
  if (!el) throw new Error(`${id} が無い`);
  return el;
}

/** 全部の要素が入る範囲の、左の端と右の端 */
function span(doc: Doc): { left: number; right: number } {
  const boxes = doc.elements.flatMap((e) => boxOf(e) ?? []);
  return { left: Math.min(...boxes.map((b) => b.x)), right: Math.max(...boxes.map((b) => b.x + b.w)) };
}

describe("型は、ふつうの要素に展開される", () => {
  test.each([
    ["matrix", matrix],
    ["versus", versus],
    ["tree", tree],
    ["幅を狭めた matrix", { ...matrix, w: 740 }],
    ["幅を狭めた versus", { ...versus, w: 740 }],
  ])("%s を展開した結果は、見た目の検査に何もかからない", (_name, op) => {
    expect(checkBoard(build([op]))).toEqual([]);
  });

  test.each([
    ["左上の枠", "mx-tl", { title: "教える" }],
    ["右上の枠", "mx-tr", { title: "任せる" }],
    ["左下の枠", "mx-bl", { title: "後回し" }],
    ["右下の枠", "mx-br", { title: "話を聞く" }],
    ["横の軸の名前（矢印の記号を付けない）", "mx-x", { text: "やり方を知っているか" }],
    ["横の軸の low", "mx-xl", { text: "**知らない**" }],
    ["横の軸の high", "mx-xh", { text: "**知っている**" }],
    ["縦の軸の名前（矢印の記号を付けない）", "mx-y", { text: "共感しているか" }],
    ["縦の軸の low", "mx-yl", { text: "**していない**" }],
    ["縦の軸の high", "mx-yh", { text: "**している**" }],
    ["付箋の欄は、そのまま付箋に入る", "mx-tl-2", { title: "新人", text: "研修から", who: "山田", status: "priority" }],
    ["期限（due）も、付箋の欄として入る", "mx-tr-1", { text: "開発", due: "2026-11-20" }],
    ["色を書かない付箋は白", "mx-tl-1", { text: "営業の 2 人", color: "white" }],
    ["色を書いた付箋は、その色", "mx-tl-3", { text: "総務", color: "green" }],
  ])("matrix の中身: %s", (_name, id, expected) => {
    expect(get(build([matrix]), id)).toMatchObject(expected);
  });

  test.each<[string, string, string, "x" | "y"]>([
    ["左上の枠は、右上の枠より左", "mx-tl", "mx-tr", "x"],
    ["左下の枠は、右下の枠より左", "mx-bl", "mx-br", "x"],
    ["左上の枠は、左下の枠より上", "mx-tl", "mx-bl", "y"],
    ["右上の枠は、右下の枠より上", "mx-tr", "mx-br", "y"],
    ["横の軸は、low が high より左", "mx-xl", "mx-xh", "x"],
    ["縦の軸は、high が low より上", "mx-yh", "mx-yl", "y"],
  ])("matrix の向き: %s", (_name, before, after, axis) => {
    const doc = build([matrix]);
    expect(get(doc, before)[axis] ?? Number.NaN).toBeLessThan(get(doc, after)[axis] ?? Number.NaN);
  });

  test("matrix の横に並ぶ枠は、付箋の多いほうに高さをそろえる", () => {
    const doc = build([matrix]);
    const h = (id: string) => get(doc, id).h;
    expect(h("mx-tl")).toBe(h("mx-tr"));
    expect(h("mx-bl")).toBe(h("mx-br"));
    expect(h("mx-tl")).toBeGreaterThan(h("mx-bl") ?? 0);
  });

  test("tree は、根から順に id を振り、親を子の並びの真ん中の高さに置き、親から子へ線を引く", () => {
    const doc = build([{ op: "template", kind: "tree", id: "tr", root: { text: "根", children: [{ text: "A", children: ["A1", "A2"] }, "B"] } }]);
    expect(doc.elements.filter((e) => e.type === "shape").map(({ id, text, x, y }) => ({ id, text, x, y }))).toEqual([
      // 透明な枠の余白（24）の内側に置く
      { id: "tr-1", text: "根", x: 24, y: 112 },
      { id: "tr-2", text: "A", x: 314, y: 68 },
      { id: "tr-3", text: "A1", x: 604, y: 24 },
      { id: "tr-4", text: "A2", x: 604, y: 112 },
      { id: "tr-5", text: "B", x: 314, y: 200 },
    ]);
    expect(doc.elements.filter((e) => e.type === "arrow").map((e) => `${String(e.from)}→${String(e.to)}`).sort()).toEqual(["tr-1→tr-2", "tr-1→tr-5", "tr-2→tr-3", "tr-2→tr-4"]);
  });

  test.each([
    // 全体は、透明な枠の幅（中身の左右に 24 ずつ）
    ["versus。書かなければ 928", versus, { left: 0, right: 928 }],
    ["versus。w を書けば、その幅", { ...versus, w: 740 }, { left: 0, right: 740 }],
    ["matrix。書かなければ 1014", matrix, { left: 0, right: 1014 }],
    ["matrix。w を書けば、その幅", { ...matrix, w: 740 }, { left: 0, right: 740 }],
  ])("型の全体の幅: %s", (_name, op, expected) => {
    expect(span(build([op]))).toEqual(expected);
  });

  test("場所を書かなければ、今ある中身の右に置く", () => {
    const doc = build([{ op: "add", el: { id: "a", type: "shape", x: 0, y: 0, w: 200, h: 100 } }, versus]);
    expect(Math.min(...doc.elements.filter((e) => e.id !== "a").map((e) => boxOf(e)?.x ?? Infinity))).toBe(260);
  });

  const shape = (id?: string) => ({ op: "add", el: { ...(id === undefined ? {} : { id }), type: "shape", x: 0, y: 0, w: 200, h: 100 } });
  // 番号は、要素の連番（e1、e2…）と共通で、戻らない
  test.each([
    ["何も無ければ tp1", [], "tp1-l"],
    ["id を書かずに足した要素が 2 つあれば、次の番号の tp3", [shape(), shape()], "tp3-l"],
    ["id を書いた要素は、番号を進めない", [shape("a")], "tp1-l"],
    ["tp1 という id の要素があれば tp2", [shape("tp1")], "tp2-l"],
    ["tp1- で始まる id の要素があれば tp2", [shape("tp1-l")], "tp2-l"],
    ["tp10- で始まる id は、tp1 を使っているとみなさない", [shape("tp10-l")], "tp1-l"],
    ["型を 2 回描けば、2 つめは tp2", [{ ...versus, id: undefined, x: 2000, y: 0 }], "tp2-l"],
    ["id を書いた型は、番号を進めない", [{ ...versus, x: 2000, y: 0 }], "tp1-l"],
    [
      "描いた型を全部消しても、同じ番号は使わない（人が消した記録が、別の中身の記録に化けないように）",
      [{ ...versus, id: undefined, x: 2000, y: 0 }, ...["tp1-title", "tp1-l", "tp1-l-1", "tp1-l-2", "tp1-vs", "tp1-r", "tp1-r-1"].map((id) => ({ op: "rm", id }))],
      "tp2-l",
    ],
  ])("id を書かないときの番号: %s", (_name, before, expected) => {
    const doc = build([...before, { ...versus, id: undefined }]);
    expect(doc.elements.filter((e) => e.type === "container").at(-2)?.id).toBe(expected);
  });

  test("展開した枠には、後から in で足せる", () => {
    const doc = build([versus, { op: "add", in: "vs-r", el: { id: "more", type: "shape", text: "足した" } }]);
    // 右の枠の 1 枚め（y 140、高さ 110）の下に、間を 16 空けて入る（透明な枠の余白 24 のぶん、右下にずれている）
    expect(get(doc, "more")).toMatchObject({ x: 528, y: 266, w: 220, h: 110 });
    expect(checkBoard(doc)).toEqual([]);
  });
});

describe("型の、通る境界", () => {
  test.each([
    ["id が 24 文字", { ...versus, id: "a".repeat(24) }],
    ["木の節が 40", { op: "template", kind: "tree", id: "tr", root: chain(40) }],
    // w は、透明な枠の幅。中身の左右に 24 ずつ足す
    ["versus の w が 528（枠の幅が 200）", { ...versus, w: 528 }],
    ["matrix の w が 614（枠の幅が 200）", { ...matrix, w: 614 }],
  ])("%s", (_name, op) => {
    expect(applyOps(emptyDoc("t"), Array.isArray(op) ? op : [op]).ok).toBe(true);
  });
});

describe("型の書き間違いは、理由を付けて断る", () => {
  test.each([
    ["知らない kind", { op: "template", kind: "swot" }, "kind は"],
    ["matrix の cells が 2×2 でない", { ...matrix, cells: [[cell("a")]] }, "2×2"],
    ["matrix の軸に両端が無い", { ...matrix, xAxis: { label: "x" } }, "xAxis は"],
    ["枠に名前が無い", { ...versus, left: { items: [] } }, "left には title"],
    ["付箋に場所を書いた", { ...versus, left: cell("a", [{ text: "x", x: 10 }]) }, "x は書けない"],
    ["付箋に文字が無い", { ...versus, left: cell("a", [{ who: "山田" }]) }, "text か title"],
    ["知らない項目", { ...versus, middle: "x" }, "versus に middle は無い"],
    ["x だけを書いた", { ...versus, x: 10 }, "x と y は"],
    ["同じ id で 2 回", [versus, versus], "はもうある"],
    ["型の id と同じ id の要素がもうある", [{ op: "add", el: { id: "vs", type: "shape", x: 2000, y: 0 } }, versus], "id vs の要素はもうある。型は、この id を、全体を囲む透明な枠に使う"],
    ["付箋の欄の値が違う", { ...versus, left: cell("a", [{ text: "x", status: "done" }]) }, "status は"],
    ["木の根が無い", { op: "template", kind: "tree" }, "root"],
    ["id が 25 文字", { ...versus, id: "a".repeat(25) }, "24 文字まで"],
    ["木の節が 41", { op: "template", kind: "tree", id: "tr", root: chain(41) }, "40 まで"],
    ["木 tr の線（tr-1-2）と、木 tr-1 の節（tr-1-2）は、id がぶつかる", [tree, { ...tree, id: "tr-1" }], "はもうある"],
    ["versus の w が 527（枠の幅が 200 より狭い）", { ...versus, w: 527 }, "w は 528 以上"],
    ["matrix の w が 613（枠の幅が 200 より狭い）", { ...matrix, w: 613 }, "w は 614 以上"],
    // 型の透明な枠の id は、型の id そのもの。木 tr の根（tr-1）と、木 tr-1 の透明な枠（tr-1）がぶつかる
    ["根だけの木 tr と木 tr-1", [{ op: "template", kind: "tree", id: "tr", root: "根" }, { op: "template", kind: "tree", id: "tr-1", root: "根" }], "はもうある"],
    ["w が数値でない", { ...versus, w: "740" }, "w は数値"],
    ["tree に w を書いた", { ...tree, w: 740 }, "tree に w は書けない"],
  ])("%s", (_name, ops, message) => {
    const r = applyOps(emptyDoc("t"), Array.isArray(ops) ? ops : [ops]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});
