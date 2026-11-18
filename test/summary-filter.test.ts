// まとめの帯の条件（show に、状態・発言者・tag の組を書く）
import { describe, expect, test } from "bun:test";
import { checkBoard } from "./check-style.ts";
import { applyOps, emptyDoc, parseEl, parseShow, summaryHeight, type Doc, type El } from "../src/shared/model.ts";
import { bandsOf, collect, filterKey, filterTitle, itemsOf } from "../src/shared/summary.ts";

const add = (el: Record<string, unknown>) => ({ op: "add", el });
const band = (show: unknown, extra: Record<string, unknown> = {}) => ({ id: "sum", type: "summary", show, x: 0, y: 0, ...extra });
const note = (id: string, i: number, extra: Record<string, unknown> = {}) => ({ id, type: "shape", x: 3000 + i * 240, y: -600, w: 220, h: 110, text: id, ...extra });

function build(ops: unknown[]): Doc {
  const r = applyOps(emptyDoc("t"), ops);
  if (!r.ok) throw new Error(r.error);
  return r.value.doc;
}
const get = (doc: Doc, id: string): El | undefined => doc.elements.find((e) => e.id === id);

// 付箋の並び。a: 宿題・設楽・リスク、b: 宿題・設楽、c: 宿題・高坂・リスク、d: 決定・設楽・リスク、e: 状態なし・設楽・リスク、f: 持ち越しの宿題・設楽（前後に空白）
const notes = [
  add(note("a", 0, { status: "todo", who: "設楽", tag: "リスク" })),
  add(note("b", 1, { status: "todo", who: "設楽" })),
  add(note("c", 2, { status: "todo", who: "高坂", tag: "リスク" })),
  add(note("d", 3, { status: "decided", who: "設楽", tag: "リスク" })),
  add(note("e", 4, { who: "設楽", tag: "リスク" })),
  add(note("f", 5, { status: "todo", carriedFrom: "2026-11-11", who: " 設楽 " })),
];
const rowsOf = (show: unknown): string[] => {
  const doc = build([...notes, add(band(show))]);
  const sum = get(doc, "sum");
  return sum ? itemsOf(collect(doc.elements), sum).map((r) => r.item.id) : [];
};

describe("帯の条件で集める付箋", () => {
  test.each<[string, unknown, string[]]>([
    ["status だけ", { status: "todo" }, ["a", "b", "c", "f"]],
    ["who だけ（状態の無い付箋 e も集める）", { who: "設楽" }, ["a", "b", "d", "e", "f"]],
    ["tag だけ（状態の無い付箋 e も集める）", { tag: "リスク" }, ["a", "c", "d", "e"]],
    ["status と who（かつ）", { status: "todo", who: "設楽" }, ["a", "b", "f"]],
    ["status と tag", { status: "todo", tag: "リスク" }, ["a", "c"]],
    ["who と tag", { who: "設楽", tag: "リスク" }, ["a", "d", "e"]],
    ["status を書くと、状態の無い付箋は集めない", { status: "decided", tag: "リスク" }, ["d"]],
    ["3 つとも", { status: "todo", who: "設楽", tag: "リスク" }, ["a"]],
    ["who は前後の空白を除いて比べる（条件の側）", { who: "  設楽 " }, ["a", "b", "d", "e", "f"]],
    ["持ち越しの宿題は、status: todo に入る（carried には入らない）", { status: "carried" }, []],
    ["大文字と小文字は区別する", { tag: "risk" }, []],
    ["当たる付箋が無い", { who: "長谷川" }, []],
  ])("%s", (_name, show, expected) => {
    expect(rowsOf(show)).toEqual(expected);
  });

  test.each(["decided", "open", "todo", "carried", "priority"])("状態の名前で書いた show（%s）は、{ status } と同じ付箋を集める", (status) => {
    expect(rowsOf(status)).toEqual(rowsOf({ status }));
  });

  test("ファイルに書いた形は、書いたまま（状態の名前は名前のまま、組は組のまま）", () => {
    const doc = build([...notes, add(band("todo")), add(band({ who: "設楽" }, { id: "sum2", x: 600 }))]);
    expect([get(doc, "sum")?.show, get(doc, "sum2")?.show]).toEqual(["todo", { who: "設楽" }]);
  });
});

