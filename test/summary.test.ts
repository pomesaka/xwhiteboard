import { describe, expect, test } from "bun:test";
import { type IssueKind } from "../src/shared/check.ts";
import { checkBoard } from "./check-style.ts";
import { keptOnFocus } from "../src/shared/focus.ts";
import { SUMMARY_HEAD_H, SUMMARY_MIN_W, SUMMARY_PAD_BOTTOM, SUMMARY_ROW_H, SUMMARY_W, applyOps, boxOf, emptyDoc, parseDoc, parseEl, serialize, summaryHeight, type Doc, type El } from "../src/shared/model.ts";
import { collect, itemsOf, summarize } from "../src/shared/summary.ts";

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
    ["知らない状態", band({ show: "done" }), "show は、状態の名前（decided | open | todo | carried | priority）か、{ status・who・tag } の組"],
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

  // 高さは、集めた行の数から決まる。書かれた h は使わない（列で並べるセクションの h と同じ扱い）
  test.each<[string, unknown[]]>([
    ["add", [add(band({ h: 999 }))]],
    ["set", [add(band()), { op: "set", id: "sum", patch: { h: 999 } }]],
    ["別のまとまりの set", [add(band()), add(note("a", { status: "decided" })), add(note("b", { x: 300, status: "decided" }))]],
  ])("h は、%s で書かれても、行の数からの高さになる", (_name, ops) => {
    const first = build(ops);
    const r = applyOps(first, [{ op: "set", id: "sum", patch: { h: 999 } }]);
    if (!r.ok) throw new Error(r.error);
    const rows = summarize(first.elements).decided.length;
    expect([first.elements[0]?.h, r.value.doc.elements[0]?.h]).toEqual([summaryHeight(rows), summaryHeight(rows)]);
  });

  // 付箋を先に足して、帯を 3 行で置き、その下に 60 空けてセクションを置く
  const s3 = summaryHeight(3) + 60;
  test.each<[string, number | null, number, number]>([
    // 前の版は h を書かなかった。帯の下は、今の行の数の高さに合わせて空けてある。最初の操作で高さを書くだけで、下は動かさない
    ["h の無い帯（前の版で書いた帯）は、高さを書くだけで、下は動かさない", null, summaryHeight(3), s3],
    // h があって合わない（手で直した、など）なら、次の操作で直して、変わったぶん下を動かす
    ["h が行の数と合わない帯は、次の操作で直して、下を動かす", summaryHeight(1), summaryHeight(3), s3 + summaryHeight(3) - summaryHeight(1)],
  ])("12: %s", (_name, written, h, sy) => {
    const doc = build([...[0, 1, 2].map((i) => add(note(`d${i}`, { x: 3000 + i * 240, y: -600, status: "decided" }))), add(band()), add(section("s", 0, s3))]);
    const text = serialize(doc).replace(`"h":${summaryHeight(3)}`, written === null ? "" : `"h":${written}`).replace('"w":480,}', '"w":480}').replace(',,', ',');
    const read = parseDoc(text);
    if (!read.ok) throw new Error(read.error);
    expect(read.value.elements.find((e) => e.id === "sum")?.h).toBe(written ?? undefined);
    const next = applyOps(read.value, [{ op: "title", title: "x" }]);
    expect(next.ok && [next.value.doc.elements.find((e) => e.id === "sum")?.h, next.value.doc.elements.find((e) => e.id === "s")?.y]).toEqual([h, sy]);
  });

  test("ファイルの h が合っていなくても、読むだけでは直さず、次の操作で直す", () => {
    const text = serialize(build([add(band()), add(note("a", { status: "decided" })), add(note("b", { x: 300, status: "decided" }))])).replace(`"h":${summaryHeight(2)}`, '"h":999');
    const read = parseDoc(text);
    if (!read.ok) throw new Error(read.error);
    expect(read.value.elements[0]?.h).toBe(999);
    const next = applyOps(read.value, [{ op: "title", title: "x" }]);
    expect(next.ok && next.value.doc.elements[0]?.h).toBe(summaryHeight(2));
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
    const all = collect(doc.elements);
    expect(doc.elements.map((el) => itemsOf(all, el).map((r) => r.item.id))).toEqual([["b"], [], []]);
  });
});

