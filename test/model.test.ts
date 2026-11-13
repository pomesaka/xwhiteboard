import { describe, expect, test } from "bun:test";
import { applyOps, commentPayload, emptyDoc, parseDoc, parseEl, pendingChanges, serialize, trackHuman, type Doc } from "../src/shared/model.ts";

function build(ops: unknown[], base: Doc = emptyDoc("t")): Doc {
  const r = applyOps(base, ops);
  if (!r.ok) throw new Error(r.error);
  return r.value.doc;
}

const find = (doc: Doc, id: string) => doc.elements.find((e) => e.id === id);

describe("parseEl は、形に合わない要素を理由を付けて断る", () => {
  test.each([
    ["type が無い", { id: "a" }, "type は"],
    ["知らない項目", { id: "a", type: "shape", x: 0, y: 0, w: 1, h: 1, colour: "red" }, "shape に colour は無い"],
    ["知らない色", { id: "a", type: "shape", x: 0, y: 0, w: 1, h: 1, color: "black" }, "color は"],
    ["文字に text が無い", { id: "a", type: "text", x: 0, y: 0 }, "text が要る"],
    ["矢印の端が無い", { id: "a", type: "arrow", from: "b" }, "to が要る"],
    ["画像に src も svg も無い", { id: "a", type: "image", x: 0, y: 0, w: 1, h: 1 }, "src か svg"],
    ["画像の src が上のフォルダを指す", { id: "a", type: "image", x: 0, y: 0, w: 1, h: 1, src: "../x.png" }, "src は"],
    ["画像の src が絶対パス", { id: "a", type: "image", x: 0, y: 0, w: 1, h: 1, src: "/etc/x.png" }, "src は"],
    ["大きさが 0", { id: "a", type: "shape", x: 0, y: 0, w: 0, h: 1 }, "w は正の数値"],
    ["線の点が 1 つ", { id: "a", type: "stroke", points: [[0, 0]] }, "points は"],
  ])("%s", (_name, raw, message) => {
    const r = parseEl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe("add は、書かなかった id・大きさ・場所を決める", () => {
  test.each([
    ["空のボードの最初の要素は原点", [], { type: "shape", text: "a" }, { id: "e1", x: 0, y: 0, w: 220, h: 110 }],
    ["2 つめは、全体の右に間を空けて置く", [{ op: "add", el: { type: "shape" } }], { type: "shape" }, { id: "e2", x: 280, y: 0, w: 220, h: 110 }],
    ["座標を書いたら、そのまま置く", [], { id: "n1", type: "shape", x: 5, y: 7, w: 10, h: 20 }, { id: "n1", x: 5, y: 7, w: 10, h: 20 }],
  ])("%s", (_name, before, el, expected) => {
    const doc = build([...before, { op: "add", el }]);
    expect(find(doc, expected.id)).toMatchObject(expected);
  });
});

describe("add の in は、セクションの中で重ならない場所に置く", () => {
  const section = { op: "add", el: { id: "s", type: "container", x: 100, y: 100, w: 504, h: 160 } };
  const note = (id: string, extra: Record<string, unknown> = {}) => ({ op: "add", in: "s", el: { id, type: "shape", ...extra } });

  test.each([
    ["1 つめは左上", [note("a")], "a", { x: 124, y: 152 }],
    ["2 つめは右隣", [note("a"), note("b")], "b", { x: 360, y: 152 }],
    ["幅に収まらなければ次の行", [note("a"), note("b"), note("c")], "c", { x: 124, y: 278 }],
    ["横いっぱいの要素は、空いている行の先頭", [note("a"), note("w", { w: 456, h: 84 })], "w", { x: 124, y: 278 }],
    ["背の低い要素の下の隙間を埋める", [note("a", { h: 40 }), note("b"), note("c", { h: 40 })], "c", { x: 124, y: 208 }],
  ])("%s", (_name, ops, id, expected) => {
    expect(find(build([section, ...ops]), id)).toMatchObject(expected);
  });

  test.each([
    ["中身が増えたら、セクションが下へ伸びる", [note("a"), note("b"), note("c")], { w: 504, h: 312 }],
    ["セクションより広い要素を入れたら、横へ伸びる", [note("a", { w: 600 })], { w: 648, h: 186 }],
  ])("%s", (_name, ops, expected) => {
    expect(find(build([section, ...ops]), "s")).toMatchObject(expected);
  });
});

describe("下にあるものは、上のセクションが伸びるか、上に差し込まれると、段ごと下へずれる", () => {
  // s（左上）と v（右上）が 1 段め、t（左下）と u（右下）が 2 段め。m は t の中身、head はいちばん上の見出し
  const grid = [
    { op: "add", el: { id: "head", type: "text", x: 100, y: 0, text: "見出し" } },
    { op: "add", el: { id: "s", type: "container", x: 100, y: 100, w: 504, h: 160 } },
    { op: "add", el: { id: "v", type: "container", x: 700, y: 100, w: 504, h: 160 } },
    { op: "add", el: { id: "t", type: "container", x: 100, y: 320, w: 504, h: 160 } },
    { op: "add", el: { id: "u", type: "container", x: 700, y: 320, w: 504, h: 160 } },
    { op: "add", el: { id: "m", type: "shape", x: 124, y: 372 } },
  ];
  const fill = ["a", "b", "c"].map((id) => ({ op: "add", in: "s", el: { id, type: "shape" } }));
  const insert = [{ op: "add", above: "s", el: { id: "sum", type: "container" } }];

  test.each([
    ["伸びたセクションの真下のセクションは、間を保って下がる", fill, "t", { x: 100, y: 472 }],
    ["同じ段の隣の列も、上をそろえたまま下がる", fill, "u", { x: 700, y: 472 }],
    ["下がるセクションの中身も一緒に下がる", fill, "m", { x: 124, y: 524 }],
    ["伸びたセクションと同じ段のものは動かない", fill, "v", { x: 700, y: 100 }],
    ["set でセクションの高さを増やしても、下のセクションは間を保って下がる", [{ op: "set", id: "s", patch: { h: 300 } }], "t", { x: 100, y: 460 }],
    ["set でセクションを動かしただけなら、何も動かない", [{ op: "set", id: "s", patch: { y: 90 } }], "t", { x: 100, y: 320 }],
    ["セクションが伸びなければ、何も動かない", [{ op: "add", in: "s", el: { id: "a", type: "shape", h: 40 } }], "t", { x: 100, y: 320 }],
    ["above で足した要素は、指した要素があった場所に入る", insert, "sum", { x: 100, y: 100 }],
    ["above で指した要素は、足した要素の高さと間のぶん下がる", insert, "s", { x: 100, y: 320 }],
    ["above で指した要素と同じ段のものも下がる", insert, "v", { x: 700, y: 320 }],
    ["above で指した要素より下の段も下がる", insert, "m", { x: 124, y: 592 }],
    ["above で指した要素より上のものは動かない", insert, "head", { x: 100, y: 0 }],
  ])("%s", (_name, ops, id, expected) => {
    expect(find(build([...grid, ...ops]), id)).toMatchObject(expected);
  });
});

describe("セクションの中の要素が下へ伸びると、同じセクションの下の中身が下がり、入りきらなければセクションも伸びる", () => {
  // セクション s に、付箋が 2 列 2 段（a・b が上、c・d が下）。その下に別のセクション t
  const base = build([
    { op: "add", el: { id: "s", type: "container", x: 0, y: 0, w: 504 } },
    ...["a", "b", "c", "d"].map((id) => ({ op: "add", in: "s", el: { id, type: "shape", text: id } })),
    { op: "add", el: { id: "t", type: "container", x: 0, y: 372, w: 504, h: 160 } },
    { op: "add", el: { id: "note", type: "text", x: 24, y: 152 + 110 + 16 + 110 + 300, text: "遠くの文字" } },
  ]);
  const taller = [{ op: "set", id: "a", patch: { h: 160 } }];

  test.each([
    ["はじめの配置（確かめ）", [], "c", { x: 24, y: 178 }],
    ["伸びた付箋の真下の付箋は、間を保って下がる", taller, "c", { x: 24, y: 228 }],
    ["同じ段の隣の付箋も、上をそろえたまま下がる", taller, "d", { x: 260, y: 228 }],
    ["伸びた付箋と同じ段の付箋は動かない", taller, "b", { x: 260, y: 52 }],
    ["セクションは、中身が入る高さまで伸びる", taller, "s", { y: 0, h: 362 }],
    ["伸びたセクションの下のセクションは、間を保って下がる", taller, "t", { y: 422 }],
    ["下の段の付箋を伸ばしても、上の段は動かない", [{ op: "set", id: "c", patch: { h: 160 } }], "a", { x: 24, y: 52 }],
    ["文字が増えて高くなった表でも、下の中身が下がる", [{ op: "add", in: "s", el: { id: "tb", type: "table", w: 456, rows: [["1"]] } }, { op: "add", in: "s", el: { id: "e", type: "shape" } }, { op: "set", id: "tb", patch: { rows: [["1"], ["2"], ["3"]] } }], "e", { x: 24, y: 423 }],
    ["位置も一緒に変えたときは、押し下げない", [{ op: "set", id: "a", patch: { h: 160, y: 60 } }], "c", { x: 24, y: 178 }],
    ["低くしたときは、何も動かない", [{ op: "set", id: "a", patch: { h: 60 } }], "c", { x: 24, y: 178 }],
  ])("%s", (_name, ops, id, expected) => {
    expect(find(build(ops, base), id)).toMatchObject(expected);
  });
});

describe("compact は、空きすぎた段の間を詰める", () => {
  // 見出し、1 段め（s1 と、その隣の背の高い s2）、大きく空けて 2 段め（s3・s4）、さらに空けて文字
  const base = build([
    { op: "add", el: { id: "head", type: "text", x: 0, y: 0, text: "見出し" } },
    { op: "add", el: { id: "s1", type: "container", x: 0, y: 80, w: 504, h: 600 } },
    { op: "add", el: { id: "s2", type: "container", x: 564, y: 80, w: 504, h: 300 } },
    { op: "add", el: { id: "m", type: "shape", x: 24, y: 132 } },
    { op: "add", el: { id: "s3", type: "container", x: 0, y: 1500, w: 504, h: 200 } },
    { op: "add", el: { id: "s4", type: "container", x: 564, y: 1500, w: 504, h: 200 } },
    { op: "add", el: { id: "n", type: "shape", x: 24, y: 1552 } },
    { op: "add", el: { id: "foot", type: "text", x: 0, y: 2400, text: "結び" } },
  ]);
  const compact = [{ op: "compact" }];
  const fit = [{ op: "compact", fit: true }];

  test.each([
    ["間が 60 以下のところは動かない", compact, "s1", { y: 80, h: 600 }],
    ["空きすぎた下の段は、上の段でいちばん背の高いものから 60 の位置まで上がる", compact, "s3", { y: 740 }],
    ["同じ段の隣も、上をそろえて上がる", compact, "s4", { y: 740 }],
    ["上がるセクションの中身も一緒に上がる", compact, "n", { y: 792 }],
    ["その下の空きも詰まる", compact, "foot", { y: 1000 }],
    ["fit を付けなければ、セクションの高さは変わらない", compact, "s1", { h: 600 }],
    ["fit を付けると、セクションは中身が入る高さまで低くなる", fit, "s1", { y: 80, h: 186 }],
    ["fit でも、中身の無いセクションの高さは変わらない", fit, "s2", { h: 300 }],
    ["fit で低くなったぶんも詰まる（隣の s2 の下から 60）", fit, "s3", { y: 440 }],
  ])("%s", (_name, ops, id, expected) => {
    expect(find(build(ops, base), id)).toMatchObject(expected);
  });

  test("詰めるところが無ければ、何も変えない", () => {
    const tight = build(compact, base);
    const r = applyOps(tight, compact);
    expect(r.ok && r.value.updated).toEqual([]);
  });
});

describe("set は、書いた項目だけを変える", () => {
  const base = build([{ op: "add", el: { id: "a", type: "shape", x: 1, y: 2, text: "前", tag: "論点", color: "yellow" } }]);

  test.each([
    ["文字だけ変えても、位置は残る", { text: "後" }, { x: 1, y: 2, text: "後", tag: "論点" }],
    ["位置だけ変えても、文字は残る", { x: 50, y: 60 }, { x: 50, y: 60, text: "前" }],
  ])("%s", (_name, patch, expected) => {
    expect(find(build([{ op: "set", id: "a", patch }], base), "a")).toMatchObject(expected);
  });

  test("null を書いた項目は消える", () => {
    expect(find(build([{ op: "set", id: "a", patch: { tag: null } }], base), "a")).not.toHaveProperty("tag");
  });
});

describe("操作のまとまりは、1 つでも失敗したら全部を取りやめる", () => {
  const base = build([{ op: "add", el: { id: "a", type: "shape" } }]);

  test.each([
    ["無い要素を直す", [{ op: "set", id: "a", patch: { text: "x" } }, { op: "set", id: "zz", patch: {} }], "ops[1]"],
    ["同じ id をもう一度足す", [{ op: "add", el: { id: "a", type: "shape" } }], "はもうある"],
    ["型を変える", [{ op: "set", id: "a", patch: { type: "text" } }], "type は変えられない"],
    ["無い要素へ矢印を引く", [{ op: "add", el: { type: "arrow", from: "a", to: "nope" } }], "端の要素が無い"],
    ["無いセクションに入れる", [{ op: "add", in: "nope", el: { type: "shape" } }], "in のセクションが無い"],
    ["in と座標を両方書く", [{ op: "add", in: "a", el: { type: "shape", x: 0, y: 0 } }], "どれか 1 つだけ書く"],
    ["無い要素の上に差し込む", [{ op: "add", above: "nope", el: { type: "shape" } }], "above の要素が無い"],
  ])("%s", (_name, ops, message) => {
    const r = applyOps(base, ops);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
    expect(base.elements).toHaveLength(1);
    expect(find(base, "a")).not.toHaveProperty("text");
  });
});

describe("Claude に送る一覧には、前に送ってから人が変えたことだけが、要素ごとに 1 件で入る", () => {
  const start = build([
    { op: "add", el: { id: "a", type: "shape", x: 0, y: 0, text: "前" } },
    { op: "add", el: { id: "b", type: "shape", x: 300, y: 0, text: "b" } },
  ]);
  // 人とエージェントの操作を順に適用する。人の操作だけを記録する（サーバーの /api/ops と同じ手順）
  const run = (steps: { by: "human" | "agent"; ops: unknown[] }[]) => {
    let doc = start;
    for (const step of steps) {
      const r = applyOps(doc, step.ops);
      if (!r.ok) throw new Error(r.error);
      doc = step.by === "human" ? { ...r.value.doc, pending: trackHuman(doc, r.value) } : r.value.doc;
    }
    return pendingChanges(doc).map((c) => [c.id, c.action, c.fields ?? [], c.before?.text ?? null, c.el.text ?? null]);
  };
  const human = (...ops: unknown[]) => ({ by: "human" as const, ops });
  const agent = (...ops: unknown[]) => ({ by: "agent" as const, ops });
  const set = (id: string, patch: Record<string, unknown>) => ({ op: "set", id, patch });
  const add = (id: string) => ({ op: "add", el: { id, type: "shape", x: 0, y: 300, text: "新" } });
  const rm = (id: string) => ({ op: "rm", id });

  test.each([
    ["人が直した要素は、変わった項目と前後が入る", [human(set("a", { text: "後" }))], [["a", "changed", ["text"], "前", "後"]]],
    ["何度直しても 1 件で、前は最初の値", [human(set("a", { text: "中" })), human(set("a", { text: "後", x: 5 }))], [["a", "changed", ["x", "text"], "前", "後"]]],
    ["動かしただけなら、変わった項目は位置だけ", [human(set("a", { x: 9, y: 9 }))], [["a", "changed", ["x", "y"], "前", "前"]]],
    ["直してから元に戻したら入らない", [human(set("a", { text: "後" })), human(set("a", { text: "前" }))], []],
    ["人が足した要素", [human(add("n"))], [["n", "added", [], null, "新"]]],
    ["人が足してから消した要素は入らない", [human(add("n")), human(rm("n"))], []],
    ["人が消した要素は、消える前の要素が入る", [human(rm("a"))], [["a", "removed", [], null, "前"]]],
    ["直してから消したら、前に送った時点の要素が入る", [human(set("a", { text: "後" })), human(rm("a"))], [["a", "removed", [], null, "前"]]],
    ["消してから元に戻したら入らない", [human(rm("a")), human({ op: "add", el: { id: "a", type: "shape", x: 0, y: 0, text: "前", shape: "note", w: 220, h: 110 } })], []],
    ["エージェントが直した要素は入らない", [agent(set("a", { text: "後" }), add("n"), rm("b"))], []],
    ["人が直した後にエージェントが消した要素は入らない", [human(set("a", { text: "後" })), agent(rm("a"))], []],
  ])("%s", (_name, steps, expected) => {
    expect(run(steps)).toEqual(expected);
  });

  test("送っていない変更は、ファイルに書いて読み直しても残る", () => {
    const r = applyOps(start, [set("a", { text: "後" })]);
    if (!r.ok) throw new Error(r.error);
    const doc = { ...r.value.doc, pending: trackHuman(start, r.value) };
    expect(parseDoc(serialize(doc))).toEqual({ ok: true, value: doc });
  });
});

describe("コメント", () => {
  const base = build([
    { op: "add", el: { id: "sec", type: "container", x: 0, y: 0, w: 504, h: 300, title: "議題" } },
    { op: "add", el: { id: "in1", type: "shape", x: 24, y: 52, text: "枠の中", tag: "論点", color: "yellow" } },
    { op: "add", el: { id: "in2", type: "table", x: 24, y: 180, head: ["a"], rows: [["1"]] } },
    { op: "add", el: { id: "out", type: "shape", x: 800, y: 52, text: "枠の外" } },
    { op: "add", el: { id: "area", type: "comment", x: 10, y: 40, w: 300, h: 260 } },
    { op: "add", el: { id: "pin", type: "comment", x: 900, y: 60, on: "out" } },
    { op: "add", el: { id: "free", type: "comment", x: 2000, y: 2000 } },
  ]);
  const human = { by: "human" as const, at: "2026-11-13T10:00:00+09:00" };
  const claude = { by: "claude" as const, at: "2026-11-13T10:01:00+09:00" };
  const say = (doc: Doc, id: string, text: string, ctx: typeof human | typeof claude): Doc => {
    const r = applyOps(doc, [{ op: "say", id, text }], ctx);
    if (!r.ok) throw new Error(r.error);
    return r.value.doc;
  };
  const talked = say(say(say(base, "area", "これは何？", human), "area", "論点です", claude), "area", "期限は？", human);

  test("やりとりは、書いた人と時刻を付けて、順に積まれる", () => {
    expect(find(talked, "area")?.thread).toEqual([
      { by: "human", at: human.at, text: "これは何？" },
      { by: "claude", at: claude.at, text: "論点です" },
      { by: "human", at: human.at, text: "期限は？" },
    ]);
  });

  test("Claude に届ける中身は、今回の本文、それまでのやりとり、枠、枠の中の要素の文字", () => {
    expect(commentPayload(talked, "area")).toEqual({
      ok: true,
      value: {
        kind: "comment",
        id: "area",
        text: "期限は？",
        thread: [
          { by: "human", at: human.at, text: "これは何？" },
          { by: "claude", at: claude.at, text: "論点です" },
        ],
        resolved: false,
        anchor: { type: "area", x: 10, y: 40, w: 300, h: 260 },
        elements: [
          { id: "in1", type: "shape", text: "枠の中", tag: "論点", color: "yellow", shape: "note" },
          { id: "in2", type: "table", head: ["a"], rows: [["1"]] },
        ],
      },
    });
  });

  test.each([
    ["要素を指すピンは、その要素だけを付ける", "pin", { type: "pin", x: 900, y: 60, on: "out" }, ["out"]],
    ["何も指さないピンは、要素を付けない", "free", { type: "pin", x: 2000, y: 2000 }, []],
  ])("%s", (_name, id, anchor, ids) => {
    const r = commentPayload(say(base, id, "ここ", human), id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect<unknown>(r.value.anchor).toEqual(anchor);
    expect(r.value.elements.map((e) => e.id)).toEqual(ids);
  });

  test.each([
    ["人の本文が無いコメントは送れない", "area", "送る本文が無い"],
    ["コメントでない要素は送れない", "in1", "コメントが無い"],
  ])("%s", (_name, id, message) => {
    const r = commentPayload(base, id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  test.each([
    ["指している要素を動かすと、ピンも同じだけ動く", [{ op: "set", id: "out", patch: { x: 850, y: 100 } }], "pin", { x: 950, y: 108 }],
    ["指している要素の文字を直しても、ピンは動かない", [{ op: "set", id: "out", patch: { text: "直した" } }], "pin", { x: 900, y: 60 }],
    ["ほかの要素を動かしても、ピンは動かない", [{ op: "set", id: "in1", patch: { x: 100 } }], "pin", { x: 900, y: 60 }],
  ])("%s", (_name, ops, id, expected) => {
    expect(find(build(ops, base), id)).toMatchObject(expected);
  });

  test("コメントは、自動で置く場所をふさがず、全体の範囲にも数えない", () => {
    const doc = build([{ op: "add", in: "sec", el: { id: "n", type: "shape" } }, { op: "add", el: { id: "right", type: "shape" } }], base);
    // in1 の右隣（枠のコメントが重なっている場所）に入り、遠くのコメント free の右ではなく out の右に置かれる
    expect(find(doc, "n")).toMatchObject({ x: 260, y: 52 });
    expect(find(doc, "right")).toMatchObject({ x: 1080, y: 0 });
  });

  test("人がコメントを足したり書いたりしても、ボード全体の変更の一覧には入らない", () => {
    const r = applyOps(base, [{ op: "say", id: "area", text: "これは？" }, { op: "add", el: { id: "c9", type: "comment", x: 0, y: 0 } }, { op: "rm", id: "pin" }], human);
    if (!r.ok) throw new Error(r.error);
    expect(pendingChanges({ ...r.value.doc, pending: trackHuman(base, r.value) })).toEqual([]);
  });
});

test("要素を消すと、そこに付いていた矢印も消え、消えたものが返る", () => {
  const base = build([
    { op: "add", el: { id: "a", type: "shape" } },
    { op: "add", el: { id: "b", type: "shape" } },
    { op: "add", el: { id: "c", type: "shape" } },
    { op: "add", el: { id: "ab", type: "arrow", from: "a", to: "b" } },
    { op: "add", el: { id: "bc", type: "arrow", from: "b", to: "c" } },
  ]);
  const r = applyOps(base, [{ op: "rm", id: "a" }]);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.doc.elements.map((e) => e.id)).toEqual(["b", "c", "bc"]);
  expect(r.value.removed.map((e) => e.id).sort()).toEqual(["a", "ab"]);
});

test("ファイルは 1 要素 1 行で書かれ、読み直すと同じボードになる", () => {
  const doc = build([
    { op: "title", title: "定例" },
    { op: "add", el: { type: "shape", text: "改行\nあり" } },
    { op: "add", el: { type: "table", head: ["a", "b"], rows: [["1", "2"]] } },
  ]);
  const text = serialize(doc);
  expect(text.split("\n").filter((l) => l.startsWith("    {"))).toHaveLength(2);
  expect(parseDoc(text)).toEqual({ ok: true, value: doc });
});
