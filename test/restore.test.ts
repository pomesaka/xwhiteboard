import { describe, expect, test } from "bun:test";
import { applyOps, emptyDoc, isSolid, membersOf, type Doc, type El } from "../src/shared/model.ts";
import { dropMissing, restoreOps, withGeometry } from "../src/shared/restore.ts";

function apply(doc: Doc, ops: unknown[]): { doc: Doc; added: El[]; updated: El[]; removed: El[] } {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const byId = (doc: Doc): Map<string, El> => new Map(doc.elements.map((e) => [e.id, e]));
/** 要素を id の順に並べたもの。「元に戻す」は、重なり順（要素の並び）までは戻さない */
const sorted = (doc: Doc): El[] => [...doc.elements].sort((a, b) => a.id.localeCompare(b.id));

// 自由に置くセクション s（付箋 a・b で 1 行が埋まっている）の下に、セクション t と、その中の付箋 t1
const base = apply(emptyDoc("t"), [
  { op: "add", el: { id: "s", type: "container", x: 0, y: 0 } },
  { op: "add", in: "s", el: { id: "a", type: "shape", text: "a" } },
  { op: "add", in: "s", el: { id: "b", type: "shape", text: "b" } },
  { op: "add", el: { id: "t", type: "container", x: 0, y: 260 } },
  { op: "add", in: "t", el: { id: "t1", type: "shape", text: "t1" } },
  { op: "add", el: { id: "free", type: "shape", x: 800, y: 0, w: 300, h: 110, text: "外" } },
]).doc;

describe("操作 → 逆の操作で、列で並べないボードが元に戻る", () => {
  // inverse は、画面が自分で作る逆の操作。足した要素の rm は、足した後の id から作る
  test.each<[string, unknown[], (added: El[], removed: El[]) => unknown[]]>([
    ["セクションに付箋を足す（セクションが伸び、下のセクションと中身が下がる）", [{ op: "add", in: "s", el: { id: "c", type: "shape", text: "c" } }], (added) => added.map((el) => ({ op: "rm", id: el.id }))],
    ["付箋の高さを増やす（下のセクションが下がる）", [{ op: "set", id: "a", patch: { h: 300 } }], () => [{ op: "set", id: "a", patch: { h: 110 } }]],
    ["先頭に差し込む（指した要素から下が、全部下がる）", [{ op: "add", above: "s", el: { id: "top", type: "container", w: 504, h: 100 } }], (added) => added.map((el) => ({ op: "rm", id: el.id }))],
    ["付箋を消す（ほかは動かない）", [{ op: "rm", id: "b" }], (_added, removed) => removed.map((el) => ({ op: "add", el }))],
  ])("%s", (_name, ops, inverseOf) => {
    const after = apply(base, ops);
    const inverse = inverseOf(after.added, after.removed);
    const undo = [...inverse, ...restoreOps(byId(base), after.updated, inverse)];
    expect(sorted(apply(after.doc, undo).doc)).toEqual(sorted(base));
  });

  test("サーバーが動かした要素があるときだけ、戻す操作ができる", () => {
    const grown = apply(base, [{ op: "add", in: "s", el: { id: "c", type: "shape", text: "c" } }]);
    expect(restoreOps(byId(base), grown.updated, []).length).toBeGreaterThan(0);
    const removed = apply(base, [{ op: "rm", id: "b" }]);
    expect(restoreOps(byId(base), removed.updated, [])).toEqual([]);
  });
});

describe("位置と大きさを戻す操作", () => {
  const before = new Map<string, El>([["n", { id: "n", type: "shape", x: 0, y: 600, w: 300, h: 110 }]]);
  const updated: El[] = [{ id: "n", type: "shape", x: 260, y: 255, w: 220, h: 110 }];
  test.each([
    ["逆の操作に無い項目は、変える前の値へ戻す", [], [{ op: "set", id: "n", patch: { x: 0, y: 600, w: 300 } }]],
    ["逆の操作の set に書いた項目は、作らない（ドラッグの x・y）", [{ op: "set", id: "n", patch: { x: 10, y: 20 } }], [{ op: "set", id: "n", patch: { w: 300 } }]],
    ["全部の項目が逆の操作にあれば、何も作らない", [{ op: "set", id: "n", patch: { x: 10, y: 20, w: 300 } }], []],
    ["別の要素への set は、関係しない", [{ op: "set", id: "m", patch: { x: 10, y: 20, w: 300 } }], [{ op: "set", id: "n", patch: { x: 0, y: 600, w: 300 } }]],
  ])("%s", (_name, inverse, expected) => {
    expect(restoreOps(before, updated, inverse)).toEqual(expected);
  });

  test("変える前に無かった項目は、null で消す。位置は、変わっていなくても書く", () => {
    const text = new Map<string, El>([["t", { id: "t", type: "text", x: 0, y: 0, text: "文字" }]]);
    expect(restoreOps(text, [{ id: "t", type: "text", x: 0, y: 0, w: 220, text: "文字" }], [])).toEqual([{ op: "set", id: "t", patch: { x: 0, y: 0, w: null } }]);
  });

  test("変える前に無かった要素（足された要素）は、戻さない", () => {
    expect(restoreOps(new Map(), updated, [])).toEqual([]);
  });
});

describe("もう無い要素への操作を除く", () => {
  const has = (id: string): boolean => id === "a";
  test.each([
    ["ある要素への set は残す", [{ op: "set", id: "a", patch: { x: 1 } }], [{ op: "set", id: "a", patch: { x: 1 } }]],
    ["無い要素への set は除く", [{ op: "set", id: "c", patch: { x: 1 } }], []],
    ["無い要素への rm は除く", [{ op: "rm", id: "c" }], []],
    ["add は、要素が無くても残す（消した要素を足し直す操作）", [{ op: "add", el: { id: "c", type: "shape" } }], [{ op: "add", el: { id: "c", type: "shape" } }]],
    ["題名を戻す操作は残す", [{ op: "title", title: "前の題名" }], [{ op: "title", title: "前の題名" }]],
  ])("%s", (_name, ops, expected) => {
    expect(dropMissing(ops, has)).toEqual(expected);
  });

  test("付箋を消した後に、ほかの画面が別の要素を消していても、消した付箋は戻る", () => {
    const after = apply(base, [{ op: "add", in: "s", el: { id: "c", type: "shape", text: "c" } }]);
    const undo = [{ op: "rm", id: "c" }, ...restoreOps(byId(base), after.updated, [])];
    // エージェントが、下がったセクションの中の付箋を消す
    const later = apply(after.doc, [{ op: "rm", id: "t1" }]).doc;
    const live = dropMissing(undo, (id) => later.elements.some((e) => e.id === id));
    expect(apply(later, live).doc.elements.map((e) => e.id).sort()).toEqual(["a", "b", "free", "s", "t"]);
  });
});

test("手元の位置と大きさを、届いた要素に写す", () => {
  const remote: El = { id: "n", type: "shape", x: 0, y: 0, w: 220, h: 110, text: "届いた文", color: "green" };
  const local: El = { id: "n", type: "shape", x: 50, y: 60, w: 300, h: 120, text: "手元の文" };
  expect(withGeometry(remote, local)).toEqual({ id: "n", type: "shape", x: 50, y: 60, w: 300, h: 120, text: "届いた文", color: "green", points: undefined, from: undefined, to: undefined });
});

/**
 * ボードの見た目を決めるもの。全部の要素の中身（id の順）と、列で並べるセクションごとの、並べる中身（場所をふさぐ要素）の並ぶ順（要素の並びの順）。
 * WHY 要素の並びをそのまま比べない: 消して戻した要素は、要素の並びの別の場所に入る。
 * 中身でない要素との前後（重なり順）は変わるが、「元に戻す」はそこまでは戻さない。
 */
function layout(doc: Doc): { els: El[]; order: Record<string, string[]> } {
  const sections = doc.elements.filter((e) => e.type === "container" && e.cols !== undefined);
  return { els: sorted(doc), order: Object.fromEntries(sections.map((c) => [c.id, membersOf(doc.elements, c).filter(isSolid).map((m) => m.id)])) };
}

describe("操作 → 逆の操作で、列で並べるセクションが元に戻る", () => {
  // 列で並べるセクション s（a〜e。3 列なので 2 行、高さ 312）。d を指すコメント k と、2 行めの上の線 l がある。
  // s のすぐ下（間 18）に付箋 near。その下に、列で並べるセクション t（t1・t2）と u（背の違う p・q・r が 1 行）。
  // 外に、幅 300 の付箋 free、自由に置くセクション box、box の下の端の外にある大きい画像 img（列の幅に縮めると、中心が box に入る）
  const section = (id: string, y: number) => ({ op: "add", el: { id, type: "container", x: 0, y, w: 740, cols: 3 } });
  const note = (into: string, id: string, extra: Record<string, unknown> = {}) => ({ op: "add", in: into, el: { id, type: "shape", text: id, ...extra } });
  const top = apply(emptyDoc("t"), [section("s", 0), ...["a", "b", "c", "d", "e"].map((id) => note("s", id))]).doc;
  const cols = apply(top, [
    { op: "add", el: { id: "k", type: "comment", x: 30, y: 200, on: "d" } },
    { op: "add", el: { id: "l", type: "stroke", points: [[300, 190], [330, 220]] } },
    { op: "add", el: { id: "near", type: "shape", x: 600, y: 330, w: 100, h: 40, text: "すぐ下" } },
    section("t", 400),
    note("t", "t1"),
    note("t", "t2"),
    section("u", 700),
    note("u", "p", { h: 40 }),
    note("u", "q", { h: 200 }),
    note("u", "r", { h: 40 }),
    { op: "add", el: { id: "free", type: "shape", x: 800, y: 0, w: 300, h: 110, text: "外" } },
    { op: "add", el: { id: "box", type: "container", x: 1200, y: 0, w: 300, h: 200 } },
    { op: "add", el: { id: "img", type: "image", src: "x.png", x: 1250, y: 100, w: 400, h: 300 } },
  ]).doc;
  const at = (id: string): El => {
    const el = cols.elements.find((e) => e.id === id);
    if (!el) throw new Error(`${id} が無い`);
    return el;
  };
  /** 画面のドラッグ。選んだ要素を dx・dy だけ動かした絶対座標を set で送り、逆の操作は元の座標の set */
  const drag = (ids: string[], dx: number, dy: number): { ops: unknown[]; inverse: unknown[]; dragged: El[] } => ({
    ops: ids.map((id) => ({ op: "set", id, patch: { x: (at(id).x ?? 0) + dx, y: (at(id).y ?? 0) + dy } })),
    inverse: ids.map((id) => ({ op: "set", id, patch: { x: at(id).x, y: at(id).y } })),
    dragged: ids.map((id) => ({ ...at(id), x: (at(id).x ?? 0) + dx, y: (at(id).y ?? 0) + dy })),
  });
  const rm = (...ids: string[]) => ({ ops: ids.map((id) => ({ op: "rm", id })), inverse: ids.map((id) => ({ op: "add", el: at(id) })), dragged: [] });
  const addIn = (section: string) => ({ ops: [{ op: "add", in: section, el: { id: "new", type: "shape", text: "new" } }], inverse: [{ op: "rm", id: "new" }], dragged: [] });

  test.each<[string, { ops: unknown[]; inverse: unknown[]; dragged: El[] }]>([
    ["先頭の付箋を消す", rm("a")],
    ["途中の付箋を消す", rm("c")],
    ["末尾の付箋を消す", rm("e")],
    ["付箋を足す（行は増えない）", addIn("s")],
    ["下のセクションに付箋を足す", addIn("t")],
    ["上のセクションの行が増えて、下のセクションが押し下げられる", { ops: [{ op: "add", in: "s", el: { id: "n1", type: "shape", text: "n1" } }, { op: "add", in: "s", el: { id: "n2", type: "shape", text: "n2" } }], inverse: [{ op: "rm", id: "n1" }, { op: "rm", id: "n2" }], dragged: [] }],
    ["付箋の高さを増やして、下のセクションが押し下げられる", { ops: [{ op: "set", id: "d", patch: { h: 400 } }], inverse: [{ op: "set", id: "d", patch: { h: 110 } }], dragged: [] }],
    ["ドラッグで、先頭の付箋を 3 番めの後ろへ入れ替える", drag(["a"], 500, 10)],
    ["ドラッグで、末尾の付箋を先頭へ入れ替える", drag(["e"], -250, -130)],
    ["外の付箋を、ドラッグでセクションへ入れる（幅が列にそろう）", drag(["free"], -530, 60)],
    ["中の付箋を、ドラッグでセクションの外へ出す", drag(["b"], 900, 0)],
    ["列の数を変える", { ops: [{ op: "set", id: "s", patch: { cols: 2 } }], inverse: [{ op: "set", id: "s", patch: { cols: 3 } }], dragged: [] }],
    ["列で並べるのをやめる", { ops: [{ op: "set", id: "s", patch: { cols: null } }], inverse: [{ op: "set", id: "s", patch: { cols: 3 } }], dragged: [] }],
    ["セクションの幅を変える", { ops: [{ op: "set", id: "s", patch: { w: 504 } }], inverse: [{ op: "set", id: "s", patch: { w: 740 } }], dragged: [] }],
    ["セクションごと動かす（画面は、セクションと中身を選んだ順に送る）", drag(["s", "a", "b", "c", "d", "e"], 1500, 40)],
    ["中身を先に選んでから、セクションごと動かす", drag(["c", "a", "s", "b", "d", "e"], 1500, 40)],
    ["下のセクションを、上のセクションの上へ動かす", drag(["t", "t1", "t2"], 0, -700)],
    ["最後の行の付箋を全部消す（行が減る）", rm("d", "e")],
    ["最後の行の付箋を、ドラッグで外へ出す（行が減る）", drag(["d", "e"], 0, 900)],
    ["セクションの付箋を全部消す（題名の帯だけに畳まれる）", rm("t1", "t2")],
    ["背の違う付箋が並ぶ行で、背の高い付箋を、ドラッグで先頭へ入れ替える", drag(["q"], -250, -10)],
    ["大きい画像を、ドラッグでセクションへ入れる（列の幅になり、戻すと元の大きさ）", drag(["img"], -950, -40)],
  ])("%s", (_name, { ops, inverse, dragged }) => {
    // 画面の els は、ドラッグの最中に動かした後の値になっている
    const before = new Map([...byId(cols), ...dragged.map((el): [string, El] => [el.id, el])]);
    const after = apply(cols, ops);
    const undo = [...inverse, ...restoreOps(before, after.updated, inverse)];
    expect(layout(apply(after.doc, undo).doc)).toEqual(layout(cols));
  });
});