describe("帯の高さ", () => {
  // 画面の CSS（board.css の .summary の .shead の height、.srow の height）と同じ値。変えるときは、CSS も変える
  test("題名の帯 58、1 行 38、下の余白 12。既定の幅 480", () => {
    expect([SUMMARY_HEAD_H, SUMMARY_ROW_H, SUMMARY_PAD_BOTTOM, SUMMARY_W]).toEqual([58, 38, 12, 480]);
  });

  test.each([
    ["0 行は、「無し」の 1 行ぶん", 0, 108],
    ["1 行", 1, 108],
    ["2 行", 2, 146],
    ["30 行", 30, 1210],
  ])("%s", (_name, rows, expected) => {
    expect(summaryHeight(rows)).toBe(expected);
  });

  const notes = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => add(note(`n${i}`, { x: i * 240, status: "decided", ...extra })));
  test.each<[string, unknown[], number]>([
    ["集める付箋が無い", [add(band())], summaryHeight(0)],
    ["1 枚", [add(band()), ...notes(1)], summaryHeight(1)],
    ["3 枚", [add(band()), ...notes(3)], summaryHeight(3)],
    ["別の状態の付箋は数えない", [add(band()), ...notes(3, { status: "open" })], summaryHeight(0)],
    ["幅に入りきらない長い見出しでも、折り返さないので変わらない", [add(band({ w: 240 })), ...notes(2, { title: "とても長い見出し".repeat(10) })], summaryHeight(2)],
    ["幅を変えても変わらない", [add(band({ w: 900 })), ...notes(2)], summaryHeight(2)],
    ["show を変えると、集め直す", [add(band()), ...notes(3), { op: "set", id: "sum", patch: { show: "open" } }], summaryHeight(0)],
    ["付箋を消すと減る", [add(band()), ...notes(3), { op: "rm", id: "n0" }], summaryHeight(2)],
  ])("まとまりの最後に、行の数からの高さが h に書かれる: %s", (_name, ops, expected) => {
    const sum = build(ops).elements.find((e) => e.id === "sum");
    expect([sum?.h, sum ? boxOf(sum)?.h : null]).toEqual([expected, expected]);
  });

  test("ファイルに書いて読み直しても、高さが残る", () => {
    const doc = build([add(band()), ...notes(3)]);
    const r = parseDoc(serialize(doc));
    expect(r.ok && r.value.elements[0]?.h).toBe(summaryHeight(3));
  });

  test("高さをまだ書いていない帯（前の版のファイル）は、1 行ぶんの大きさ", () => {
    expect(boxOf({ id: "x", type: "summary", show: "decided", x: 0, y: 0 })).toEqual({ x: 0, y: 0, w: 480, h: summaryHeight(1) });
  });
});

