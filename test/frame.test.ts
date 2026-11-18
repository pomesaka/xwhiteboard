// 透明な枠（container の frame: "none"）。図を、見た目を増やさずに 1 つのまとまりにする枠。
import { describe, expect, test } from "bun:test";
import { checkBoard } from "../src/shared/check.ts";
import { focusLabel } from "../src/shared/focus.ts";
import { planAlign } from "../src/shared/format.ts";
import { applyOps, emptyDoc, membersOf, PAD, parseDoc, parseEl, sectionTop, type Doc, type El } from "../src/shared/model.ts";
import { collect } from "../src/shared/summary.ts";

type Raw = Record<string, unknown>;
const add = (el: Raw) => ({ op: "add", el });
const frame = (id: string, x: number, y: number, w: number, h: number, extra: Raw = {}): Raw => ({ id, type: "container", frame: "none", x, y, w, h, ...extra });
const sec = (id: string, x: number, y: number, extra: Raw = {}): Raw => ({ id, type: "container", x, y, w: 504, h: 100, ...extra });
const box = (id: string, x: number, y: number): Raw => ({ id, type: "shape", shape: "rect", x, y, w: 160, h: 60 });

function build(ops: unknown[], base: Doc = emptyDoc("t")): Doc {
  const r = applyOps(base, ops);
  if (!r.ok) throw new Error(r.error);
  return r.value.doc;
}
const board = (els: Raw[]): Doc => build(els.map(add));
const get = (doc: Doc, id: string): El | undefined => doc.elements.find((e) => e.id === id);
const errorOf = (ops: unknown[], base: Doc = emptyDoc("t")): string => {
  const r = applyOps(base, ops);
  return r.ok ? "" : r.error;
};

describe("透明な枠の書き方", () => {
  test("frame: none を書いたセクションは、その形で読める", () => {
    const r = parseEl(frame("f", 0, 0, 400, 300));
    expect(r.ok && r.value).toMatchObject({ type: "container", frame: "none" });
  });

  test.each([
    ["cols", { cols: 2 }, "透明な枠）に cols は書けない"],
    ["title", { title: "図" }, "透明な枠）に title は書けない"],
    ["空の title", { title: "" }, "透明な枠）に title は書けない"],
    ["question", { question: "何を決める" }, "透明な枠）に question は書けない"],
    ["answer", { answer: "決めた" }, "透明な枠）に answer は書けない"],
  ])("%s と一緒には書けない", (_name, extra, message) => {
    const r = parseEl(frame("f", 0, 0, 400, 300, extra));
    expect(r.ok ? "" : r.error).toContain(message);
  });

  test.each([["solid"], [""], [true], [null]])("frame の値は none だけ（%p は断る）", (v) => {
    const r = parseEl({ id: "f", type: "container", x: 0, y: 0, frame: v });
    expect(r.ok ? "" : r.error).toContain("frame は none だけ");
  });

  test("ほかの種類の要素には、frame を書けない", () => {
    const r = parseEl({ id: "n", type: "shape", x: 0, y: 0, frame: "none" });
    expect(r.ok ? "" : r.error).toContain("shape に frame は無い");
  });

  test("題名のあるセクションに、set で frame: none は書けない。題名を消せば書ける", () => {
    const doc = board([sec("s", 0, 0, { title: "議題" })]);
    expect(errorOf([{ op: "set", id: "s", patch: { frame: "none" } }], doc)).toContain("title は書けない");
    expect(get(build([{ op: "set", id: "s", patch: { frame: "none", title: null } }], doc), "s")).toMatchObject({ frame: "none" });
  });

  test("set で frame を消せば、ふつうのセクションに戻る", () => {
    const doc = build([{ op: "set", id: "f", patch: { frame: null } }], board([frame("f", 0, 0, 400, 300)]));
    expect(get(doc, "f")?.frame).toBeUndefined();
  });

  test("frame を書かない、前からあるボードは、そのまま読める", () => {
    const text = JSON.stringify({ version: 1, title: "t", seq: 1, elements: [{ id: "s", type: "container", x: 0, y: 0, w: 504, h: 160, title: "議題" }] });
    const r = parseDoc(text);
    expect(r.ok && r.value.elements[0]).toEqual({ id: "s", type: "container", x: 0, y: 0, w: 504, h: 160, title: "議題" });
  });
});