describe("帯の条件の書き間違いは、理由を付けて断る", () => {
  test.each<[string, unknown, string]>([
    ["項目が 1 つも無い", {}, "show の組に、status・who・tag のどれも書いていない"],
    ["知らない項目", { status: "todo", color: "blue" }, "show に color は書けない。書けるのは status・who・tag"],
    ["知らない状態", { status: "done" }, "show の status は decided | open | todo | carried | priority のどれか"],
    ["空の who", { who: "" }, "show の who は、空でない文字列"],
    ["空白だけの tag", { tag: "  " }, "show の tag は、空でない文字列"],
    ["文字列でない who", { who: 1 }, "show の who は、空でない文字列"],
    ["配列", ["todo"], "show は、状態の名前"],
    ["知らない状態の名前", "done", "show は、状態の名前"],
  ])("%s", (_name, show, message) => {
    const r = parseEl(band(show));
    expect(r.ok ? "" : r.error).toContain(message);
  });

  test("parseShow は、状態の名前を { status } として読む", () => {
    expect(parseShow("todo")).toEqual({ ok: true, value: { status: "todo" } });
  });
});

describe("帯の題名", () => {
  test.each<[string, unknown, string]>([
    ["状態だけ", { status: "todo" }, "宿題"],
    ["状態と発言者", { status: "todo", who: "設楽" }, "宿題・設楽"],
    ["tag だけ", { tag: "リスク" }, "リスク"],
    ["3 つとも（状態、発言者、tag の順）", { tag: "リスク", who: "設楽", status: "open" }, "未決・設楽・リスク"],
    ["前後の空白は除く", { who: " 設楽 " }, "設楽"],
  ])("書かなかったときの既定: %s", (_name, show, expected) => {
    const r = parseShow(show);
    expect(r.ok ? filterTitle(r.value) : r.error).toBe(expected);
  });

  test("状態の名前の show と、{ status } だけの組は、同じ条件として比べる", () => {
    const [a, b] = [parseShow("todo"), parseShow({ status: "todo" })];
    expect(a.ok && b.ok && filterKey(a.value) === filterKey(b.value)).toBe(true);
  });
});

describe("xwb summary の帯ごとの一覧", () => {
  test("ボードにある帯ごとに、id、条件、題名、行（状態つき）を返す", () => {
    const doc = build([...notes, add(band({ who: "設楽", tag: "リスク" }, { id: "risk" })), add(band("decided", { id: "dec", x: 600, title: "決定事項" }))]);
    expect(bandsOf(doc.elements).map((b) => ({ id: b.id, show: b.show, title: b.title, items: b.items.map((i) => `${i.id}:${i.status ?? "状態なし"}`) }))).toEqual([
      { id: "risk", show: { who: "設楽", tag: "リスク" }, title: "設楽・リスク", items: ["a:todo", "d:decided", "e:状態なし"] },
      { id: "dec", show: { status: "decided" }, title: "決定事項", items: ["d:decided"] },
    ]);
  });

  test("帯が無ければ、空", () => {
    expect(bandsOf(build(notes).elements)).toEqual([]);
  });
});

