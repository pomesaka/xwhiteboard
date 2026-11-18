import { describe, expect, test } from "bun:test";
import { focusLabel, keptOnFocus } from "../src/shared/focus.ts";
import type { El } from "../src/shared/model.ts";

const box = (id: string, type: El["type"], x: number, y: number, w: number, h: number, more: Partial<El> = {}): El => ({ id, type, x, y, w, h, ...more });

// 注目するセクション s と中身 a、どこにも入らない o、固定したセクション L と中身 m、固定していないセクション U と中身 u
const s = box("s", "container", 0, 0, 500, 300);
const a = box("a", "shape", 20, 60, 220, 110);
const o = box("o", "shape", 800, 0, 220, 110);
const L = box("L", "container", 0, 400, 500, 300, { locked: true });
const m = box("m", "shape", 20, 460, 220, 110);
const U = box("U", "container", 0, 800, 500, 300);
const u = box("u", "shape", 20, 860, 220, 110);
const base = [s, a, o, L, m, U, u];

describe("注目していなければ、薄くしない要素を決めない（null）", () => {
  test.each<[string, El[], string | null]>([
    ["注目が無い", base, null],
    ["注目の id の要素が無い", base, "nope"],
    ["注目の id が、セクションでない要素", base, "a"],
    ["注目の id が、固定した付箋", [s, { ...o, locked: true }], "o"],
    ["要素が 1 つも無い", [], "s"],
    ["注目の id が空の文字列", base, ""],
  ])("%s", (_name, els, focusId) => {
    expect(keptOnFocus(els, focusId)).toBeNull();
  });
});

describe("注目している間、薄くしない要素", () => {
  const arrowIn = (id: string, y: number, more: Partial<El> = {}): El => ({ id, type: "arrow", from: [50, y], to: [150, y + 50], ...more });
  /** どのセクションの枠にも入らない場所に置いた、要素 on を指すコメント */
  const pin = (id: string, on: string): El => box(id, "comment", 600, 1200, 28, 28, { on });
  test.each<[string, El[], string[]]>([
    ["注目したセクションと、その中身。外の要素は入らない", [s, a, o, U, u], ["a", "s"]],
    ["中身の無いセクションは、自身だけ", [s], ["s"]],
    ["場所の無いセクションは、自身だけ", [{ id: "s", type: "container" }, a], ["s"]],
    ["注目したセクションの中の矢印と、中のセクションは入らない", [s, a, arrowIn("r", 200), box("inner", "container", 100, 150, 200, 100)], ["a", "s"]],
    [
      "中のセクションの中身は、中心が注目したセクションの枠の中にあるものだけ入る",
      [s, box("J", "container", 300, 50, 300, 200), box("j1", "shape", 320, 100, 60, 60), box("j2", "shape", 520, 100, 60, 60)],
      ["j1", "s"],
    ],
    ["固定したセクションと、その中身（中身は固定していなくてよい）。固定していないセクションと中身は入らない", base, ["L", "a", "m", "s"]],
    ["セクションに入っていない、固定した付箋", [s, { ...o, locked: true }], ["o", "s"]],
    ["固定した矢印（両端を要素に付けた、場所を持たない矢印）", [s, a, o, { id: "r", type: "arrow", from: "a", to: "o", locked: true }], ["a", "r", "s"]],
    ["locked が false の要素は入らない", [s, { ...o, locked: false }], ["s"]],
    ["固定していないセクションの中の、固定した付箋。セクションは入らない", [s, U, { ...u, locked: true }], ["s", "u"]],
    [
      "固定したセクションの中の、固定していないセクションは入らない。その中身は、中心が固定したセクションの中なら入る",
      [s, L, box("I", "container", 250, 420, 200, 200), box("i", "shape", 260, 480, 100, 60)],
      ["L", "i", "s"],
    ],
    ["固定したセクションの中の、固定したセクションは入る", [s, L, box("I", "container", 250, 420, 200, 200, { locked: true })], ["I", "L", "s"]],
    ["固定したセクションの中の、固定していない矢印は入らない", [s, L, arrowIn("r", 500)], ["L", "s"]],
    ["注目したセクションが固定されていても同じ", [{ ...s, locked: true }, a, o], ["a", "s"]],
    ["固定したセクションと固定していないセクションが重なる所の要素は入る", [s, L, m, { ...U, y: 400 }], ["L", "m", "s"]],
    ["枠の外にあって、注目したセクションの中身を指すコメントは入る", [s, a, pin("k", "a")], ["a", "k", "s"]],
    ["枠の外にあって、注目したセクションそのものを指すコメントは入る", [s, pin("k", "s")], ["k", "s"]],
    ["固定した付箋を指すコメントは入る", [s, { ...o, locked: true }, pin("k", "o")], ["k", "o", "s"]],
    ["固定したセクションの中身を指すコメントは入る", [s, L, m, pin("k", "m")], ["L", "k", "m", "s"]],
    ["薄くなる要素を指すコメントは入らない", [s, U, u, pin("k", "u")], ["s"]],
    ["無い要素を指すコメントは入らない", [s, pin("k", "nope")], ["s"]],
    ["指す先（on）の無い、枠の外のコメントは入らない", [s, a, box("k", "comment", 600, 60, 28, 28)], ["a", "s"]],
    ["指す先の無いコメントも、枠の中にあれば中身として入る", [s, box("k", "comment", 300, 100, 28, 28)], ["k", "s"]],
    ["コメントが、指す要素より前に並んでいても入る", [pin("k", "a"), a, s], ["a", "k", "s"]],
    ["要素の並ぶ順によらない", base.toReversed(), ["L", "a", "m", "s"]],
  ])("%s", (_name, els, expected) => {
    expect([...(keptOnFocus(els, "s") ?? [])].sort()).toEqual(expected);
  });
});

describe("注目の札に出す名前", () => {
  test.each<[string, Partial<El>, string]>([
    ["題名があれば題名（論点より先）", { title: "議題 1 採用", question: "何人か" }, "議題 1 採用"],
    ["題名が無ければ論点", { question: "何人か" }, "何人か"],
    ["題名が空なら論点", { title: "", question: "何人か" }, "何人か"],
    ["題名が空白だけなら論点（全角の空白も）", { title: " 　 ", question: "何人か" }, "何人か"],
    ["題名も論点も無ければ id", {}, "s"],
    ["題名も論点も空白だけなら id", { title: "", question: "  " }, "s"],
    ["前後の空白は除き、間の空白は残す", { title: "  議題 1 採用 " }, "議題 1 採用"],
    ["結論は名前に使わない", { answer: "2 人" }, "s"],
  ])("%s", (_name, fields, expected) => {
    expect(focusLabel({ id: "s", type: "container", ...fields })).toBe(expected);
  });
});
