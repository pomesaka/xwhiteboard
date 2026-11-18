import { describe, expect, test } from "bun:test";
import { isBoardRef, parseInline, resolveBoardRef, parseRich, plainText, toggleMarkup, type MarkupKind } from "../src/shared/rich.ts";

describe("行の中の装飾を読む", () => {
  test.each([
    ["太字", "これは**大事**です", [{ kind: "text", text: "これは" }, { kind: "bold", text: "大事" }, { kind: "text", text: "です" }]],
    ["斜体", "*仮*の案", [{ kind: "italic", text: "仮" }, { kind: "text", text: "の案" }]],
    ["取り消し線", "~~11/15 に出す~~ 11/22 に出す", [{ kind: "strike", text: "11/15 に出す" }, { kind: "text", text: " 11/22 に出す" }]],
    ["波線 1 つは、取り消し線にしない（範囲を表す 〜 の代わりに使われる）", "12~1 月と 3~4 月", [{ kind: "text", text: "12~1 月と 3~4 月" }]],
    ["コード", "`xwb shot` で撮る", [{ kind: "code", text: "xwb shot" }, { kind: "text", text: " で撮る" }]],
    ["リンク", "[仕様](https://example.com/a?b=1)", [{ kind: "link", text: "仕様", href: "https://example.com/a?b=1" }]],
    ["コードの中の記号は装飾にしない", "`a*b*c`", [{ kind: "code", text: "a*b*c" }]],
    ["閉じていない記号は、文字のまま", "5 * 3 と **太字", [{ kind: "text", text: "5 * 3 と **太字" }]],
    ["空白にはさまれた * は掛け算の記号。斜体にしない", "5 * 3 と 2 * 4", [{ kind: "text", text: "5 * 3 と 2 * 4" }]],
    ["http と https でないリンクは、文字のまま", "[x](javascript:alert(1))", [{ kind: "text", text: "[x](javascript:alert(1))" }]],
    ["HTML は、文字のまま", "<b>太字</b>", [{ kind: "text", text: "<b>太字</b>" }]],
    ["ほかのボードへのリンク", "詳細は[案件](anken.board.json)", [{ kind: "text", text: "詳細は" }, { kind: "link", text: "案件", href: "anken.board.json" }]],
    ["上のフォルダのボードへのリンク", "[経営](../keiei/keiei.board.json)", [{ kind: "link", text: "経営", href: "../keiei/keiei.board.json" }]],
    ["ボードでないファイルへの相対パスは、文字のまま", "[メモ](memo.md)", [{ kind: "text", text: "[メモ](memo.md)" }]],
    ["絶対パスのボードは、文字のまま", "[x](/tmp/a.board.json)", [{ kind: "text", text: "[x](/tmp/a.board.json)" }]],
  ])("%s", (_name, line, expected) => {
    expect<unknown>(parseInline(line)).toEqual(expected);
  });
});

describe("リンクの行き先が、ほかのボードか", () => {
  test.each([
    ["同じフォルダ", "anken.board.json", true],
    ["下のフォルダ", "sub/a.board.json", true],
    ["上のフォルダ", "../b.board.json", true],
    ["./ で始まる", "./anken.board.json", true],
    ["ルートより上を指す", "../../../c.board.json", true],
    ["絶対パスは断る", "/m/a.board.json", false],
    ["URL は断る", "https://example.com/a.board.json", false],
    ["ボードでないファイルは断る", "a.json", false],
    ["空白を含むパスは断る", "a b.board.json", false],
    [") を含むパスは断る", "a).board.json", false],
  ])("%s", (_name, ref, expected) => {
    expect(isBoardRef(ref)).toBe(expected);
  });
});

describe("ボードへのリンクの行き先を、絶対パスにする", () => {
  test.each([
    ["同じフォルダ", "anken.board.json", "/m/keiei/anken.board.json"],
    ["下のフォルダ", "sub/a.board.json", "/m/keiei/sub/a.board.json"],
    ["上のフォルダ", "../b.board.json", "/m/b.board.json"],
    ["./ で始まる", "./anken.board.json", "/m/keiei/anken.board.json"],
    ["ルートより上へは出ない", "../../../c.board.json", "/c.board.json"],
  ])("%s", (_name, ref, expected) => {
    expect(resolveBoardRef("/m/keiei/keiei.board.json", ref)).toBe(expected);
  });
});

