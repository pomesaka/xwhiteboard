import { describe, expect, test } from "bun:test";
import { convertLegacy, readLegacy } from "../src/convert.ts";
import { boxOf, textWidth, type Doc, type El } from "../src/shared/model.ts";

const SOURCE = `window.BOARD = {
  title: "定例",
  date: "2026-11-12",
  time: "13:00〜13:42",
  takeaway: "11/15 にデプロイ",
  topics: [
    { id: "t1", title: "バッチ", items: [
      { id: "i1", kind: "fact", text: "手動では動く", who: "A さん" },
      { id: "i2", kind: "todo", text: "直す", owner: "B さん", due: "11/13", wide: true },
      { id: "i3", kind: "open", text: "未決のこと" }
    ], figures: [
      { type: "flow", caption: "流れ", steps: [{ label: "X", next: "起動" }, { label: "Y", sub: "補足", bad: true }] },
      { type: "table", caption: "表", head: ["a", "b"], rows: [["1", "2"]] }
    ] },
    { id: "t2", title: "次", items: [{ id: "i4", kind: "decision", text: "決めた" }] },
    { id: "t3", title: "3", items: [] },
    { id: "t4", title: "4", items: [] }
  ]
};`;

function convert(): Doc {
  const legacy = readLegacy(SOURCE);
  if (!legacy.ok) throw new Error(legacy.error);
  const doc = convertLegacy(legacy.value);
  if (!doc.ok) throw new Error(doc.error);
  return doc.value;
}

const doc = convert();
const get = (id: string): El | undefined => doc.elements.find((e) => e.id === id);

describe("前の形の付箋は、種類ごとの色と札を持つ付箋になる", () => {
  test.each([
    ["事実は言った人を札に書く", "i1", { type: "shape", color: "gray", tag: "事実 · A さん", text: "手動では動く" }],
    ["宿題は担当と期限を札に書く", "i2", { type: "shape", color: "blue", tag: "宿題 · B さん · 〜11/13", w: 456 }],
    ["未決", "i3", { type: "shape", color: "orange", tag: "未決" }],
    ["決定", "i4", { type: "shape", color: "green", tag: "決定" }],
  ])("%s", (_name, id, expected) => {
    expect(get(id)).toMatchObject(expected);
  });
});

describe("前の形の議題と図は、セクションと図の要素になる", () => {
  test.each([
    ["題名", "title", { type: "text", size: "xl", text: "定例" }],
    ["いちばん大事な 1 文", "takeaway", { type: "shape", text: "11/15 にデプロイ" }],
    ["議題はセクション", "t1", { type: "container", title: "バッチ" }],
    ["流れの箱", "t1-f1-s1", { type: "shape", shape: "rect", text: "X" }],
    ["失敗の箱は赤く、補足は 2 行め", "t1-f1-s2", { type: "shape", color: "red", text: "Y\n補足" }],
    ["表", "t1-f2", { type: "table", head: ["a", "b"], rows: [["1", "2"]] }],
  ])("%s", (_name, id, expected) => {
    expect(get(id)).toMatchObject(expected);
  });

  test("流れの箱は、ラベル付きの矢印でつながる", () => {
    expect(doc.elements.filter((e) => e.type === "arrow")).toMatchObject([{ from: "t1-f1-s1", to: "t1-f1-s2", label: "起動" }]);
  });
});

describe("流れの図は、セクションからはみ出さず、矢印のラベルが箱にかからない", () => {
  const flow = (steps: string): Doc => {
    const legacy = readLegacy(`window.BOARD = { title: "t", topics: [{ id: "t1", title: "a", items: [], figures: [{ type: "flow", steps: ${steps} }] }] };`);
    if (!legacy.ok) throw new Error(legacy.error);
    const r = convertLegacy(legacy.value);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  test.each([
    ["箱が 3 つなら横に並ぶ", `[{ label: "A", next: "起動" }, { label: "B" }, { label: "C" }]`, "横"],
    ["箱が 4 つなら、横に入らないので縦に並ぶ", `[{ label: "12 月" }, { label: "1 月" }, { label: "3 月" }, { label: "5 月" }]`, "縦"],
    ["ラベルが長ければ、箱の間を広げる", `[{ label: "A", next: "開発・保守を依頼する" }, { label: "B" }]`, "横"],
    ["ラベルが長くて箱が細くなりすぎるなら縦に並ぶ", `[{ label: "A", next: "開発・保守を依頼する" }, { label: "B", next: "増やすかを相談する" }, { label: "C" }]`, "縦"],
  ])("%s", (_name, steps, direction) => {
    const d = flow(steps);
    const section = d.elements.find((e) => e.id === "t1");
    const sb = section ? boxOf(section) : null;
    const boxes = d.elements.filter((e) => e.id.includes("-s")).flatMap((e) => boxOf(e) ?? []);
    const [first, second] = boxes;
    if (!sb || !first || !second) throw new Error("箱が足りない");
    expect(first.x === second.x ? "縦" : "横").toBe(direction);
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(sb.x);
      expect(b.x + b.w).toBeLessThanOrEqual(sb.x + sb.w);
      expect(b.y + b.h).toBeLessThanOrEqual(sb.y + sb.h);
    }
    for (const arrow of d.elements.filter((e) => e.type === "arrow")) {
      const from = d.elements.find((e) => e.id === arrow.from);
      const to = d.elements.find((e) => e.id === arrow.to);
      const a = from ? boxOf(from) : null;
      const b = to ? boxOf(to) : null;
      if (!a || !b) throw new Error("矢印の端が無い");
      const room = direction === "横" ? b.x - (a.x + a.w) : b.y - (a.y + a.h);
      expect(room).toBeGreaterThanOrEqual(direction === "横" ? textWidth(arrow.label ?? "", 12) : 12);
    }
  });
});

test("変換した要素は、矢印を除いて互いに重ならない（セクションと中身の重なりは除く）", () => {
  const boxes = doc.elements.flatMap((e) => {
    const b = e.type === "container" || e.type === "arrow" ? null : boxOf(e);
    return b ? [{ id: e.id, ...b }] : [];
  });
  const clashes: string[] = [];
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) clashes.push(`${a.id} × ${b.id}`);
    }
  }
  expect(clashes).toEqual([]);
});

test("4 つめの議題は 2 段めに置かれ、1 段めのセクションと重ならない", () => {
  const first = get("t1");
  const fourth = get("t4");
  expect(fourth?.x).toBe(0);
  expect(fourth?.y ?? 0).toBeGreaterThan((first?.y ?? 0) + (first?.h ?? 0));
});