describe("条件の帯の検査", () => {
  const kinds = (ops: unknown[]): string[] =>
    checkBoard(build(ops))
      .filter((i) => i.kind.includes("summary"))
      .map((i) => `${i.kind}:${i.ids.join(",")}`);
  test.each<[string, unknown[], string[]]>([
    ["当たる付箋がある", [...notes, add(band({ tag: "リスク" }))], []],
    ["tag で集めて 0 件", [...notes, add(band({ tag: "懸念" }))], ["empty-summary:sum"]],
    ["who で集めて 0 件", [...notes, add(band({ who: "長谷川" }))], ["empty-summary:sum"]],
    ["状態と who で集めて 0 件", [...notes, add(band({ status: "priority", who: "設楽" }))], ["empty-summary:sum"]],
    ["状態だけで集めて 0 件は、知らせない（会議の始めは 0 件が普通）", [...notes, add(band({ status: "priority" }))], []],
    ["状態の名前の show で 0 件も、知らせない", [...notes, add(band("priority"))], []],
    ["同じ条件の帯が 2 つ（組どうし。並べる順が違っても同じ）", [...notes, add(band({ who: "設楽", tag: "リスク" })), add(band({ tag: "リスク", who: "設楽" }, { id: "sum2", x: 600 }))], ["duplicate-summary:sum,sum2"]],
    ["状態の名前の show と { status } の組は、同じ条件", [...notes, add(band("todo")), add(band({ status: "todo" }, { id: "sum2", x: 600 }))], ["duplicate-summary:sum,sum2"]],
    ["前後の空白だけが違う条件も、同じ条件", [...notes, add(band({ who: "設楽" })), add(band({ who: " 設楽" }, { id: "sum2", x: 600 }))], ["duplicate-summary:sum,sum2"]],
    ["条件が違う帯", [...notes, add(band({ who: "設楽" })), add(band({ who: "設楽", status: "todo" }, { id: "sum2", x: 600 }))], []],
  ])("%s", (_name, ops, expected) => {
    expect(kinds(ops)).toEqual(expected);
  });

  // 似た値の見分け: 大文字と小文字、全角と半角、空白だけが違う値。前後の空白だけが違う値は、同じ値なので集まり、似た値には入れない
  const tagged = (tags: string[]) => tags.map((tag, i) => add(note(`t${i}`, i, { status: "todo", tag })));
  const hint = (tags: string[], want: string): string => checkBoard(build([...tagged(tags), add(band({ tag: want }))])).find((i) => i.kind === "empty-summary")?.message ?? "（知らせなし）";
  test.each<[string, string[], string, string]>([
    ["大文字と小文字", ["Risk"], "risk", "似た tag: 「Risk」"],
    ["全角と半角（英字）", ["ＲＩＳＫ"], "RISK", "似た tag: 「ＲＩＳＫ」"],
    ["全角と半角（カナ）", ["ﾘｽｸ"], "リスク", "似た tag: 「ﾘｽｸ」"],
    ["中の空白", ["リ スク"], "リスク", "似た tag: 「リ スク」"],
    ["2 つ以上の似た値", ["Risk", "RISK"], "risk", "似た tag: 「Risk」・「RISK」"],
  ])("似た値を案内に入れる: %s", (_name, tags, want, expected) => {
    expect(hint(tags, want)).toContain(expected);
  });

  test.each<[string, string[], string]>([
    ["別の語（含むだけ）", ["リスク管理"], "リスク"],
    ["ひらがなとカタカナ", ["りすく"], "リスク"],
    ["似た値が無い", ["懸念"], "リスク"],
  ])("似た値に入れない: %s", (_name, tags, want) => {
    const message = hint(tags, want);
    expect([message.includes("付箋の who か tag を、条件と同じ文字で書く"), message.includes("似た")]).toEqual([true, false]);
  });

  test("前後の空白だけが違う tag は、同じ値なので集まり、知らせない", () => {
    expect(hint([" リスク "], "リスク")).toBe("（知らせなし）");
  });

  test("似た who も案内に入れる", () => {
    const message = checkBoard(build([add(note("a", 0, { status: "todo", who: "ｼﾀﾗ" })), add(band({ who: "シタラ" }))])).find((i) => i.kind === "empty-summary")?.message;
    expect(message).toContain("似た who: 「ｼﾀﾗ」");
  });

  // 知らせの直し方（付箋の値を条件にそろえる、帯の条件を直す）を当てた後に、もう一度検査をかける。どの種類の知らせも残らない
  test.each<[string, unknown[]]>([
    ["付箋の tag を条件にそろえる", [{ op: "set", id: "t0", patch: { tag: "リスク" } }]],
    ["帯の条件を付箋の値に直す", [{ op: "set", id: "sum", patch: { show: { tag: "ﾘｽｸ" } } }]],
  ])("知らせどおりに直すと、知らせが残らない: %s", (_name, fix) => {
    const ops = [...tagged(["ﾘｽｸ"]), add(band({ tag: "リスク" }, { y: -400 }))];
    expect(checkBoard(build(ops)).map((i) => i.kind)).toEqual(["empty-summary"]);
    expect(checkBoard(build([...ops, ...fix]))).toEqual([]);
  });
});