describe("帯の高さが変わると、下にあるものが動く", () => {
  // 数字は、帯の高さの式（summaryHeight）から求める。h(n) は n 行の帯の高さ。帯の下に 60 空けて置いたものは、h(1) + 60 から始まる
  const h = summaryHeight;
  const below = h(1) + 60;
  // 会議のボードの形。帯 3 つを横に並べ、その下に、議題のセクションを 2 列で置く。状態つきの付箋は、帯にもセクションにも関わらない、上の離れた所に置く
  const A = add(band({ id: "A", show: "decided", x: 0, y: 0 }));
  const B = add(band({ id: "B", show: "open", x: 540, y: 0 }));
  const C = add(band({ id: "C", show: "todo", x: 1080, y: 0 }));
  const sec = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => add(section(id, x, y, { w: 740, h: 300, ...extra }));
  /** 状態 status の付箋を n 枚。帯の行になるだけで、置き場所は動かす相手にならない（帯より上で、横も重ならない） */
  const rowsOf = (status: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => add(note(`${status}${from + i}`, { x: 3000 + (from + i) * 240, y: -600, status })));
  const at = (doc: Doc, ...ids: string[]): Record<string, number | undefined> => Object.fromEntries(ids.map((id) => [id, doc.elements.find((e) => e.id === id)?.y]));
  const hOf = (doc: Doc, id: string): number | undefined => doc.elements.find((e) => e.id === id)?.h;
  const step = (doc: Doc, ops: unknown[]): Doc => {
    const r = applyOps(doc, ops);
    if (!r.ok) throw new Error(r.error);
    return r.value.doc;
  };

  test("帯が 1 つ。行が増えると下のセクションと中身が下がり、減ると上がり、元の行の数で元の場所に戻る", () => {
    // 帯（1 行）の下に、間を 60 空けてセクション。中に、状態の無い付箋 m（セクションの上の端から 58）
    let doc = build([A, sec("s", 0, below), add(note("m", { x: 24, y: below + 58 })), ...rowsOf("decided", 1)]);
    const at3 = (n: number) => ({ s: h(n) + 60, m: h(n) + 118 });
    expect([hOf(doc, "A"), at(doc, "s", "m")]).toEqual([h(1), at3(1)]);
    doc = step(doc, rowsOf("decided", 2, 1));
    expect([hOf(doc, "A"), at(doc, "s", "m")]).toEqual([h(3), at3(3)]);
    doc = step(doc, [{ op: "rm", id: "decided2" }]);
    expect([hOf(doc, "A"), at(doc, "s", "m")]).toEqual([h(2), at3(2)]);
    doc = step(doc, [{ op: "set", id: "decided1", patch: { status: null } }]);
    expect([hOf(doc, "A"), at(doc, "s", "m")]).toEqual([h(1), at3(1)]);
    // 0 行は「無し」の 1 行で、1 行と同じ高さ。下は動かない
    doc = step(doc, [{ op: "rm", id: "decided0" }]);
    expect([hOf(doc, "A"), at(doc, "s", "m")]).toEqual([h(1), at3(1)]);
  });

  test("帯の下に空けた間（60 でなくてもよい）は、行が増減しても保たれる", () => {
    let doc = build([A, sec("s", 0, h(1) + 200), ...rowsOf("decided", 1)]);
    doc = step(doc, rowsOf("decided", 3, 1));
    expect([hOf(doc, "A"), at(doc, "s")]).toEqual([h(4), { s: h(4) + 200 }]);
    doc = step(doc, [{ op: "rm", id: "decided1" }, { op: "rm", id: "decided2" }, { op: "rm", id: "decided3" }]);
    expect(at(doc, "s")).toEqual({ s: h(1) + 200 });
  });

  // 帯が 1 行のうちに、下に 60 空けてセクションを 2 段置き（下の段は 360 下）、その後に付箋を足す。
  // 帯 A は 3 行、B は 1 行、C は 0 行になり、セクションは、いちばん背の高い A の下に 60 空けた所へ下がる
  const meeting = (): Doc => build([A, B, C, sec("s1", 0, below), sec("s2", 800, below), sec("s3", 0, below + 360), sec("s4", 800, below + 360), ...rowsOf("decided", 3), ...rowsOf("open", 1)]);
  /** いちばん背の高い帯が n 行のときの、下の段の場所 */
  const rowsAt = (n: number) => ({ s1: h(n) + 60, s2: h(n) + 60, s3: h(n) + 420, s4: h(n) + 420 });
  test.each<[string, unknown[], Record<string, number>, Record<string, number>]>([
    ["背の低い帯が伸びても、いちばん高い帯を超えなければ、下は動かない", rowsOf("open", 2, 1), { A: h(3), B: h(3), C: h(1) }, rowsAt(3)],
    ["背の低い帯が、いちばん高い帯を超えたら、超えたぶんだけ、下の段が全部下がる", rowsOf("open", 4, 1), { A: h(3), B: h(5), C: h(1) }, rowsAt(5)],
    ["いちばん高い帯が縮むと、次に高い帯の下の端まで、下の段が全部上がる", [{ op: "rm", id: "decided0" }, { op: "rm", id: "decided1" }, { op: "rm", id: "decided2" }], { A: h(1), B: h(1), C: h(1) }, rowsAt(1)],
    ["いちばん高い帯が 1 行だけ縮む", [{ op: "rm", id: "decided0" }], { A: h(2), B: h(1), C: h(1) }, rowsAt(2)],
    [
      "1 つの操作で、片方の帯が縮み、もう片方が伸びる（決定の付箋を未決に変える）。下は、いちばん下の端の変わったぶんだけ、1 回動く",
      [{ op: "set", id: "decided0", patch: { status: "open" } }],
      { A: h(2), B: h(2), C: h(1) },
      rowsAt(2),
    ],
    ["どの帯の行も変わらない操作では、何も動かない", [add(note("free", { x: 3000, y: -900 }))], { A: h(3), B: h(1), C: h(1) }, rowsAt(3)],
  ])("帯が 3 つ並ぶ: %s", (_name, ops, heights, ys) => {
    const doc = step(meeting(), ops);
    expect([Object.fromEntries(["A", "B", "C"].map((id) => [id, hOf(doc, id)])), at(doc, "s1", "s2", "s3", "s4")]).toEqual([heights, ys]);
  });

  test("帯が 3 つ並ぶ: 行が増えて減って、元の数に戻ると、下の段も元の場所に戻る", () => {
    const start = meeting();
    let doc = step(start, rowsOf("open", 5, 1));
    doc = step(doc, rowsOf("todo", 7));
    expect(at(doc, "s1", "s3")).toEqual({ s1: rowsAt(7).s1, s3: rowsAt(7).s3 });
    doc = step(doc, [1, 2, 3, 4, 5].map((i) => ({ op: "rm", id: `open${i}` })));
    doc = step(doc, [0, 1, 2, 3, 4, 5, 6].map((i) => ({ op: "rm", id: `todo${i}` })));
    expect(doc.elements).toEqual(start.elements);
  });

  test.each<[string, unknown[], unknown[], Record<string, number>]>([
    ["同じ段に並ぶ要素（横にあって、帯の下の端より上から始まる）は動かない", [A, add(note("side", { x: 900, y: 40 })), sec("s", 0, below)], rowsOf("decided", 3), { side: 40, s: h(3) + 60 }],
    // side（帯でない要素）は、下の端が帯より深くても、基準に入らない。帯の伸びたぶん、下は下がる
    ["帯の横に、帯より下まである帯でない要素があっても、帯が伸びたぶん下がる", [A, add(note("side", { x: 500, y: 40 })), sec("s", 0, below)], rowsOf("decided", 3), { side: 40, s: h(3) + 60 }],
    ["同じ形で 4 行", [A, add(note("side", { x: 500, y: 40 })), sec("s", 0, below)], rowsOf("decided", 4), { side: 40, s: h(4) + 60 }],
    // 確かめで見つかった形（11）。帯の横の、関係の無い列（R1: 帯より背が高い、R2: 帯の下 48 から）が、基準に入らない
    ["帯の横の関係の無い列の要素は、基準に入らない", [A, add(note("R1", { x: 2000, y: 0, h: h(1) + 28 })), add(note("R2", { x: 2000, y: h(1) + 48 })), sec("T", 0, h(1) + 48)], rowsOf("decided", 3), { R1: 0, R2: h(3) + 48, T: h(3) + 48 }],
    ["帯の横に背の高いセクションがあっても、帯が伸びたぶん下がる", [A, sec("tallSec", 900, 0, { h: 600 }), sec("T", 0, below)], rowsOf("decided", 3), { tallSec: 0, T: h(3) + 60 }],
    ["帯より上の要素は動かない", [add(band({ id: "A", x: 0, y: 400 })), add(note("up", { x: 0, y: 0 })), sec("s", 0, 400 + below)], rowsOf("decided", 3), { up: 0, s: 400 + h(3) + 60 }],
    ["横が重ならない列の下の要素も、同じ高さから下なら、そろって動く", [A, sec("s", 0, below), add(note("far", { x: 900, y: below }))], rowsOf("decided", 3), { s: h(3) + 60, far: h(3) + 60 }],
    ["下に何も無ければ、高さだけが変わる", [A, add(note("side", { x: 600, y: 0 }))], rowsOf("decided", 3), { side: 0 }],
    ["動かした要素を指すコメントは、付いていく", [A, add(note("n", { x: 0, y: below })), add({ id: "k", type: "comment", x: 300, y: below + 8, on: "n" })], rowsOf("decided", 3), { n: h(3) + 60, k: h(3) + 68 }],
    ["固定した要素も動く", [A, add(note("n", { x: 0, y: below, locked: true }))], rowsOf("decided", 3), { n: h(3) + 60 }],
    ["帯を縦に 2 つ積む。上の帯が伸びると、下の帯も下がる", [A, add(band({ id: "B", show: "open", x: 0, y: below })), sec("s", 0, below + h(1) + 60)], rowsOf("decided", 3), { B: h(3) + 60, s: h(3) + 60 + h(1) + 60 }],
    [
      "背の低い帯のすぐ下（間 10）に置いた付箋は、伸びた帯に重ならないように、同じ間で下がる",
      // s は A の真下だけ（n と重ならない幅）。A が伸びて s が下がった後、B が伸びる
      [A, B, add(note("n", { x: 540, y: h(1) + 10 })), sec("s", 0, below, { w: 480 }), ...rowsOf("decided", 3)],
      rowsOf("open", 2),
      { n: h(2) + 10, s: h(3) + 60 + h(2) - h(1) },
    ],
  ])("%s", (_name, base, ops, ys) => {
    const doc = step(build(base), ops);
    expect(at(doc, ...Object.keys(ys))).toEqual(ys);
  });

  // 境界。帯 A（x 0〜480、1 行）が 3 行に伸びる
  test.each<[string, unknown[], Record<string, number>]>([
    ["帯の下の端にぴったり接して始まる要素（間 0）も下がる", [A, add(note("n", { x: 0, y: h(1) }))], { n: h(3) }],
    ["右の端が帯の左の端にぴったり接する要素は、横が重ならないので、真下でなく横の列として扱う（同じ高さから下なので、そろって下がる）", [add(band({ id: "A", x: 300, y: 0 })), add(note("n", { x: 80, y: below })), sec("s", 300, below)], { n: h(3) + 60, s: h(3) + 60 }],
    ["右の端が帯の左の端にぴったり接するだけで、帯の真下に何も無ければ、動かない", [add(band({ id: "A", x: 300, y: 0 })), add(note("n", { x: 80, y: below }))], { n: below }],
    ["左の端が帯の右の端にぴったり接する要素は、横が重ならないので、帯の真下に何も無ければ動かない", [A, add(note("n", { x: 480, y: below }))], { n: below }],
    ["前から帯に重ねて置かれていた要素（帯の下の端より上から始まる）は動かず、基準にも入らない", [A, add(note("n", { x: 100, y: 40 })), sec("s", 0, below)], { n: 40, s: h(3) + 60 }],
    [
      "帯の真下の要素を指すコメントは、帯の横（動かす段より上）にあっても、指す要素と一緒に動く",
      [A, add(note("n", { x: 0, y: below })), add({ id: "k", type: "comment", x: 600, y: 20, on: "n" })],
      { n: h(3) + 60, k: 20 + h(3) - h(1) },
    ],
    [
      "前から重なって置かれていた背の高い要素は基準に入らず、帯のすぐ下の要素は、帯との間を保って下がる",
      [A, add(note("tall", { x: 400, y: 0, w: 220, h: 300 })), add(note("n", { x: 0, y: h(1) + 10, w: 600 }))],
      { tall: 0, n: h(3) + 10 },
    ],
  ])("境界: %s", (_name, base, ys) => {
    const doc = step(build([...base, ...rowsOf("decided", 1)]), rowsOf("decided", 2, 1));
    expect(at(doc, ...Object.keys(ys))).toEqual(ys);
  });

  test("縮むとき、動かさない帯でない要素（tall）に重なる手前で止まる", () => {
    // 帯は始めから 3 行。s1 は帯の下 60、s2 は tall の下 26。2 行減ると帯は 2 行ぶん縮むが、s2 は tall に重なる手前の 26 しか上がれない
    const s1 = h(3) + 60;
    const s2 = s1 + 288;
    const base = build([...rowsOf("decided", 3), A, sec("s1", 0, s1), add(note("tall", { x: 800, y: 0, h: s2 - 26 })), sec("s2", 800, s2)]);
    expect(at(base, "s1", "s2")).toEqual({ s1, s2 });
    const doc = step(base, [{ op: "rm", id: "decided0" }, { op: "rm", id: "decided1" }]);
    expect(at(doc, "s1", "s2", "tall")).toEqual({ s1: s1 - 26, s2: s2 - 26, tall: 0 });
  });

  test("前から帯に重ねて置かれていた下の段は、伸びた帯の下の端まで下がる（ほかの帯が深くても）", () => {
    // B（右、背が高い）は、前から s に重なっている。A が伸びても、いちばん下の端（B の 300）は変わらないが、s は A に重ならない所まで下がる
    // B は 5 行。下の端は s より下だが、中心は s の上の端より上（s の中身には数えない）
    const base = build([A, ...rowsOf("open", 5), add(band({ id: "B", show: "open", x: 540, y: 0 })), sec("s", 0, below, { w: 1100 })]);
    expect([hOf(base, "B"), at(base, "s")]).toEqual([h(5), { s: below }]);
    // A が 4 行に伸びて、s の上の端を超えるので、s は A の下の端まで下がる
    const doc = step(base, rowsOf("decided", 4));
    expect([hOf(doc, "A"), at(doc, "s")]).toEqual([h(4), { s: h(4) }]);
  });

  test("帯だけのボードでも、h の無い帯に高さを書く", () => {
    const text = serialize(build([add(band())])).replace(`"h":${h(1)}`, "").replace(',,', ',').replace(",}", "}");
    const read = parseDoc(text);
    if (!read.ok) throw new Error(read.error);
    expect(read.value.elements[0]?.h).toBeUndefined();
    const next = applyOps(read.value, [{ op: "title", title: "x" }]);
    expect(next.ok && next.value.doc.elements[0]?.h).toBe(h(1));
  });

  test("帯の show を set で変えて行の数が変わると、下も動く", () => {
    const doc = step(build([...rowsOf("decided", 3), A, sec("s", 0, h(3) + 60)]), [{ op: "set", id: "A", patch: { show: "open" } }]);
    expect([hOf(doc, "A"), at(doc, "s")]).toEqual([h(1), { s: below }]);
  });

  test("縮んでも、動かさない要素に重なる所までは上げない（下の段の上に、帯より背の高い要素がある）", () => {
    // tall は、下の段のセクション s2 の真上にある、動かさない付箋（下の端 300）。帯（3 行で 148）が縮んでも、s1・s2 は、tall の下の端との間を保つ
    let doc = build([A, add(note("tall", { x: 800, y: 0, h: 300 })), sec("s1", 0, 360), sec("s2", 800, 360), ...rowsOf("decided", 3)]);
    doc = step(doc, [{ op: "rm", id: "decided0" }, { op: "rm", id: "decided1" }]);
    expect([hOf(doc, "A"), at(doc, "s1", "s2", "tall")]).toEqual([h(1), { s1: 360, s2: 360, tall: 0 }]);
  });

  test.each<[string, unknown[], string[]]>([
    ["付箋に状態を付ける。帯と、下がったセクションと中身が、返事の updated に入る", [{ op: "set", id: "m", patch: { status: "decided" } }], ["A", "s", "m"]],
    ["同じまとまりで付箋を足して消す。帯は updated に入らない", [add(note("x", { x: 3000, y: -900, status: "decided" })), { op: "rm", id: "x" }], []],
    ["行に出る文字だけを変える（題名）。帯は updated に入らない", [{ op: "set", id: "decided0", patch: { title: "見出し" } }], ["decided0"]],
    ["同じ状態をもう一度書く。帯は updated に入らない", [{ op: "set", id: "decided0", patch: { status: "decided" } }], ["decided0"]],
    ["帯を動かす（x・y の set）。高さは同じで、下は動かない", [{ op: "set", id: "A", patch: { x: 2000, y: 0 } }], ["A"]],
  ])("返事の updated: %s", (_name, ops, expected) => {
    const doc = build([A, sec("s", 0, below), add(note("m", { x: 24, y: below + 58 })), ...rowsOf("decided", 1)]);
    const r = applyOps(doc, ops);
    expect(r.ok ? r.value.updated.map((e) => e.id) : r.error).toEqual(expected);
  });

  test("場所を書かない操作（above）の前に、帯の高さを合わせる", () => {
    // 同じまとまりで、行を増やしてから、帯の下のセクションの上に足す。足す場所は、伸びた帯に押し下げられた後のセクションの場所
    const doc = step(build([A, sec("s", 0, below), ...rowsOf("decided", 1)]), [...rowsOf("decided", 2, 1), { op: "add", above: "s", el: { id: "n", type: "shape", text: "上に足す" } }]);
    // n は、伸びた帯に押し下げられた後の s の場所。s は、n の高さ（110）と間 60 のぶん、さらに下がる
    expect(at(doc, "n", "s")).toEqual({ n: h(3) + 60, s: h(3) + 60 + 170 });
  });
});

