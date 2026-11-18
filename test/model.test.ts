import { describe, expect, test } from "bun:test";
import { applyOps, colWidth, membersOf, sectionTop, statusBadge, commentPayload, emptyDoc, parseDoc, parseEl, pendingChanges, serialize, trackHuman, type Doc } from "../src/shared/model.ts";

function build(ops: unknown[], base: Doc = emptyDoc("t")): Doc {
  const r = applyOps(base, ops);
  if (!r.ok) throw new Error(r.error);
  return r.value.doc;
}

const find = (doc: Doc, id: string) => doc.elements.find((e) => e.id === id);

/** 操作のまとまりを、順に 1 つずつ渡す */
const run = (batches: unknown[][], base: Doc = emptyDoc("t")): Doc => batches.reduce((doc: Doc, ops) => build(ops, doc), base);

/** 並べ終わったボードに、中身と関係のない操作をしたときに動く要素の id（並びが変われば "order" も）。並べ直しが落ち着いていれば、空 */
function settled(doc: Doc): string[] {
  const r = applyOps(doc, [{ op: "title", title: "x" }]);
  if (!r.ok) throw new Error(r.error);
  return [...r.value.updated.map((e) => e.id), ...(r.value.order ? ["order"] : [])];
}

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
    ["画像の href が http でもボードでもない", { id: "a", type: "image", x: 0, y: 0, w: 1, h: 1, src: "x.png", href: "javascript:alert(1)" }, "href は"],
    ["画像の href が絶対パスのボード", { id: "a", type: "image", x: 0, y: 0, w: 1, h: 1, src: "x.png", href: "/m/a.board.json" }, "href は"],
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
    ["cols の無いセクションが伸びても、下の端にかかっていた要素は動かない", [{ op: "add", el: { id: "st", type: "shape", x: 124, y: 220, w: 100, h: 110 } }, ...fill], "st", { x: 124, y: 220 }],
    ["cols の無いセクションを set で動かしても、中身は付いていかない", [{ op: "set", id: "t", patch: { x: 150 } }], "m", { x: 124, y: 372 }],
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
    ["大きく伸ばしても、下の付箋は 1 回だけ下がり、枠の中に残る", [{ op: "set", id: "a", patch: { h: 300 } }], "c", { x: 24, y: 368 }],
    ["大きく伸ばしたときも、セクションは中身が入る高さになる", [{ op: "set", id: "a", patch: { h: 300 } }], "s", { y: 0, h: 502 }],
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

// ---- 列で並べるセクション（cols）----

type Want = Record<string, Record<string, unknown>>;
const sec = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ op: "add", el: { id, type: "container", x, y, w: 504, cols: 2, ...extra } });
const cont = (id: string, x: number, y: number, w: number, h: number) => ({ op: "add", el: { id, type: "container", x, y, w, h } });
const into = (section: string, el: Record<string, unknown>) => ({ op: "add", in: section, el: { type: "shape", ...el } });
const shape = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ op: "add", el: { id, type: "shape", x, y, w: 220, h: 110, ...extra } });
const set = (id: string, patch: Record<string, unknown>) => ({ op: "set", id, patch });
const rm = (id: string) => ({ op: "rm", id });

/** 結果の要素が期待どおりで、並べ直しが落ち着いている（関係のない操作をしても、何も動かない）ことを確かめる */
function expectBoard(doc: Doc, want: Want): void {
  for (const [id, w] of Object.entries(want)) expect(find(doc, id)).toMatchObject(w);
  expect(settled(doc)).toEqual([]);
}

test("コメントを動かしても、そのコメントを指すコメントは動かない", () => {
  const doc = run([[{ op: "add", el: { id: "k1", type: "comment", x: 30, y: 60 } }, { op: "add", el: { id: "k2", type: "comment", x: 40, y: 70, on: "k1" } }], [set("k1", { x: 100 })]]);
  expect(find(doc, "k2")).toMatchObject({ x: 40, y: 70 });
});

test("セクションの中身は、中心が枠の中にある要素。中のセクションと矢印は入らない", () => {
  const doc = build([cont("s", 0, 0, 504, 312), cont("inner", 100, 100, 100, 100), { op: "add", el: { id: "ar", type: "arrow", from: [30, 60], to: [300, 200] } }, shape("a", 24, 52), shape("out", 600, 52), { op: "add", el: { id: "l", type: "stroke", points: [[30, 60], [60, 90]] } }]);
  const s = find(doc, "s");
  expect(s && membersOf(doc.elements, s).map((e) => e.id)).toEqual(["a", "l"]);
});

