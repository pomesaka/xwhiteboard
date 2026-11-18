import { describe, expect, test } from "bun:test";
import { checkBoard } from "../src/shared/check.ts";
import { applyOps, boxOf, emptyDoc, type Doc } from "../src/shared/model.ts";

const cell = (title: string, items: unknown[] = []) => ({ title, items });
const matrix = {
  op: "template",
  kind: "matrix",
  id: "mx",
  title: "誰から巻き込むか",
  xAxis: { label: "やり方を知っているか", low: "知らない", high: "知っている" },
  yAxis: { label: "共感しているか", low: "していない", high: "している" },
  cells: [
    [cell("教える", ["営業の 2 人", { title: "新人", text: "研修から", who: "山田", status: "priority" }, "総務"]), cell("任せる", ["開発"])],
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

function build(ops: unknown[]): Doc {
  const r = applyOps(emptyDoc("t"), ops);
  if (!r.ok) throw new Error(r.error);
  return r.value.doc;
}

describe("型は、ふつうの要素に展開される", () => {
  test.each([
    ["matrix", matrix, { container: 4, shape: 5, text: 7, arrow: 0 }],
    ["versus", versus, { container: 2, shape: 3, text: 2, arrow: 0 }],
    ["tree", tree, { container: 0, shape: 6, text: 1, arrow: 5 }],
  ])("%s", (_name, op, counts) => {
    const doc = build([op]);
    const got = Object.fromEntries(Object.keys(counts).map((type) => [type, doc.elements.filter((e) => e.type === type).length]));
    expect(got).toEqual(counts);
    // 展開した結果は、見た目の検査に何もかからない
    expect(checkBoard(doc)).toEqual([]);
  });

  test("matrix の横に並ぶ枠は、付箋の多いほうに高さをそろえる", () => {
    const doc = build([matrix]);
    const h = (id: string) => doc.elements.find((e) => e.id === id)?.h;
    expect(h("mx-tl")).toBe(h("mx-tr"));
    expect(h("mx-bl")).toBe(h("mx-br"));
    expect(h("mx-tl")).toBeGreaterThan(h("mx-bl") ?? 0);
  });

  test("付箋の欄は、そのまま付箋に入る", () => {
    expect(build([matrix]).elements.find((e) => e.id === "mx-tl-2")).toMatchObject({ title: "新人", text: "研修から", who: "山田", status: "priority" });
  });

  test("場所を書かなければ、今ある中身の右に置く。id を書かなければ自動で振る", () => {
    const doc = build([{ op: "add", el: { id: "a", type: "shape", x: 0, y: 0, w: 200, h: 100 } }, { ...versus, id: undefined }]);
    const left = doc.elements.find((e) => e.type === "container");
    expect(left?.id).toBe("tp1-l");
    expect(Math.min(...doc.elements.filter((e) => e.id !== "a").map((e) => boxOf(e)?.x ?? Infinity))).toBe(260);
  });

  test("展開した枠には、後から in で足せる", () => {
    const doc = build([versus, { op: "add", in: "vs-r", el: { id: "more", type: "shape", text: "足した" } }]);
    expect(checkBoard(doc).filter((i) => i.kind !== "small-text")).toEqual([]);
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
    ["付箋の欄の値が違う", { ...versus, left: cell("a", [{ text: "x", status: "done" }]) }, "status は"],
    ["木の根が無い", { op: "template", kind: "tree" }, "root"],
  ])("%s", (_name, ops, message) => {
    const r = applyOps(emptyDoc("t"), Array.isArray(ops) ? ops : [ops]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});