describe("帯を足す", () => {
  test.each<[string, unknown[], Record<string, unknown>]>([
    ["場所を書かなければ、全体の右に、上をそろえて置く。幅は 480", [add(note("a", { x: 100, y: 50, status: "decided" })), add({ id: "sum", type: "summary", show: "decided" })], { x: 380, y: 50, w: 480, h: summaryHeight(1) }],
    ["空のボードでは、原点に置く", [add({ id: "sum", type: "summary", show: "decided" })], { x: 0, y: 0, w: 480, h: summaryHeight(0) }],
    ["場所を書けば、その場所", [add(band({ x: 40, y: 80, w: 300 }))], { x: 40, y: 80, w: 300, h: summaryHeight(0) }],
    [
      "above で、要素の上に足す。指した要素と、その段より下が下がる",
      [add(note("a", { x: 100, y: 50 })), { op: "add", above: "a", el: { id: "sum", type: "summary", show: "decided" } }],
      { x: 100, y: 50, w: 480, h: summaryHeight(0) },
    ],
  ])("%s", (_name, ops, expected) => {
    expect(build(ops).elements.find((e) => e.id === "sum")).toMatchObject(expected);
  });

  test("above で足した帯のぶん、指した要素が下がる（帯の 1 行ぶんの高さと、間 60）", () => {
    const doc = build([add(note("a", { x: 100, y: 50 })), { op: "add", above: "a", el: { id: "sum", type: "summary", show: "decided" } }]);
    expect(doc.elements.find((e) => e.id === "a")?.y).toBe(50 + summaryHeight(0) + 60);
  });

  test.each([
    ["列で並べるセクション", { cols: 2 }],
    ["自由に置くセクション", {}],
  ])("in で、%s に帯は足せない", (_name, extra) => {
    const r = applyOps(emptyDoc("t"), [add(section("c", 0, 0, extra)), { op: "add", in: "c", el: { id: "sum", type: "summary", show: "decided" } }]);
    expect(r.ok ? "" : r.error).toContain("まとめの帯（summary）は、in でセクションに足せない");
  });

  test("場所を書かずに足した帯のあるボードに、場所を書かずに付箋を足すと、帯を含む全体の右に置く", () => {
    const doc = build([add({ id: "sum", type: "summary", show: "decided" }), add({ id: "n", type: "shape", text: "付箋" })]);
    expect(doc.elements.find((e) => e.id === "n")).toMatchObject({ x: 540, y: 0 });
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

  test.each<[string, unknown[], string[]]>([
    ["帯と付箋が重なる", [add(band()), add(note("a", { x: 100, y: 20 }))], ["overlap:sum,a"]],
    ["間を空けて置いた帯と付箋", [add(band()), add(note("a", { x: 0, y: 200 }))], []],
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