describe("中身", () => {
  test("中身を置き始めるのは、上の余白（24）の下。題名の札の場所を取らない", () => {
    expect(sectionTop({ id: "f", type: "container", frame: "none", w: 400 })).toBe(PAD);
  });

  test("in で足すと、左上の余白の内側に置く", () => {
    const doc = build([add(frame("f", 100, 100, 600, 400)), { op: "add", in: "f", el: { id: "n", type: "shape" } }]);
    expect(get(doc, "n")).toMatchObject({ x: 124, y: 124 });
  });

  test("中身は、ふつうのセクションと同じに、中心が枠の中にある要素", () => {
    const doc = board([frame("f", 0, 0, 600, 400), box("in", 100, 100), box("out", 700, 100)]);
    const f = get(doc, "f");
    expect(f && membersOf(doc.elements, f).map((m) => m.id)).toEqual(["in"]);
  });

  test("set で動かすと、中身（中のセクションと、その中身も）ごと動く", () => {
    const doc = build([{ op: "set", id: "f", patch: { x: 1000, y: 500 } }], board([frame("f", 0, 0, 600, 400), sec("s", 24, 24, { w: 300 }), box("a", 48, 60), box("b", 400, 200)]));
    expect([get(doc, "s"), get(doc, "a"), get(doc, "b")].map((e) => [e?.x, e?.y])).toEqual([
      [1024, 524],
      [1048, 560],
      [1400, 700],
    ]);
  });

  test("外へ出した要素は、中身でなくなり、枠を動かしても付いていかない", () => {
    const base = board([frame("f", 0, 0, 600, 400), box("a", 100, 100)]);
    const doc = build([{ op: "set", id: "a", patch: { x: 900 } }, { op: "set", id: "f", patch: { y: 300 } }], base);
    expect(get(doc, "a")).toMatchObject({ x: 900, y: 100 });
  });

  test("注目の札は、題名が無いので id", () => {
    expect(focusLabel({ id: "fig", type: "container", frame: "none" })).toBe("fig");
  });
});

describe("format は、透明な枠を 1 つのまとまりとして揃え、中の配置を崩さない", () => {
  // 構成図: 透明な枠 fig の中に、セクション 4 つ（A・B は上の段、C・D は下の段で、横にずれている）と、それらを結ぶ矢印
  const diagram = [
    frame("fig", 700, 400, 1300, 600),
    sec("A", 724, 424, { w: 300 }),
    sec("B", 1124, 424, { w: 300 }),
    sec("C", 824, 700, { w: 300 }),
    sec("D", 1424, 760, { w: 300 }),
    { id: "ab", type: "arrow", from: "A", to: "B" },
    { id: "ac", type: "arrow", from: "A", to: "C" },
    { id: "bd", type: "arrow", from: "B", to: "D" },
  ];
  const doc = board([sec("X", 0, 0), ...diagram]);
  const done = build([{ op: "format" }], doc);
  const offset = (d: Doc, id: string): [number, number] => {
    const [e, f] = [get(d, id), get(d, "fig")];
    return [(e?.x ?? 0) - (f?.x ?? 0), (e?.y ?? 0) - (f?.y ?? 0)];
  };

  test("透明な枠は、ふつうのセクションと同じに列へ揃う", () => {
    expect(get(done, "fig")).toMatchObject({ x: 564, y: 0 });
  });

  test.each(["A", "B", "C", "D"])("中のセクション %s は、枠からの位置も大きさも変わらない", (id) => {
    expect(offset(done, id)).toEqual(offset(doc, id));
    expect([get(done, id)?.w, get(done, id)?.h]).toEqual([get(doc, id)?.w, get(doc, id)?.h]);
  });

  test("もう一度かけても、何も変わらない", () => {
    const r = applyOps(done, [{ op: "format" }]);
    expect(r.ok && r.value.updated).toEqual([]);
  });

  test("中のセクションは、中身より背が高くても縮めない。透明な枠は、中身の下の端 + 24 まで縮める", () => {
    const tall = board([frame("fig", 0, 0, 800, 900), sec("A", 24, 24, { w: 300, h: 500 }), box("a", 48, 80)]);
    const plan = planAlign(tall.elements);
    const moved = plan.ok ? plan.value.moved : [];
    expect(moved.find((e) => e.id === "A")).toBeUndefined();
    expect(moved.find((e) => e.id === "fig")).toMatchObject({ h: 24 + 500 + 24 });
  });
});

describe("まとめの帯の行に、透明な枠の題名は添えない", () => {
  const decided = (id: string, x: number, y: number): Raw => ({ id, type: "shape", x, y, w: 100, h: 40, text: id, status: "decided" });
  test.each<[string, Raw[], string | undefined]>([
    ["透明な枠だけに入っている付箋には、セクションを添えない", [frame("f", 0, 0, 600, 400), decided("n", 100, 100)], undefined],
    ["外側にふつうのセクションがあれば、そちらを添える", [sec("S", 0, 0, { w: 900, h: 700, title: "議題" }), frame("f", 24, 60, 600, 400), decided("n", 100, 100)], "S"],
  ])("%s", (_name, els, want) => {
    const row = collect(board(els).elements).find((r) => r.item.id === "n");
    expect(row?.item.section?.id).toBe(want);
  });
});