describe("条件の帯の高さと、下の動き", () => {
  // 帯（1 行）の下 60 にセクション。数字は帯の高さの式から求める
  const h = summaryHeight;
  const sec = { op: "add", el: { id: "s", type: "container", x: 0, y: h(1) + 60, w: 740, h: 300 } };
  test("行が増えると伸びて下が下がり、減ると縮んで上がる（状態の帯と同じ決まり）", () => {
    let doc = build([add(band({ who: "設楽" })), sec]);
    expect([get(doc, "sum")?.h, get(doc, "s")?.y]).toEqual([h(1), h(1) + 60]);
    const step = (ops: unknown[]): Doc => {
      const r = applyOps(doc, ops);
      if (!r.ok) throw new Error(r.error);
      return r.value.doc;
    };
    doc = step([add(note("x1", 0, { status: "todo", who: "設楽" })), add(note("x2", 1, { status: "decided", who: "設楽" })), add(note("x3", 2, { status: "open", who: "設楽" }))]);
    expect([get(doc, "sum")?.h, get(doc, "s")?.y]).toEqual([h(3), h(3) + 60]);
    // 発言者を変えると、帯から外れる
    doc = step([{ op: "set", id: "x1", patch: { who: "高坂" } }, { op: "set", id: "x2", patch: { tag: "別" } }]);
    expect([get(doc, "sum")?.h, get(doc, "s")?.y]).toEqual([h(2), h(2) + 60]);
    doc = step([{ op: "rm", id: "x2" }, { op: "rm", id: "x3" }]);
    expect([get(doc, "sum")?.h, get(doc, "s")?.y]).toEqual([h(1), h(1) + 60]);
  });

  test("足す時点で、条件に当たる行の数の高さにする", () => {
    const doc = build([...notes, add(band({ who: "設楽" }))]);
    expect(get(doc, "sum")?.h).toBe(summaryHeight(5));
  });

  test("状態の無い付箋に tag を付けると、tag の帯が伸び、状態の帯は変わらない", () => {
    let doc = build([add(band({ tag: "リスク" })), add(band("open", { id: "op", x: 600 })), sec]);
    const r = applyOps(doc, [add(note("n", 0, { tag: "リスク" }))]);
    if (!r.ok) throw new Error(r.error);
    doc = r.value.doc;
    expect([get(doc, "sum")?.h, get(doc, "op")?.h, get(doc, "s")?.y]).toEqual([h(1), h(1), h(1) + 60]);
    const r2 = applyOps(doc, [add(note("n2", 1, { tag: "リスク" }))]);
    if (!r2.ok) throw new Error(r2.error);
    expect([get(r2.value.doc, "sum")?.h, get(r2.value.doc, "op")?.h, get(r2.value.doc, "s")?.y]).toEqual([h(2), h(1), h(2) + 60]);
  });

  test("set で条件を変えると、行の数に合わせて伸び、下が下がる", () => {
    const doc = build([...notes, add(band({ tag: "懸念" })), sec, { op: "set", id: "sum", patch: { show: { status: "todo" } } }]);
    expect([get(doc, "sum")?.h, get(doc, "s")?.y]).toEqual([h(4), h(4) + 60]);
  });
});
