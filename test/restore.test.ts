import { describe, expect, test } from "bun:test";
import { applyOps, emptyDoc, membersOf, trackHuman, type Applied, type Doc, type El } from "../src/shared/model.ts";
import { restoreOp, withGeometry } from "../src/shared/restore.ts";
import { add, drag, resize, rm, send, setOps, undone, type Gesture, type Op } from "./screen.ts";

function apply(doc: Doc, ops: unknown[]): Applied {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const byId = (doc: Doc): Map<string, El> => new Map(doc.elements.map((e) => [e.id, e]));
const ids = (doc: Doc): string[] => doc.elements.map((e) => e.id);
const find = (doc: Doc, id: string): El | undefined => doc.elements.find((e) => e.id === id);

/** 画面の操作を送って「元に戻す」と、要素の中身も、要素の並び（重なり順）も、元に戻ることを確かめる */
function expectRoundtrip(doc: Doc, g: Gesture | null): void {
  const sent = g ? send(doc, g) : null;
  if (!sent) throw new Error("操作が断られた");
  // 操作で何かが変わっていること（変わらない操作では、往復を確かめたことにならない）
  expect(sent.applied.doc.elements).not.toEqual(doc.elements);
  expect(undone(sent.applied.doc, sent.undo).elements).toEqual(doc.elements);
}

// 自由に置くセクション s（付箋 a・b で 1 行が埋まっている）の下に、セクション t と、その中の付箋 t1。s の下の端のすぐ上に線 l
const base = apply(emptyDoc("t"), [
  { op: "add", el: { id: "s", type: "container", x: 0, y: 0 } },
  { op: "add", in: "s", el: { id: "a", type: "shape", text: "a" } },
  { op: "add", in: "s", el: { id: "b", type: "shape", text: "b" } },
  { op: "add", el: { id: "t", type: "container", x: 0, y: 260 } },
  { op: "add", in: "t", el: { id: "t1", type: "shape", text: "t1" } },
  { op: "add", el: { id: "free", type: "shape", x: 800, y: 0, w: 300, h: 110, text: "外" } },
  { op: "add", el: { id: "l", type: "stroke", points: [[30, 170], [60, 180]] } },
  { op: "add", el: { id: "ar", type: "arrow", from: "a", to: "free" } },
]).doc;

describe("画面の操作 → 元に戻す で、列で並べないボードが元に戻る", () => {
  test.each<[string, Gesture | null]>([
    ["セクションに付箋を足す（セクションが伸び、下のセクションと中身が下がる）", { ...add({ id: "c", type: "shape", text: "c" }), ops: [{ op: "add", in: "s", el: { id: "c", type: "shape", text: "c" } }] }],
    ["付箋の高さを増やす（下のセクションが下がる）", resize(base, "a", 220, 300)],
    ["付箋を消す（付いていた矢印も消え、戻すと、重なり順も戻る）", rm(base, ["a"])],
    ["付箋とセクションを一緒に消す", rm(base, ["b", "t"])],
    ["付箋を動かす", drag(base, ["free"], -300, 500)],
    ["セクションを、中身ごと動かす", drag(base, ["s"], 1500, 0)],
    ["文字を変える（高さが増える）", setOps(base, [{ id: "a", patch: { text: "長い文字の行を書く。折り返すかもしれない長さにする。もっと長くして行を増やす。さらに長くする" } }])],
    // 縮めたセクションの枠の下に出た線が、戻すときに「下にあるもの」と読まれて、押し下げられない
    ["自由に置くセクションを縮める（戻すときに、下を押し下げない）", resize(base, "s", 504, 150)],
    ["自由に置くセクションに cols を書く", setOps(base, [{ id: "s", patch: { cols: 1 } }])],
  ])("%s", (_name, g) => expectRoundtrip(base, g));
});

describe("元に戻す操作の組み立て", () => {
  const n: El = { id: "n", type: "shape", x: 0, y: 600, w: 300, h: 110, text: "前" };
  const moved: El = { ...n, x: 260, y: 255, w: 220 };
  const before = new Map([["n", n]]);
  const none = { added: [], updated: [], removed: [] };
  type Args = Parameters<typeof restoreOp>;

  test.each<[string, Args, Op | null]>([
    ["サーバーが変えた位置と大きさは、変える前の値へ戻す", [before, [], { ...none, updated: [moved] }], { op: "restore", set: [{ id: "n", patch: { x: 0, y: 600, w: 300 } }] }],
    ["変わっていない項目は、書かない", [before, [], { ...none, updated: [{ ...n, y: 700 }] }], { op: "restore", set: [{ id: "n", patch: { y: 600 } }] }],
    ["何も変わっていなければ、作らない", [before, [], { ...none, updated: [n] }], null],
    ["変える前に無かった項目は、null で消す", [new Map([["t", { id: "t", type: "text", x: 0, y: 0, text: "文字" }]]), [], { ...none, updated: [{ id: "t", type: "text", x: 0, y: 0, w: 220, text: "文字" }] }], { op: "restore", set: [{ id: "t", patch: { w: null } }] }],
    ["送った set に書いた項目は、位置と大きさでなくても戻す", [before, [{ op: "set", id: "n", patch: { text: "後" } }], { ...none, updated: [{ ...n, text: "後", h: 200 }] }], { op: "restore", set: [{ id: "n", patch: { h: 110, text: "前" } }] }],
    // 手元の要素は、エージェントの変更が届く前の値のことがある
    ["送った set に書いていない、位置と大きさのほかの項目は、違っていても戻さない", [before, [{ op: "set", id: "n", patch: { y: 700 } }], { ...none, updated: [{ ...n, y: 700, text: "エージェントが直した" }] }], { op: "restore", set: [{ id: "n", patch: { y: 600 } }] }],
    ["ドラッグは、手元で動かす前の要素（origin）へ戻す", [new Map([["n", moved]]), [{ op: "set", id: "n", patch: { x: 260, y: 255 } }], { ...none, updated: [moved] }, before], { op: "restore", set: [{ id: "n", patch: { x: 0, y: 600, w: 300 } }] }],
    ["変える前の値が手元に無い要素は、戻さない", [new Map(), [], { ...none, updated: [n] }], null],
    ["変える前に無かった要素（足された要素）は、消す", [new Map(), [], { ...none, added: [n] }], { op: "restore", rm: ["n"] }],
    ["消えた要素は、足し直して、要素の並びを戻す", [new Map([["m", moved], ["n", n]]), [], { ...none, removed: [n] }], { op: "restore", add: [n], order: ["m", "n"] }],
    ["重なり順が変わったら、要素の並びを戻す", [new Map([["m", moved], ["n", n]]), [], { ...none, order: ["n", "m"] }], { op: "restore", order: ["m", "n"] }],
  ])("%s", (_name, args, expected) => {
    expect(restoreOp(...args)).toEqual(expected);
  });
});

describe("restore の操作は、書かれた形を書く。押し下げず、連れていかない", () => {
  // 列で並べるセクション s（a・b・c。2 列）。すぐ下に、自由に置くセクション v と、その中の付箋 m。v の下に付箋 below
  const doc = apply(emptyDoc("t"), [
    { op: "add", el: { id: "s", type: "container", x: 0, y: 0, w: 504, cols: 2 } },
    ...["a", "b", "c"].map((id) => ({ op: "add", in: "s", el: { id, type: "shape" } })),
    { op: "add", el: { id: "v", type: "container", x: 0, y: 372, w: 504, h: 200 } },
    { op: "add", in: "v", el: { id: "m", type: "shape" } },
    { op: "add", el: { id: "k", type: "comment", x: 30, y: 60, on: "a" } },
    { op: "add", el: { id: "below", type: "shape", x: 0, y: 632, w: 220, h: 110 } },
  ]).doc;
  const restore = (parts: Op): Op => ({ op: "restore", ...parts });
  const set = (id: string, patch: Op): Op => ({ id, patch });

  test.each<[string, Op, Record<string, Op>]>([
    // 連れていくのは、並べ直し。直前に中身だった要素を、動かした先のセクションに並べる
    ["列で並べるセクションを動かすと、直前に中身だった要素は、動かした先に並ぶ", restore({ set: [set("s", { x: 1000 })] }), { s: { x: 1000, h: 312 }, a: { x: 1024, y: 52 }, c: { x: 1024, y: 178 }, k: { x: 1030 } }],
    ["直前に中身だった要素でも、場所を書いて members に入れなければ、位置で読む（外へ戻した要素）", restore({ set: [set("a", { x: 900, y: 900 })], members: { s: ["b", "c"] } }), { a: { x: 900, y: 900 }, b: { x: 24, y: 52 }, s: { h: 186 } }],
    ["members に入れた要素は、書いた場所が枠の外でも、そのセクションに並ぶ", restore({ set: [set("m", { x: 30, y: 900 })], members: { s: ["a", "b", "c", "m"] } }), { m: { x: 260, y: 178 }, s: { h: 312 } }],
    ["members に入れても、この操作が書いていない要素は、位置で読む", restore({ set: [set("a", { x: 24 })], members: { s: ["a", "b", "c", "m"] } }), { m: { x: 24, y: 424 }, s: { h: 312 } }],
    // 積んだ後に、エージェントが別の場所へ動かした要素
    ["members に入れても、この操作が場所を書かず、直前に中身でなかった要素は、位置で読む", restore({ set: [set("m", { h: 60 })], members: { s: ["a", "b", "c", "m"] } }), { m: { x: 24, y: 424, h: 60 }, s: { h: 312 } }],
    ["要素を動かしても、それを指すコメントを連れていかない", restore({ set: [set("m", { x: 200 })] }), { m: { x: 200 }, k: { x: 30, y: 60 } }],
    ["自由に置くセクションの h を増やしても、下を押し下げない", restore({ set: [set("v", { h: 400 })] }), { v: { h: 400 }, below: { y: 632 } }],
    ["自由に置くセクションの中身の高さを増やしても、セクションを伸ばさない", restore({ set: [set("m", { h: 300 })] }), { m: { h: 300 }, v: { h: 200 }, below: { y: 632 } }],
    // 並べ終わった形を書けば、何も変わらない。操作を積んだ後にエージェントが中身を変えていたときに、付箋が重なったままにならない
    ["まとまりの最後に、ほかの操作と同じに、列で並べるセクションを並べ直す", restore({ set: [set("a", { x: 900, y: 900 })] }), { a: { x: 900, y: 900 }, b: { x: 24, y: 52 }, c: { x: 260, y: 52 }, s: { h: 186 } }],
    ["書いた形で付箋が重なっても、並べ直して離す", restore({ set: [set("c", { x: 260, y: 52 })] }), { b: { x: 260, y: 52 }, c: { x: 24, y: 178 } }],
  ])("%s", (_name, op, want) => {
    const after = apply(doc, [op]).doc;
    for (const [id, w] of Object.entries(want)) expect(find(after, id)).toMatchObject(w);
  });

  test("null を書いた項目は消える", () => {
    expect(find(apply(doc, [restore({ set: [set("s", { cols: null })] })]).doc, "s")?.cols).toBeUndefined();
  });

  test.each<[string, Op, string[]]>([
    ["order に書いた要素は、書いた順になる", restore({ order: ["below", "k", "m", "v", "c", "b", "a", "s"] }), ["below", "k", "m", "v", "c", "b", "a", "s"]],
    ["order に書いていない要素は、今の位置から動かない", restore({ order: ["c", "a"] }), ["s", "c", "b", "a", "v", "m", "k", "below"]],
    ["order にある、もう無い要素は飛ばす", restore({ order: ["c", "x", "a"] }), ["s", "c", "b", "a", "v", "m", "k", "below"]],
    ["足し直した要素は、order で元の位置に入る", restore({ add: [{ id: "z", type: "shape", x: 900, y: 0, w: 220, h: 110 }], order: ["s", "z", "a"] }), ["s", "z", "b", "c", "v", "m", "k", "below", "a"]],
  ])("%s", (_name, op, expected) => {
    const r = apply(doc, [op]);
    expect(ids(r.doc)).toEqual(expected);
    expect(r.order).toEqual(expected);
  });

  test.each<[string, Op]>([
    ["もう無い要素の rm", restore({ rm: ["x"] })],
    ["もう無い要素の set", restore({ set: [set("x", { x: 1 })] })],
    ["もうある要素の add", restore({ add: [{ id: "a", type: "shape", x: 900, y: 900, w: 220, h: 110 }] })],
    ["端の要素がもう無い矢印の add", restore({ add: [{ id: "ar", type: "arrow", from: "a", to: "x" }] })],
    ["今と同じ並びの order", restore({ order: ["s", "a", "b"] })],
  ])("%s は飛ばして、何も変えない", (_name, op) => {
    const r = apply(doc, [op]);
    expect(r.doc.elements).toEqual(doc.elements);
    expect([r.added, r.updated, r.removed, r.order]).toEqual([[], [], [], undefined]);
  });

  test("飛ばす項目があっても、残りは当てる", () => {
    const r = apply(doc, [restore({ rm: ["x", "m"], set: [set("x", { x: 1 }), set("k", { y: 70 })] })]);
    expect(r.removed.map((e) => e.id)).toEqual(["m"]);
    expect(r.updated.map((e) => [e.id, e.x, e.y])).toEqual([["k", 30, 70]]);
  });

  test("足し直した矢印は、同じ操作で足し直した要素を端にできる", () => {
    const r = apply(doc, [restore({ add: [{ id: "ar", type: "arrow", from: "a", to: "z" }, { id: "z", type: "shape", x: 900, y: 0, w: 220, h: 110 }] })]);
    expect(r.added.map((e) => e.id)).toEqual(["ar", "z"]);
  });

  test.each<[string, Op, string]>([
    ["rm が配列でない", restore({ rm: "a" }), "配列で書く"],
    ["members の中身が配列でない", restore({ members: { s: "a" } }), "members は"],
    ["set の中身が { id, patch } でない", restore({ set: [{ id: "a" }] }), "{ id, patch }"],
    ["id を変える", restore({ set: [set("a", { id: "z" })] }), "id は変えられない"],
    ["要素の形に合わない値", restore({ set: [set("s", { cols: 99 })] }), "cols は"],
    ["要素の形に合わない add", restore({ add: [{ id: "z", type: "nothing" }] }), "type"],
  ])("%s と、断る", (_name, op, message) => {
    const r = applyOps(doc, [op]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  test("人が送ると、変えた要素と消した要素が、人の変更として記録される", () => {
    const applied = apply(doc, [restore({ rm: ["below"], set: [set("m", { x: 200 })] })]);
    expect(Object.keys(trackHuman(doc, applied)).sort()).toEqual(["below", "m"]);
  });
});

test("手元の位置と大きさを、届いた要素に写す", () => {
  const remote: El = { id: "n", type: "shape", x: 0, y: 0, w: 220, h: 110, text: "届いた文", color: "green" };
  const local: El = { id: "n", type: "shape", x: 50, y: 60, w: 300, h: 120, text: "手元の文" };
  expect(withGeometry(remote, local)).toEqual({ id: "n", type: "shape", x: 50, y: 60, w: 300, h: 120, text: "届いた文", color: "green", points: undefined, from: undefined, to: undefined });
});

describe("画面の操作 → 元に戻す で、列で並べるセクションが元に戻る", () => {
  // 列で並べるセクション s（a〜e。3 列なので 2 行、高さ 312）。d を指すコメント k と、2 行めの上の線 l がある。
  // s のすぐ下（間 18）に付箋 near。s の右の端にかかる付箋 edge（中心は枠の外。2 行めの高さから始まる）。その下に、列で並べるセクション t（t1・t2）と u（背の違う p・q・r が 1 行）。
  // 外に、幅 300 の付箋 free、自由に置くセクション box、box の下の端の外にある大きい画像 img（列の幅に縮めると、中心が box に入る）。
  // 右に、中身が 1 つの列で並べるセクション one（1 列、o1）と、そのすぐ下の付箋 under。空の列で並べるセクション empty。
  // 付箋 pin と、それを指すコメント kp
  const section = (id: string, x: number, y: number, cols = 3) => ({ op: "add", el: { id, type: "container", x, y, w: cols === 1 ? 504 : 740, cols } });
  const note = (into: string, id: string, extra: Record<string, unknown> = {}) => ({ op: "add", in: into, el: { id, type: "shape", text: id, ...extra } });
  const top = apply(emptyDoc("t"), [section("s", 0, 0), ...["a", "b", "c", "d", "e"].map((id) => note("s", id))]).doc;
  const cols = apply(top, [
    { op: "add", el: { id: "k", type: "comment", x: 30, y: 200, on: "d" } },
    { op: "add", el: { id: "l", type: "stroke", points: [[300, 190], [330, 220]] } },
    { op: "add", el: { id: "near", type: "shape", x: 600, y: 330, w: 100, h: 40, text: "すぐ下" } },
    { op: "add", el: { id: "edge", type: "shape", x: 700, y: 250, w: 100, h: 110, text: "右の端" } },
    section("t", 0, 400),
    note("t", "t1"),
    note("t", "t2"),
    section("u", 0, 700),
    note("u", "p", { h: 40 }),
    note("u", "q", { h: 200 }),
    note("u", "r", { h: 40 }),
    { op: "add", el: { id: "free", type: "shape", x: 800, y: 0, w: 300, h: 110, text: "外" } },
    { op: "add", el: { id: "box", type: "container", x: 1200, y: 0, w: 300, h: 200 } },
    { op: "add", el: { id: "img", type: "image", src: "x.png", x: 1250, y: 100, w: 400, h: 300 } },
    section("one", 2000, 0, 1),
    note("one", "o1"),
    { op: "add", el: { id: "under", type: "shape", x: 2000, y: 256, w: 220, h: 110, text: "下" } },
    section("empty", 2000, 600, 1),
    { op: "add", el: { id: "pin", type: "shape", x: 2600, y: 610, w: 220, h: 110, text: "指される" } },
    { op: "add", el: { id: "kp", type: "comment", x: 2830, y: 660, on: "pin" } },
    { op: "add", el: { id: "area", type: "comment", x: 2600, y: 900, w: 80, h: 60 } },
  ]).doc;

  test.each<[string, Gesture | null]>([
    ["先頭の付箋を消す", rm(cols, ["a"])],
    ["途中の付箋を消す", rm(cols, ["c"])],
    ["末尾の付箋を消す", rm(cols, ["e"])],
    ["付箋を足す（行は増えない）", { ...add({}), ops: [note("s", "new")] }],
    ["下のセクションに付箋を足す", { ...add({}), ops: [note("t", "new")] }],
    ["上のセクションの行が増えて、下のセクションが押し下げられる", { ...add({}), ops: [note("s", "n1"), note("s", "n2")] }],
    ["付箋の高さを増やして、下のセクションが押し下げられる", resize(cols, "d", 220, 400)],
    ["ドラッグで、先頭の付箋を 3 番めの後ろへ入れ替える", drag(cols, ["a"], 500, 10)],
    ["ドラッグで、末尾の付箋を先頭へ入れ替える", drag(cols, ["e"], -250, -130)],
    ["外の付箋を、ドラッグでセクションへ入れる（幅が列にそろう）", drag(cols, ["free"], -530, 60)],
    ["中の付箋を、ドラッグでセクションの外へ出す", drag(cols, ["b"], 900, 0)],
    ["付箋を、ドラッグで別の列のセクションへ移す", drag(cols, ["t1"], 500, -300)],
    ["列の数を変える", setOps(cols, [{ id: "s", patch: { cols: 2 } }])],
    ["列で並べるのをやめる", setOps(cols, [{ id: "s", patch: { cols: null } }])],
    ["セクションの幅を変える（右の列の中身が外れる）", resize(cols, "s", 504, 312)],
    ["セクションごと動かす（画面は、セクションと中身を選んだ順に送る）", drag(cols, ["s"], 1500, 1040)],
    ["中身を先に選んでから、セクションごと動かす", drag(cols, ["c", "a", "s"], 1500, 1040)],
    ["下のセクションを、上のセクションの上へ動かす", drag(cols, ["t"], 0, -700)],
    ["最後の行の付箋を全部消す（行が減る）", rm(cols, ["d", "e"])],
    ["最後の行の付箋を、ドラッグで外へ出す（行が減る）", drag(cols, ["d", "e"], 0, 900)],
    ["セクションの付箋を全部消す（題名の帯だけに畳まれる）", rm(cols, ["t1", "t2"])],
    ["背の違う付箋が並ぶ行で、背の高い付箋を、ドラッグで先頭へ入れ替える", drag(cols, ["q"], -250, -10)],
    ["大きい画像を、ドラッグでセクションへ入れる（列の幅になり、戻すと元の大きさ）", drag(cols, ["img"], -950, -40)],
    // 4 回めのレビューの例
    ["縦に並んだ 3 つのセクションを、一緒に少しだけ下へ動かす（動かす量が、セクションの高さより小さい）", drag(cols, ["s", "t", "u"], 0, 300)],
    ["空のセクションを、付箋を指すコメントの上へ落とす（戻すときに、コメントを連れて帰らない）", drag(cols, ["empty"], 600, 10)],
    ["セクションを、範囲のコメントのある場所へ落とす（戻すときに、連れて帰らない）", drag(cols, ["one"], 600, 880)],
    ["最後の行の付箋と、それを指すコメントを、付箋、コメントの順に消す", rm(cols, ["d", "k"])],
    ["中身が 1 つのセクションで、付箋を消す（畳まれたセクションが、戻すと元の高さになる）", rm(cols, ["o1"])],
    ["付箋と、それを指すコメントを消す（戻したコメントが、ずれない）", rm(cols, ["pin", "kp"])],
    ["セクションを、外の付箋の上へ落として取り込む（戻すと元の高さになり、元の場所の下の付箋を取り込まない）", drag(cols, ["one"], 600, 550)],
  ])("%s", (_name, g) => expectRoundtrip(cols, g));

  test("操作を積んだ後に、エージェントが別の要素を消していても、残りは戻る", () => {
    const sent = send(cols, { ...add({}), ops: [note("s", "n1"), note("s", "n2")] });
    if (!sent) throw new Error("操作が断られた");
    // 押し下げられたセクションの中の付箋を、エージェントが消す
    const later = apply(sent.applied.doc, [{ op: "rm", id: "t1" }]).doc;
    const back = undone(later, sent.undo);
    expect(find(back, "n1")).toBeUndefined();
    expect(find(back, "t")).toMatchObject({ y: 400 });
    // t2 は、エージェントが t1 を消したときの詰め直しで、左の列へ動いている。戻すのは、積んだ操作で変わった y だけ
    expect(find(back, "t2")).toMatchObject({ x: 24, y: 452 });
  });

  test("付箋を消した後に、エージェントが同じセクションの別の付箋を消していても、戻した後に付箋が重ならない", () => {
    // 2 列のセクションに a1〜a4。画面で a1 を消し、エージェントが a3 を消す
    const board = apply(emptyDoc("t"), [{ op: "add", el: { id: "g", type: "container", x: 0, y: 0, w: 504, cols: 2 } }, ...["a1", "a2", "a3", "a4"].map((id) => note("g", id))]).doc;
    const sent = send(board, rm(board, ["a1"]));
    if (!sent) throw new Error("操作が断られた");
    const later = apply(sent.applied.doc, [{ op: "rm", id: "a3" }]).doc;
    // 積んだ操作は、a4 の x だけを戻すので、書いた形では a4 が a2 に重なる。最後の並べ直しが離す
    const back = undone(later, sent.undo);
    expect(["a1", "a2", "a4"].map((id) => [id, find(back, id)?.x, find(back, id)?.y])).toEqual([["a1", 24, 52], ["a2", 260, 52], ["a4", 24, 178]]);
    expect(find(back, "g")).toMatchObject({ h: 312 });
  });
});

describe("画面の操作と「元に戻す」の間に、エージェントが同じセクションへ書き込んでも、崩れない", () => {
  // 列で並べるセクション S1（2 列、p1〜p3、高さ 312）の下に、自由に置くセクション S3
  const board = apply(emptyDoc("t"), [
    { op: "add", el: { id: "s1", type: "container", x: 0, y: 0, w: 504, cols: 2 } },
    ...["p1", "p2", "p3"].map((id) => ({ op: "add", in: "s1", el: { id, type: "shape", text: id } })),
    { op: "add", el: { id: "s3", type: "container", x: 0, y: 372, w: 504, h: 200 } },
  ]).doc;
  const into = (id: string) => ({ op: "add", in: "s1", el: { id, type: "shape", text: id } });
  const s1 = (doc: Doc): string[] => {
    const c = find(doc, "s1");
    return c ? membersOf(doc.elements, c).map((m) => m.id).sort() : [];
  };

  test.each<[string, Gesture | null, unknown[], string[], Record<string, Op>]>([
    ["付箋を消す → 3 枚足される → 戻す", rm(board, ["p3"]), [into("z1"), into("z2"), into("z3")], ["p1", "p2", "p3", "z1", "z2", "z3"], { s1: { y: 0, h: 438 }, s3: { y: 498 } }],
    ["セクションを上へ動かす → 1 枚足される → 戻す", drag(board, ["s1"], 0, -400), [into("z1")], ["p1", "p2", "p3", "z1"], { s1: { y: 0, h: 312 }, z1: { x: 260, y: 178 }, s3: { y: 372 } }],
    ["2 列を 1 列にする → 1 枚足される → 戻す", setOps(board, [{ id: "s1", patch: { cols: 1 } }]), [into("z1")], ["p1", "p2", "p3", "z1"], { s1: { cols: 2, h: 312 }, z1: { x: 260, y: 178, w: 220, h: 110 } }],
    ["付箋を消して縮む → compact で下が詰まる → 戻す", rm(board, ["p3"]), [{ op: "compact" }], ["p1", "p2", "p3"], { s1: { h: 312 }, s3: { y: 372 } }],
    ["外の付箋を入れる → 1 枚足される → 戻す（入れた付箋だけが外へ戻る）", { ...add({}), ops: [{ op: "add", el: { id: "o", type: "shape", x: 300, y: 200, w: 220, h: 110 } }] }, [into("z1")], ["p1", "p2", "p3", "z1"], { s1: { h: 312 } }],
  ])("%s", (_name, g, agent, members, want) => {
    const sent = g ? send(board, g) : null;
    if (!sent) throw new Error("操作が断られた");
    const back = undone(apply(sent.applied.doc, agent).doc, sent.undo);
    expect(s1(back)).toEqual(members);
    for (const [id, w] of Object.entries(want)) expect(find(back, id)).toMatchObject(w);
    // 並べ直しが落ち着いている
    const again = apply(back, [{ op: "title", title: "次" }]);
    expect([again.updated, again.order]).toEqual([[], undefined]);
  });
});

test("変わった要素が無い操作では、元に戻す操作を作らない", () => {
  expect(restoreOp(byId(base), [{ op: "title", title: "題名" }], apply(base, [{ op: "title", title: "題名" }]))).toBeNull();
});