describe("蛍光ペン", () => {
  test.each([
    ["色を書かなければ黄色", "ここが==大事な所==です", [{ kind: "text", text: "ここが" }, { kind: "mark", text: "大事な所", color: "yellow" }, { kind: "text", text: "です" }]],
    ["色を選ぶ", "=={pink}期限は 11/20==", [{ kind: "mark", text: "期限は 11/20", color: "pink" }]],
    ["知らない色は、蛍光ペンにしない", "=={red}赤==", [{ kind: "text", text: "=={red}赤==" }]],
    ["記号の直後が空白なら、蛍光ペンにしない", "a == b と c == d", [{ kind: "text", text: "a == b と c == d" }]],
    ["太字と並べて書ける（入れ子にはしない）", "**太字**と==帯==", [{ kind: "bold", text: "太字" }, { kind: "text", text: "と" }, { kind: "mark", text: "帯", color: "yellow" }]],
  ])("%s", (_name, line, expected) => {
    expect<unknown>(parseInline(line)).toEqual(expected);
  });
});

describe("編集中に、選んだ範囲へ装飾を付け外しする", () => {
  // 「|」で選んだ範囲の始まりと終わりを表す。結果も同じ書き方で比べる
  const run = (marked: string, kind: MarkupKind): string => {
    const start = marked.indexOf("|");
    const end = marked.lastIndexOf("|") - 1;
    const r = toggleMarkup(marked.replaceAll("|", ""), start, end, kind);
    return `${r.text.slice(0, r.start)}|${r.text.slice(r.start, r.end)}|${r.text.slice(r.end)}`;
  };

  test.each<[string, string, MarkupKind, string]>([
    ["太字を付ける", "これは|大事|です", "bold", "これは**|大事|**です"],
    ["もう一度押すと外れる（記号の内側を選んでいる）", "これは**|大事|**です", "bold", "これは|大事|です"],
    ["記号ごと選んでいても外れる", "これは|**大事**|です", "bold", "これは|大事|です"],
    ["斜体を付ける", "|仮|の案", "italic", "*|仮|*の案"],
    ["斜体を外す", "*|仮|*の案", "italic", "|仮|の案"],
    ["太字に斜体を押すと、太字を外して斜体にする（入れ子にしない）", "**|大事|**", "italic", "*|大事|*"],
    ["太字に蛍光ペンを押すと、太字を外して蛍光ペンにする", "これは**|大事|**です", "pink", "これは=={pink}|大事|==です"],
    ["蛍光ペンに太字を押すと、蛍光ペンを外して太字にする", "これは=={pink}|大事|==です", "bold", "これは**|大事|**です"],
    ["蛍光ペン（黄色）を付ける", "期限は|11/20|です", "yellow", "期限は==|11/20|==です"],
    ["蛍光ペン（色つき）を付ける", "期限は|11/20|です", "pink", "期限は=={pink}|11/20|==です"],
    ["同じ色をもう一度押すと外れる", "期限は=={pink}|11/20|==です", "pink", "期限は|11/20|です"],
    ["違う色を押すと、色が替わる", "期限は==|11/20|==です", "green", "期限は=={green}|11/20|==です"],
    ["色つきから黄色へ替える", "期限は=={green}|11/20|==です", "yellow", "期限は==|11/20|==です"],
    ["取り消し線を付ける", "|11/15| に出す", "strike", "~~|11/15|~~ に出す"],
    ["取り消し線を外す", "~~|11/15|~~ に出す", "strike", "|11/15| に出す"],
    ["取り消し線に太字を押すと、取り消し線を外して太字にする", "~~|11/15|~~", "bold", "**|11/15|**"],
    ["何も選ばずに押すと、記号の間にカーソルを置く", "文||字", "bold", "文**||**字"],
  ])("%s", (_name, before, kind, after) => {
    expect(run(before, kind)).toBe(after);
  });
});

describe("行頭の記号で、箇条書きにまとめる", () => {
  test.each([
    ["続いた「- 」は 1 つの箇条書き", "- a\n- b", ["bullets:2"]],
    ["続いた「1. 」は 1 つの番号付き", "1. a\n2. b\n10. c", ["numbers:3"]],
    ["ふつうの行と箇条書きは分かれる", "見出し\n- a\n- b\n結び", ["lines:1", "bullets:2", "lines:1"]],
    ["箇条書きと番号付きは分かれる", "- a\n1. b", ["bullets:1", "numbers:1"]],
    ["空白の無い「-」は箇条書きにしない", "-a\n1.b", ["lines:2"]],
    ["空の行は、ふつうの行として残る", "a\n\nb", ["lines:3"]],
  ])("%s", (_name, text, expected) => {
    expect(parseRich(text).map((b) => `${b.kind}:${b.lines.length}`)).toEqual(expected);
  });
});

describe("大きさの見積もりには、記号を除いた文字を使う", () => {
  test.each([
    ["装飾の記号を除く", "**太字**と`コード`と[リンク](https://example.com)", "太字とコードとリンク"],
    ["箇条書きは、印のぶんを残す", "- a\n- b", "・ a\n・ b"],
    ["何も無ければ、そのまま", "ふつうの文\n2 行め", "ふつうの文\n2 行め"],
  ])("%s", (_name, text, expected) => {
    expect(plainText(text)).toBe(expected);
  });
});