describe("cols を書いたセクションは、中身を列に詰めて並べ、高さを中身に合わせる", () => {
  // s は (100,100)、幅 504、2 列。マスは x が 124・360、y が 152・278・404
  const section = sec("s", 100, 100, { h: 160 });
  const note = (id: string, extra: Record<string, unknown> = {}) => into("s", { id, ...extra });
  const abc = [section, note("a"), note("b"), note("c")];
  const at = (x: number, y: number, extra: Record<string, unknown> = {}) => ({ x, y, w: 220, ...extra });
  const image = note("i", { type: "image", src: "x.png", w: 400, h: 300 });

  // 操作のまとまりを、順に 1 つずつ渡す
  const rows: [string, unknown[][], Want][] = [
    ["中身が無ければ、題名の帯だけに畳む", [[section]], { s: { h: 52 } }],
    ["in で足すと、左上から列に入り、行が増えるとセクションが伸びる", [abc], { a: at(124, 152), b: at(360, 152), c: at(124, 278), s: { h: 312 } }],
    ["消すと詰め直して、セクションが縮む", [[...abc, rm("a")]], { b: at(124, 152), c: at(360, 152), s: { h: 186 } }],
    ["行の高さは、その行でいちばん背の高いものに合わせる", [[section, note("a", { h: 200 }), note("b"), note("c")]], { c: at(124, 368), s: { h: 402 } }],
    ["座標で置いたものも、中心がセクションの中なら並べる", [[section, note("a")], [shape("z", 400, 160, { w: 90, h: 60 })]], { a: at(124, 152), z: at(360, 152, { h: 60 }) }],
    ["セクションの外へ出すと、残りを詰める", [[...abc, set("a", { x: 900, y: 900 })]], { a: { x: 900, y: 900 }, b: at(124, 152), c: at(360, 152) }],
    ["セクションの幅を変えると、列の幅が変わる", [[...abc, set("s", { w: 704 })]], { a: { x: 124, w: 320 }, b: { x: 460, w: 320 } }],
    ["列の数を変えると、並べ直す", [[...abc, set("s", { cols: 1 })]], { a: { x: 124, y: 152, w: 456 }, b: { x: 124, y: 278 }, c: { x: 124, y: 404 }, s: { h: 438 } }],
    ["後から cols を書いても並べる", [[cont("s", 100, 100, 504, 400), shape("p", 300, 300, { w: 100, h: 50 }), set("s", { cols: 2 })]], { p: at(124, 152, { h: 50 }), s: { h: 126 } }],
    ["伸びたぶん、下のものを押し下げる。上にあるものは動かない", [[section, shape("top", 100, 0, { w: 100, h: 50 }), shape("u", 100, 300, { w: 100, h: 50 }), note("a"), note("b"), note("c")]], { s: { h: 312 }, u: { y: 472 }, top: { y: 0 } }],
    ["縮んでも、下のものは上へ詰めない", [[section, shape("u", 100, 300, { w: 100, h: 50 }), note("a"), note("b"), note("c")], [rm("a")]], { s: { h: 186 }, u: { y: 472 } }],
    ["伸びても届かないほど下にあるものは、動かない", [[section, shape("u", 100, 900)], [note("a"), note("b"), note("c")]], { s: { h: 312 }, u: { y: 900 } }],
    ["同じ段の隣は動かず、下の段は隣の列もそろって下がる", [[section, cont("v", 700, 100, 504, 160), cont("t", 100, 320, 504, 160), cont("u", 700, 320, 504, 160), note("a"), note("b"), note("c")]], { v: { y: 100 }, t: { x: 100, y: 472 }, u: { x: 700, y: 472 } }],
    ["真下に何も無ければ、隣の列の下の段は、セクションも付箋も動かない", [[section, cont("u", 700, 320, 504, 160), shape("p", 1300, 320), note("a"), note("b"), note("c")]], { s: { h: 312 }, u: { y: 320 }, p: { y: 320 } }],
    ["上下に並んだ cols のセクションは、上が伸びると、下が中身ごと下がる", [[section, sec("s2", 100, 320), into("s2", { id: "p" })], [note("a"), note("b"), note("c")]], { s: { h: 312 }, s2: { y: 472, h: 186 }, p: at(124, 524) }],
    ["畳まれたセクションに in で足した要素は、仮の場所が下の cols のセクションの枠に入っても、足した先に並ぶ", [[sec("low", 100, 212), section], [note("tall", { h: 200 })]], { tall: at(124, 152), s: { h: 276 }, low: { y: 436, h: 52 } }],
    ["in で足した後に、同じまとまりで座標で置いた付箋も、中身になる", [[sec("s", 100, 100, { h: 312 }), note("a"), shape("b", 124, 278)]], { a: at(124, 152), b: at(360, 152) }],
    ["in で足した後に、同じまとまりで左上へ動かした要素は、足した要素より前に入る", [[...abc, set("c", { x: 110, y: 140 })]], { c: at(124, 152), a: at(360, 152), b: at(124, 278) }],
    ["cols を null にすると、並べ直しをやめる", [abc, [set("s", { cols: null })], [rm("a")]], { b: at(360, 152), c: at(124, 278), s: { h: 312 } }],
    [
      "文字・表・ガントを in で足すと、幅が列の幅になる",
      [[section, note("tx", { type: "text", text: "x" }), note("tb", { type: "table", rows: [["1"]] }), note("g", { type: "gantt", bars: [{ name: "a", start: "2026-01", end: "2026-02" }] })]],
      { tx: { w: 220 }, tb: { w: 220 }, g: { w: 220 } },
    ],
    ["画像は、縦横の比を保って列の幅になる", [[section, image]], { i: { w: 220, h: 165 } }],
    ["セクションの幅を変えると、画像も列の幅に合わせ直す", [[section, image], [set("s", { w: 704 })]], { i: { w: 320, h: 240 } }],
    ["要素を指すコメントは、並べ直しに付いていく", [abc, [{ op: "add", el: { id: "k", type: "comment", x: 130, y: 290, on: "c" } }], [rm("a")]], { c: at(360, 152), k: { x: 366, y: 164 } }],
    [
      "範囲のコメント、線、中のセクションは、並べ直しで動かない",
      [abc, [{ op: "add", el: { id: "k", type: "comment", x: 130, y: 160, w: 50, h: 50 } }, { op: "add", el: { id: "l", type: "stroke", points: [[130, 160], [200, 200]] } }, cont("in", 130, 290, 100, 80)], [rm("a")]],
      { k: { x: 130, y: 160 }, l: { points: [[130, 160], [200, 200]] }, in: { x: 130, y: 290 } },
    ],
    // 決めごと: locked は、人が画面で動かすのを止める印。並べ直しは止めない
    ["固定した要素（locked）も、並べ直しで動く", [[section, note("a"), note("b", { locked: true })], [rm("a")]], { b: at(124, 152) }],
    ["後から論点と結論を書くと、中身がそのぶん下がる", [abc, [set("s", { question: "来期の採用は何人か", answer: "2 人" })]], { a: at(124, 229), c: at(124, 355), s: { h: 389 } }],
  ];
  test.each(rows)("%s", (_name, batches, want) => expectBoard(run(batches), want));

  test("並べ直しで動いた要素は updated に入り、並びが変わらなければ order は返らない", () => {
    const r = applyOps(build(abc), [rm("a")]);
    expect(r.ok && r.value.updated.map((e) => e.id).sort()).toEqual(["b", "c", "s"]);
    expect(r.ok && r.value.order).toBeUndefined();
  });

  test.each([
    ["0", 0],
    ["小数", 1.5],
    ["上限より大きい", 9],
  ])("cols が %s なら断る", (_name, cols) => {
    const r = parseEl({ id: "s", type: "container", x: 0, y: 0, w: 100, h: 100, cols });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cols は");
  });

  test.each([[1], [8]])("cols が %d なら通る", (cols) => {
    expect(parseEl({ id: "s", type: "container", x: 0, y: 0, w: 100, h: 100, cols }).ok).toBe(true);
  });

  test("cols のセクションに、in でセクションを足す操作は断る", () => {
    const r = applyOps(build(abc), [{ op: "add", in: "s", el: { id: "sub", type: "container" } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("in でセクションは足せない");
  });
});

describe("cols を書いたセクションの並ぶ順は、要素の並びで決まり、場所を書いた要素だけが、書いた場所に入る", () => {
  // a(124,152) b(360,152) / c(124,278) d(360,278)
  const base = build([sec("s", 100, 100), ...["a", "b", "c", "d"].map((id) => into("s", { id }))]);
  const grid = (...ids: string[]): Want => Object.fromEntries(ids.map((id, i) => [id, { x: 124 + (i % 2) * 236, y: 152 + Math.floor(i / 2) * 126 }]));

  const rows: [string, unknown[][], Want][] = [
    ["行の途中へ動かすと、そこに入る", [[set("d", { x: 350, y: 142 })]], grid("a", "d", "b", "c")],
    ["行の下半分へ動かしても、その行に入る", [[set("d", { x: 350, y: 230 })]], grid("a", "d", "b", "c")],
    ["先頭の要素の左上へ動かすと、先頭に入る", [[set("c", { x: 110, y: 140 })]], grid("c", "a", "b", "d")],
    ["どの要素よりも後ろへ動かすと、末尾に入る", [[set("a", { x: 380, y: 300 })]], grid("b", "c", "d", "a")],
    ["座標を書いて足すと、その場所に入る", [[shape("z", 350, 142)]], grid("a", "z", "b", "c", "d")],
    ["行の右端より右へ動かすと、次の行の先頭の前に入る", [[set("d", { x: 380, y: 142 })]], grid("a", "b", "d", "c")],
    ["同じ場所へ動かした要素どうしは、上の端の順に並ぶ", [[set("a", { x: 380, y: 300 }), set("b", { x: 370, y: 290 })]], grid("c", "d", "b", "a")],
    ["同じ場所へ、同じ高さに動かした要素どうしは、左の端の順に並ぶ", [[set("a", { x: 380, y: 300 }), set("b", { x: 370, y: 300 })]], grid("c", "d", "b", "a")],
    ["並べ直した後に order で並びを変えると、前に書いた場所でなく、要素の並びで並ぶ", [[set("d", { x: 350, y: 142 }), { op: "compact" }, { op: "order", id: "d", to: "front" }]], grid("a", "b", "c", "d")],
    ["高さだけを変えた要素は、次の行に重なっても、順が変わらない", [[set("a", { h: 300 }), set("b", { h: 300 })]], { a: { x: 124, y: 152 }, b: { x: 360, y: 152 }, c: { x: 124, y: 468 }, d: { x: 360, y: 468 }, s: { h: 502 } }],
    ["order で要素の並びを変えると、並ぶ順も変わる", [[{ op: "order", id: "a", to: "front" }]], grid("b", "c", "d", "a")],
    ["消した要素と、詰め直しで動いた要素を、1 つのまとまりで元の位置へ戻すと、元の並びに戻る", [[rm("b")], [set("c", { x: 124, y: 278 }), set("d", { x: 360, y: 278 }), shape("b", 360, 152)]], { ...grid("a", "b", "c", "d"), s: { h: 312 } }],
  ];
  test.each(rows)("%s", (_name, batches, want) => expectBoard(run(batches, base), want));

  test("背の違う行の、次の行の先頭へ動かすと、そこに入る", () => {
    const tall = build([sec("s", 100, 100), into("s", { id: "a", h: 200 }), ...["b", "c", "d", "e"].map((id) => into("s", { id }))]);
    expectBoard(build([set("e", { x: 114, y: 358 })], tall), { a: { x: 124, y: 152 }, b: { x: 360, y: 152 }, e: { x: 124, y: 368 }, c: { x: 360, y: 368 }, d: { x: 124, y: 494 } });
  });

  // a1・a2 は高さ 60、a3・a4 は 110。外に、高さ 200 の T
  const low = [sec("t1", 0, 0), into("t1", { id: "a1", h: 60 }), into("t1", { id: "a2", h: 60 }), into("t1", { id: "a3" }), into("t1", { id: "a4" }), shape("T", 600, 0, { h: 200 })];
  // 3 列に、a（高さ 40）、T（高さ 200）、c（高さ 40）
  const mixed = [sec("t1", 0, 0, { cols: 3 }), into("t1", { id: "a", h: 40 }), into("t1", { id: "T", h: 200 }), into("t1", { id: "c", h: 40 })];
  // 2 列に、a（高さ 40）と T（高さ 200）の行、c と d の行。外に z
  const steps = [sec("t1", 0, 0), into("t1", { id: "a", h: 40 }), into("t1", { id: "T", h: 200 }), into("t1", { id: "c" }), into("t1", { id: "d" }), shape("z", 600, 0)];
  const uneven: [string, unknown[][], Want][] = [
    ["行の先頭の要素より下でも、その行でいちばん背の高い要素の下の端までなら、その行に入る", [steps, [set("z", { x: 10, y: 150 })]], { z: { x: 24, y: 52 }, a: { x: 260, y: 52 }, T: { x: 24, y: 178 }, d: { x: 24, y: 394 } }],
    ["行の要素より背の高い要素を、先頭の左上へ動かすと、先頭に入る", [low, [set("T", { x: 10, y: 40 })]], { T: { x: 24, y: 52 }, a1: { x: 260, y: 52 }, a2: { x: 24, y: 268 }, a3: { x: 260, y: 268 }, a4: { x: 24, y: 394 } }],
    ["背の高い要素を先頭へ動かした後、元の座標へ戻すと、元の並びに戻る", [mixed, [set("T", { x: 10, y: 40 })], [set("T", { x: 181, y: 52 }), set("a", { x: 24 })]], { a: { x: 24 }, T: { x: 181 }, c: { x: 338 } }],
  ];
  test.each(uneven)("%s", (_name, batches, want) => expectBoard(run(batches), want));

  test("並ぶ順を変えると、中身が占めていた並びの位置の中で入れ替わり、order が返る", () => {
    // l は中身でない要素。重なり順で、中身より前面のままにする
    const withLine = build([{ op: "add", el: { id: "l", type: "stroke", points: [[0, 0], [10, 10]] } }], base);
    const r = applyOps(withLine, [set("d", { x: 350, y: 142 })]);
    expect(r.ok && r.value.doc.elements.map((e) => e.id)).toEqual(["s", "a", "d", "b", "c", "l"]);
    expect(r.ok && r.value.order).toEqual(["s", "a", "d", "b", "c", "l"]);
  });
});

describe("cols を書いたセクションは、動かすと中身を連れていき、伸びると下を押し下げ、外の要素を中身にしない", () => {
  // t1 は原点、幅 504、2 列。a1(24,52) a2(260,52) / a3(24,178) a4(260,178)、高さ 312
  const base4 = [sec("t1", 0, 0), ...["a1", "a2", "a3", "a4"].map((id) => into("t1", { id }))];
  const base = build(base4);
  const grid = { a1: { x: 24, y: 52 }, a2: { x: 260, y: 52 }, a3: { x: 24, y: 178 }, a4: { x: 260, y: 178 } };
  const movedX = { t1: { x: 600, h: 312 }, a1: { x: 624, y: 52 }, a2: { x: 860, y: 52 }, a3: { x: 624, y: 178 }, a4: { x: 860, y: 178 } };
  const movedY = { t1: { y: 126, h: 312 }, a1: { x: 24, y: 178 }, a2: { x: 260, y: 178 }, a3: { x: 24, y: 304 }, a4: { x: 260, y: 304 } };
  const comment = (id: string, x: number, y: number, extra: Record<string, unknown>) => ({ op: "add", el: { id, type: "comment", x, y, ...extra } });
  const stroke = (id: string, points: number[][]) => ({ op: "add", el: { id, type: "stroke", points } });

  const rows: [string, unknown[][], Want][] = [
    // 動かす
    ["セクション、中身の順に全部を動かすと、中身ごと移る", [[set("t1", { x: 600 }), set("a1", { x: 624 }), set("a2", { x: 860 }), set("a3", { x: 624 }), set("a4", { x: 860 })]], movedX],
    ["中身、セクションの順に全部を動かしても、中身は 1 回だけ動く", [[set("a1", { y: 178 }), set("a2", { y: 178 }), set("a3", { y: 304 }), set("a4", { y: 304 }), set("t1", { y: 126 })]], movedY],
    ["中身の 1 つ、セクション、残りの中身の順でも、同じ並びで移る", [[set("a1", { y: 178 }), set("t1", { y: 126 }), set("a2", { y: 178 }), set("a3", { y: 304 }), set("a4", { y: 304 })]], movedY],
    ["セクションだけを動かすと、中身が付いていく", [[set("t1", { x: 600 })]], movedX],
    ["セクションを動かすと、枠の中のコメントは 1 回だけ動く", [[comment("k", 30, 60, { on: "a1" })], [set("t1", { x: 600 })]], { k: { x: 630, y: 60 } }],
    ["セクションを動かすと、枠の外にあって中身を指すコメントも動く", [[comment("k", 600, 60, { on: "a2" })], [set("t1", { x: 1000 })]], { k: { x: 1600, y: 60 } }],
    [
      "セクションを動かすと、中のセクションとその中身、座標の矢印、線、範囲のコメントも動く",
      [
        // inner は中心が t1 の中。m は inner の中身で、t1 の枠の外にある
        [cont("inner", 300, 200, 400, 100), stroke("m", [[600, 220], [650, 260]]), { op: "add", el: { id: "ar", type: "arrow", from: [30, 60], to: [300, 200] } }, stroke("l", [[30, 60], [60, 90]]), comment("rc", 30, 200, { w: 60, h: 60 })],
        [set("t1", { x: 1000 })],
      ],
      { inner: { x: 1300, y: 200 }, m: { points: [[1600, 220], [1650, 260]] }, ar: { from: [1030, 60], to: [1300, 200] }, l: { points: [[1030, 60], [1060, 90]] }, rc: { x: 1030, y: 200 } },
    ],
    // 足す
    ["背の高い要素を in で足しても、末尾に入る", [[into("t1", { id: "tall", h: 400 })]], { ...grid, tall: { x: 24, y: 304 }, t1: { h: 728 } }],
    ["in で足した後に、座標を書いて枠の外へ動かした要素は、中身にならない", [[into("t1", { id: "a5" }), set("a5", { x: 900, y: 900 })]], { a5: { x: 900, y: 900 }, t1: { h: 312 } }],
    ["in で足した後に消して、同じ id を枠の外へ座標で足した要素は、中身にならない", [[into("t1", { id: "a5" }), rm("a5"), shape("a5", 900, 900)]], { a5: { x: 900, y: 900 }, t1: { h: 312 } }],
    ["in で足した要素に、同じまとまりで付けたコメントは、書いた場所に残る", [[into("t1", { id: "a5" }), comment("k", 30, 310, { on: "a5" })]], { a5: { x: 24, y: 304 }, k: { x: 30, y: 310 } }],
    ["in で足した後に、同じまとまりで cols を外しても、足した要素は並べた場所にある", [[into("t1", { id: "a5" }), set("t1", { cols: null })]], { a5: { x: 24, y: 304 } }],
    ["消した後に、同じまとまりで compact すると、空いた段が詰まる", [[into("t1", { id: "a5" }), shape("u", 0, 498)], [rm("a5"), rm("a4"), rm("a3"), { op: "compact" }]], { t1: { h: 186 }, u: { y: 246 } }],
    // 伸びる、高さを書く
    ["下の要素を指すコメントは、押し下げに付いていく", [[shape("u", 0, 372), comment("k", 500, 10, { on: "u" })], [into("t1", { id: "a5" })]], { u: { y: 498 }, k: { x: 500, y: 136 } }],
    ["下の端にかかる線は、押し下げない。その下のものも、余計に押し下げない", [[stroke("l", [[30, 300], [60, 330]]), shape("below", 0, 600)], [into("t1", { id: "a5" })]], { l: { points: [[30, 300], [60, 330]] }, below: { y: 600 }, t1: { h: 438 } }],
    ["枠の横の端にかかるだけの背の高い要素は、押し下げない。その下のものも、余計に押し下げない", [[shape("side", 490, -40, { h: 800 }), shape("below", 0, 500)], [into("t1", { id: "a5" })]], { side: { y: -40 }, below: { y: 500 }, t1: { h: 438 } }],
    ["下の端に重なって始まるセクションは、中身ごと押し下げる", [[cont("v", 0, 300, 504, 300), shape("m", 24, 352)], [into("t1", { id: "a5" })]], { a5: { x: 24, y: 304 }, v: { y: 498 }, m: { x: 24, y: 550 } }],
    // 「元に戻す」が送る形: 中身の元の座標と、セクションの元の h を、1 つのまとまりで書く
    ["最後の行の中身を消した後、元の座標へ足して h を戻すと、中身に戻る", [[rm("a3"), rm("a4")], [shape("a3", 24, 178), shape("a4", 260, 178), set("t1", { h: 312 })]], { ...grid, t1: { h: 312 } }],
    ["最後の行の中身を外へ出した後、元の座標へ戻して h を戻すと、中身に戻る", [[set("a3", { x: 900, y: 900 }), set("a4", { x: 900, y: 1100 })], [set("a3", { x: 24, y: 178 }), set("a4", { x: 260, y: 178 }), set("t1", { h: 312 })]], { ...grid, t1: { h: 312 } }],
    ["h を戻す高さまでの伸びでは、すぐ下にあるセクションを押し下げない", [[rm("a3"), rm("a4")], [cont("u", 0, 330, 504, 100)], [shape("a3", 24, 178), shape("a4", 260, 178), set("t1", { h: 312 })]], { ...grid, t1: { h: 312 }, u: { y: 330 } }],
    ["伸びた枠を縮める h と、押し下げられた外の要素の元の座標を書くと、外の要素は中身にならない", [[shape("b", 24, 372)], [into("t1", { id: "a5" })], [rm("a5"), set("b", { y: 372 }), set("t1", { h: 312 })]], { ...grid, t1: { h: 312 }, b: { x: 24, y: 372 } }],
    ["h を小さく書いても、枠の中へ置いた要素は中身になる", [[set("t1", { h: 100 }), shape("z", 24, 200)]], { z: { x: 260, y: 178 }, a4: { x: 24, y: 304 }, t1: { h: 438 } }],
    ["h を大きく書いても、伸びた枠に入る外の要素は押し下げる", [[shape("b", 0, 372)], [into("t1", { id: "a5" }), set("t1", { h: 800 })]], { t1: { h: 438 }, b: { y: 498 } }],
    ["書かれた h は、次の並べ直しまでしか効かない", [[set("t1", { h: 800 }), { op: "compact" }, shape("z", 24, 500)]], { z: { x: 24, y: 500 }, t1: { h: 312 } }],
    ["中身の高さを、中心が枠の下に出るほど増やしても、中身のまま", [[set("a1", { h: 700 })]], { a1: { x: 24, y: 52 }, a3: { x: 24, y: 768 }, t1: { h: 902 } }],
    ["h を set で増やしても、高さは中身のままで、下のものを押し下げない", [[shape("b", 0, 372)], [set("t1", { h: 800 })]], { t1: { h: 312 }, b: { y: 372 } }],
    ["下の端にかかっていた外の要素は、中身にならず、押し下げられる。横の列で、下の端より上から始まるものは動かない", [[shape("s", 24, 280), cont("v", 700, 290, 300, 100)], [into("t1", { id: "a5" })]], { ...grid, a5: { x: 24, y: 304 }, s: { x: 24, y: 498 }, v: { y: 290 }, t1: { h: 438 } }],
    ["下の端にかかる外の要素があるときに、中身の高さを増やしても、その要素は中身にならない", [[shape("s", 24, 280)], [set("a3", { h: 200 })]], { ...grid, s: { x: 24, y: 462 }, t1: { h: 402 } }],
    ["枠の上の端より上から始まり、中心が下の端より下にある外の要素も、中身にならず、押し下げられる", [[shape("s", 300, -40, { h: 800 })], [into("t1", { id: "a5" })]], { ...grid, a5: { x: 24, y: 304 }, s: { x: 300, y: 498 }, t1: { h: 438 } }],
    ["少し縮んだときは、下の端にかかるセクションを動かさない", [[cont("v", 0, 300, 504, 300)], [set("a3", { h: 100 }), set("a4", { h: 100 })]], { t1: { h: 302 }, v: { y: 300 } }],
    ["先に set で動かした要素は、後からセクションを動かしても、連れていかず、位置で中身かどうかを読む", [[set("a1", { x: 30, y: 60 }), set("t1", { x: 1000 })]], { a1: { x: 30, y: 60 }, a2: { x: 1024, y: 52 }, a3: { x: 1260, y: 52 }, t1: { x: 1000 } }],
    ["先に set で動かしたコメントは、指す要素を動かしても、もう一度は動かない", [[comment("k", 30, 200, { on: "a3" })], [set("k", { y: 300 }), set("a3", { x: 900, y: 900 })]], { k: { x: 30, y: 300 }, a3: { x: 900, y: 900 } }],
    ["少し縮んだときは、すぐ下にあるものを押し下げない", [[shape("u", 0, 332)], [set("a3", { h: 100 }), set("a4", { h: 100 })]], { t1: { h: 302 }, u: { y: 332 } }],
  ];
  test.each(rows)("%s", (_name, batches, want) => expectBoard(run(batches, base), want));

  // 空のボードから書く
  const tb = (n: number) => Array.from({ length: n }, (_, i) => [String(i)]);
  const fresh: [string, unknown[][], Want][] = [
    ["cols のセクションを足した後に、同じまとまりで座標で置いた付箋は、中身になる", [[sec("t1", 0, 0, { h: 312 }), { op: "add", el: { id: "l", type: "stroke", points: [[0, 0], [10, 10]] } }, shape("a1", 24, 52)]], { a1: { x: 24, y: 52 }, t1: { h: 186 } }],
    ["3 列で、中身、セクションの順に全部を動かしても、並びは変わらない", [[sec("t1", 0, 0, { cols: 3 }), ...["a1", "a2", "a3"].map((id) => into("t1", { id }))], [set("a1", { x: 224 }), set("a2", { x: 381 }), set("a3", { x: 538 }), set("t1", { x: 200 })]], { a1: { x: 224 }, a2: { x: 381 }, a3: { x: 538 } }],
    ["cols と h を同じ set で書いても、下にあった外の要素は中身にならない", [[cont("s", 0, 0, 504, 160), shape("in1", 24, 52, { h: 40 }), shape("out", 24, 400)], [set("s", { cols: 2, h: 600 })]], { s: { h: 116 }, out: { x: 24, y: 400 } }],
    ["cols のセクションを囲むセクションは、中の cols のセクションが伸びても動かない", [[cont("O", 0, 0, 800, 500), sec("t1", 24, 60), into("t1", { id: "a1" }), into("t1", { id: "a2" }), shape("sib", 560, 60)], [into("t1", { id: "a3" })]], { O: { y: 0 }, sib: { y: 60 }, t1: { y: 60, h: 312 } }],
    ["中にセクションがあっても、枠の中の付箋は全部並べる", [[...base4.slice(0, 4)], [cont("inner", 260, 178, 220, 200)], [into("t1", { id: "a4" })], [into("t1", { id: "a5" })]], { a4: { x: 260, y: 178 }, a5: { x: 24, y: 304 }, t1: { h: 438 }, inner: { y: 178 } }],
    [
      "範囲のコメントを先に書けば、同じまとまりで座標で置いた線とセクションも、枠の外へ押し出されない",
      [[...base4, { op: "add", el: { id: "rc", type: "comment", x: 30, y: 200, w: 60, h: 60 } }, { op: "add", el: { id: "st", type: "stroke", points: [[30, 200], [60, 230]] } }, cont("inner", 300, 200, 150, 90)]],
      { rc: { y: 200 }, st: { points: [[30, 200], [60, 230]] }, inner: { y: 200 } },
    ],
    [
      "畳まれた cols のセクションに in で足した要素は、仮の場所が下のセクションに入っても、そのセクションを伸ばさない",
      [[sec("t1", 0, 0), cont("low", 0, 112, 504, 300), shape("m1", 24, 320)], [into("t1", { id: "tb", type: "table", rows: tb(6) }), set("tb", { rows: tb(9) })]],
      { low: { h: 300 } },
    ],
    ["in で足して仮の場所にある要素は、下のセクションの中身が伸びても、そのセクションの高さに数えない", [[sec("t1", 0, 0), cont("low", 0, 112, 504, 300), shape("m1", 24, 164)], [into("t1", { id: "tall", h: 400 }), set("m1", { h: 150 })]], { low: { h: 300 } }],
    ["セクションごと動かした中身は、動かした先に、まだ縮んでいない別のセクションの枠があっても、元のセクションの中身のまま", [[sec("s", 0, 0), into("s", { id: "a" }), sec("t", 0, 246), into("t", { id: "t1" }), into("t", { id: "t2" })], [set("a", { h: 400 })], [set("a", { h: 110 }), set("t", { y: 246 })]], { s: { h: 186 }, t: { y: 246, h: 186 }, t1: { x: 24, y: 298 }, t2: { x: 260, y: 298 } }],
    ["セクションを動かした後に、同じまとまりで消すと、連れていった中身は、位置で中身かどうかを読む", [[sec("A", 0, 0), into("A", { id: "a1" }), sec("B", 600, 0), into("B", { id: "b1" })], [set("A", { x: 600 }), rm("A")]], { a1: { x: 624, y: 52 }, b1: { x: 860, y: 52 } }],
    ["in で足した後の above は、並べ終わった位置を見る", [[sec("t1", 0, 0)], [into("t1", { id: "a1" }), { op: "add", above: "a1", el: { id: "v", type: "shape" } }]], { v: { x: 0, y: 0 }, t1: { y: 170 }, a1: { x: 24, y: 222 } }],
    ["in で足した後の、場所を書かない add は、並べ終わった全体の右に置く", [[sec("t1", 0, 0), into("t1", { id: "i", type: "image", src: "x.png", w: 1000, h: 200 }), { op: "add", el: { id: "v", type: "shape" } }]], { i: { w: 220, h: 44 }, v: { x: 564, y: 0 } }],
    [
      "in で足した後の、cols の無いセクションへの in は、並べ終わった位置を見る",
      [[sec("t1", 0, 0), cont("low", 0, 112, 504, 300)], [into("t1", { id: "tall", h: 200 }), into("low", { id: "x" })]],
      { low: { y: 336 }, x: { x: 24, y: 388 } },
    ],
  ];
  test.each(fresh)("%s", (_name, batches, want) => expectBoard(run(batches), want));

  test("in で足した後の、場所を書かない型は、並べ終わった全体の右に置く", () => {
    const doc = build([sec("t1", 0, 0), into("t1", { id: "i", type: "image", src: "x.png", w: 1000, h: 200 }), { op: "template", kind: "tree", id: "tr", root: "根" }]);
    expect(Math.min(...doc.elements.filter((e) => e.id.startsWith("tr")).map((e) => e.x ?? 0))).toBe(564);
  });

  test("このまとまりで足した要素は added にだけ入り、並べ直しと押し下げで動いても updated に入らない", () => {
    const r = applyOps(base, [shape("u", 0, 372), into("t1", { id: "a5" })]);
    expect(r.ok && r.value.added.map((e) => e.id).sort()).toEqual(["a5", "u"]);
    expect(r.ok && r.value.updated.map((e) => e.id)).toEqual(["t1"]);
    expect(r.ok && find(r.value.doc, "u")).toMatchObject({ y: 498 });
  });

  test("列の幅は、40 より狭くならない", () => {
    expect(colWidth({ x: 0, y: 0, w: 200, h: 0 }, 8)).toBe(40);
  });
});

describe("付箋の欄（title・who・status・carriedFrom）", () => {
  const note = (extra: Record<string, unknown>) => ({ id: "a", type: "shape", x: 0, y: 0, w: 220, h: 110, ...extra });
  test.each([
    ["知らない状態", note({ status: "done" }), "status は"],
    ["日付でない carriedFrom", note({ carriedFrom: "11/11" }), "carriedFrom は"],
    ["持ち越しでない状態に carriedFrom", note({ status: "decided", carriedFrom: "2026-11-11" }), "carriedFrom を書くなら"],
    ["文字（text）には書けない", { id: "a", type: "text", x: 0, y: 0, text: "x", status: "open" }, "text に status は無い"],
  ])("%s は断る", (_name, raw, message) => {
    const r = parseEl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  test.each([
    ["状態だけ", note({ status: "decided" }), { status: "decided", label: "決定" }],
    ["持ち越しと日付", note({ status: "carried", carriedFrom: "2026-11-11" }), { status: "carried", label: "持ち越し 11/11" }],
    ["日付だけを書くと、持ち越し", note({ carriedFrom: "2026-11-04" }), { status: "carried", label: "持ち越し 11/4" }],
    ["月までの日付", note({ carriedFrom: "2026-10" }), { status: "carried", label: "持ち越し 10月" }],
    ["どちらも無ければ、札は無い", note({ who: "竹内" }), null],
  ])("札の文字: %s", (_name, raw, expected) => {
    const r = parseEl(raw);
    expect<unknown>(r.ok && statusBadge(r.value)).toEqual(expected);
  });
});

describe("セクションの中身を置き始める高さ", () => {
  test.each([
    ["題名だけ", {}, 52],
    ["論点 1 行", { question: "来期の採用は何人か" }, 86],
    ["論点と結論", { question: "来期の採用は何人か", answer: "2 人" }, 129],
    ["論点が折り返す", { w: 200, question: "来期の採用は何人にするか" }, 111],
    ["結論だけ", { answer: "2 人" }, 95],
    ["結論が全角 27 文字なら 1 行", { answer: "あ".repeat(27) }, 95],
    ["結論が全角 28 文字なら 2 行", { answer: "あ".repeat(28) }, 117],
    ["結論の改行は、行に数える", { answer: "2 人\n4 月入社" }, 117],
    ["論点が全角 25 文字なら 1 行", { question: "あ".repeat(25) }, 86],
    ["論点が全角 26 文字なら 2 行", { question: "あ".repeat(26) }, 111],
    ["論点の改行は、行に数える", { question: "何人か\nいつか" }, 111],
  ])("%s", (_name, extra, expected) => {
    expect(sectionTop({ id: "s", type: "container", x: 0, y: 0, w: 504, h: 100, ...extra })).toBe(expected);
  });

  test("in で足した付箋は、論点と結論の下に入る", () => {
    const doc = build([
      { op: "add", el: { id: "s", type: "container", x: 0, y: 0, w: 504, h: 300, question: "来期の採用は何人か" } },
      { op: "add", in: "s", el: { id: "a", type: "shape" } },
    ]);
    expect(find(doc, "a")).toMatchObject({ x: 24, y: 86 });
  });
});