describe("検査", () => {
  const kinds = (doc: Doc): string[] => checkBoard(doc, { style: true }).map((i) => i.kind);

  test.each<[string, Raw[], string, string]>([
    ["中身がはみ出す", [frame("f", 0, 0, 400, 300), box("a", 300, 100)], "outside-section", "a が透明な枠 f から"],
    ["中心が外の要素が、枠にかかる", [frame("f", 0, 0, 400, 300), box("a", 380, 100)], "on-section-edge", "透明な枠は見えないので、画面では気づけない"],
    ["上の端に詰まっている", [frame("f", 0, 0, 400, 300), box("a", 30, 5)], "cramped", "a が透明な枠 f の上の端に近い（上から 5。24 空ける）"],
    ["端に詰まっている", [frame("f", 0, 0, 400, 300), box("a", 5, 100)], "cramped", "透明な枠 f の端に詰まっている"],
    ["中に何も無い", [frame("f", 0, 0, 400, 300)], "empty-frame", "透明な枠 f の中に何も無い"],
  ])("%s", (_name, els, kind, message) => {
    const issue = checkBoard(board(els), { style: true }).find((i) => i.kind === kind);
    expect(issue?.message).toContain(message);
  });

  test("中身のある透明な枠には、空の知らせを出さない（中のセクションだけでもよい）", () => {
    expect(kinds(board([frame("f", 0, 0, 600, 400), sec("s", 24, 24, { w: 300 })]))).not.toContain("empty-frame");
  });

  test("空の透明な枠の知らせは、書き方の提案（style）。崩れの検査には出ない", () => {
    expect(checkBoard(board([frame("f", 0, 0, 400, 300)])).map((i) => i.kind)).not.toContain("empty-frame");
  });

  test("ふつうのセクションには、空の知らせを出さない", () => {
    expect(kinds(board([sec("s", 0, 0)]))).not.toContain("empty-frame");
  });
});

describe("型は、全体を透明な枠で囲む", () => {
  const cell = (title: string, items: unknown[] = []) => ({ title, items });
  const ops: [string, Raw][] = [
    ["matrix", { op: "template", kind: "matrix", id: "mx", xAxis: { label: "x", low: "低", high: "高" }, yAxis: { label: "y", low: "低", high: "高" }, cells: [[cell("左上", ["a"]), cell("右上")], [cell("左下"), cell("右下", ["b", "c"])]] }],
    ["versus", { op: "template", kind: "versus", id: "vs", left: cell("左", ["a"]), right: cell("右") }],
    ["tree", { op: "template", kind: "tree", id: "tr", root: { text: "根", children: ["A", "B"] } }],
  ];

  test.each(ops)("%s: 型の id の透明な枠が、型の要素を全部囲む", (_name, op) => {
    const doc = build([{ ...op, x: 100, y: 50 }]);
    const id = String(op.id);
    const f = get(doc, id);
    expect(f).toMatchObject({ type: "container", frame: "none", x: 100, y: 50 });
    const inner = new Set(f ? membersOf(doc.elements, f).map((m) => m.id) : []);
    const parts = doc.elements.filter((e) => e.id.startsWith(`${id}-`) && e.type !== "arrow" && e.type !== "container");
    expect(parts.filter((e) => !inner.has(e.id)).map((e) => e.id)).toEqual([]);
  });

  test.each(ops)("%s: 横に別のセクションがあって format をかけても、型の中の配置は変わらない", (_name, op) => {
    const doc = build([add(sec("X", 0, 0)), { ...op, x: 2000, y: 600 }]);
    const done = build([{ op: "format" }], doc);
    const id = String(op.id);
    const rel = (d: Doc): string[] => {
      const f = get(d, id);
      return d.elements.filter((e) => e.id.startsWith(`${id}-`) && e.type !== "arrow").map((e) => `${e.id}:${(e.x ?? 0) - (f?.x ?? 0)},${(e.y ?? 0) - (f?.y ?? 0)},${e.h}`);
    };
    expect(rel(done)).toEqual(rel(doc));
    expect(get(done, id)).toMatchObject({ x: 564, y: 0 });
  });

  test.each(ops)("%s: 展開した結果は、見た目の検査に何もかからない（書き方の提案も）", (_name, op) => {
    expect(checkBoard(build([op]), { style: true })).toEqual([]);
  });
});
