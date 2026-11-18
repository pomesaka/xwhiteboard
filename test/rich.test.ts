import { describe, expect, test } from "bun:test";
import { bareUrls, isBoardRef, parseInline, resolveBoardRef, parseRich, plainText, toggleMarkup, type MarkupKind } from "../src/shared/rich.ts";

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

describe("リンクの形で書かれていない URL を見つける", () => {
  test.each<[string, string, string[]]>([
    // 拾う。http:// か https:// で始まる
    ["https の URL", "https://example.com/a/b?c=1#d", ["https://example.com/a/b?c=1#d"]],
    ["http の URL", "http://example.com", ["http://example.com"]],
    ["空白で区切った、日本語の文の中", "詳細は https://example.com/a を見る", ["https://example.com/a"]],
    ["空白なしの、日本語の文の中。全角の文字の前で切る", "詳細はhttps://example.com/aです", ["https://example.com/a"]],
    ["全角の句点の前で切る", "資料は https://example.com/a。次へ", ["https://example.com/a"]],
    ["全角の読点の前で切る", "https://example.com/a、https://example.com/b", ["https://example.com/a", "https://example.com/b"]],
    ["文の終わりのピリオドは含めない", "See https://example.com/a.", ["https://example.com/a"]],
    ["文の終わりのカンマは含めない", "https://example.com/a, and more", ["https://example.com/a"]],
    ["途中のピリオドとカンマは含める", "https://example.com/a.b,c/d.html", ["https://example.com/a.b,c/d.html"]],
    ["半角の括弧で囲んだ URL は、閉じ括弧を含めない", "(https://example.com/a)", ["https://example.com/a"]],
    ["閉じ括弧と句読点が続いても除く", "(https://example.com/a).", ["https://example.com/a"]],
    ["全角の括弧で囲んだ URL", "（https://example.com/a）", ["https://example.com/a"]],
    ["URL の中の、対になった括弧は含める", "https://example.com/wiki/Foo_(bar)", ["https://example.com/wiki/Foo_(bar)"]],
    ["% で書いた文字は含める", "https://example.com/%E8%B3%87%E6%96%99", ["https://example.com/%E8%B3%87%E6%96%99"]],
    ["日本語をそのまま書いた URL は、日本語の前で切れる", "https://example.com/資料/a", ["https://example.com/"]],
    ["ポートの付いた URL", "http://localhost:3000/a", ["http://localhost:3000/a"]],
    ["太字の中の URL", "**https://example.com/a**", ["https://example.com/a"]],
    ["蛍光ペンの中の URL", "==https://example.com/a==", ["https://example.com/a"]],
    ["箇条書きの行の URL", "- https://example.com/a\n- 次", ["https://example.com/a"]],
    ["2 行に 1 つずつ", "https://example.com/a\nhttps://example.org/b", ["https://example.com/a", "https://example.org/b"]],
    ["リンクの形が崩れている（行き先に空白がある）", "[表示](https://example.com/a b)", ["https://example.com/a"]],
    ["リンクの形の外にも URL がある", "[表示](https://example.com/a) と https://example.com/b", ["https://example.com/b"]],
    // 拾う。スキームの無いドメイン
    ["ドメインとパス", "example.com/docs", ["example.com/docs"]],
    ["ドメインだけ", "example.com を見る", ["example.com"]],
    ["サブドメイン", "docs.example.com/a?b=1", ["docs.example.com/a?b=1"]],
    ["www で始まる", "www.example.com", ["www.example.com"]],
    ["co.jp", "example.co.jp/a", ["example.co.jp/a"]],
    ["日本語の文の中に、空白なしで書いた", "詳細はexample.com/docsです", ["example.com/docs"]],
    ["文の終わりのピリオドは含めない", "See example.com/docs.", ["example.com/docs"]],
    ["ドメインの直後のピリオド", "See example.com.", ["example.com"]],
    ["ホスト名に大文字のまじったドメイン", "GitHub.com/a", ["GitHub.com/a"]],
    ["スキームの無い行き先を書いた、リンクにならない形", "[表示](example.com/docs)", ["example.com/docs"]],
    ["拾う TLD の全部","a.com b.net c.org d.io e.dev f.ai g.jp", ["a.com", "b.net", "c.org", "d.io", "e.dev", "f.ai", "g.jp"]],
    // 拾わない
    ["リンクの形の中の URL", "[表示](https://example.com/a)", []],
    ["リンクの文字に書いたドメイン", "[example.com](https://example.com)", []],
    ["コードの中の URL", "`https://example.com/a`", []],
    ["コードの中のドメイン", "`example.com/docs`", []],
    ["ほかのボードへのリンク", "[x](anken.board.json)", []],
    ["ボードのファイル名", "a.board.json を開く", []],
    ["ファイル名", "README.md と main.ts と index.html と data.json", []],
    ["版の番号", "v1.2.3 と 1.2", []],
    ["メールアドレス", "taro@example.com へ送る", []],
    ["サブドメインのあるメールアドレス", "taro@mail.example.co.jp", []],
    ["日本語の文の中のピリオド", "売上は 1.5 倍.次は 2.0 倍", []],
    ["拾う TLD の後ろに、まだ名前が続く", "example.com.bak と foo.computer", []],
    ["スキームだけ", "https:// と書く", []],
    ["http と https のほかのスキーム", "ftp://files.test/a と mailto:x", []],
    ["文字が無い", "", []],
  ])("%s", (_name, text, expected) => {
    expect(bareUrls(text).map((u) => u.url)).toEqual(expected);
  });

  test.each<[string, string, string[]]>([
    ["名前として書いた語（末尾が大文字）は拾わない", "ASP.NET と Socket.IO と Example.COM", []],
    ["ホスト名が大文字で、末尾が小文字のドメインは拾う", "Claude.ai と Fly.io", ["Claude.ai", "Fly.io"]],
    ["大文字のスキーム", "HTTPS://EXAMPLE.COM/A と Http://example.com/b", ["HTTPS://EXAMPLE.COM/A", "Http://example.com/b"]],
    ["スキームの無いドメインのポートとパス", "example.com:8080/a を見る", ["example.com:8080/a"]],
    ["スキームの無いドメインのポートだけ", "example.com:8080。", ["example.com:8080"]],
    ["ドメインの後ろのコロンは、数字が続かなければ含めない", "example.com: 説明", ["example.com"]],
    ["装飾の中に書いたリンクの形", "**[表示](https://example.com/a)**", ["https://example.com/a"]],
  ])("拾う形（確認で見つかった例）: %s", (_name, text, expected) => {
    expect(bareUrls(text).map((u) => u.url)).toEqual(expected);
  });

  test.each<[string, string, boolean[]]>([
    ["地の文", "https://example.com/a と example.org", [false, false]],
    ["太字", "**https://example.com/a**", [true]],
    ["斜体", "*example.com/a*", [true]],
    ["取り消し線", "~~https://example.com/a~~", [true]],
    ["蛍光ペン", "=={pink}https://example.com/a==", [true]],
    ["装飾の中に書いたリンクの形", "==[表示](https://example.com/a)==", [true]],
    ["箇条書きの行は、装飾に数えない", "- https://example.com/a", [false]],
    ["装飾の中と外", "**example.com** と example.org", [true, false]],
  ])("装飾の中にあるか: %s", (_name, text, expected) => {
    expect(bareUrls(text).map((u) => u.decorated)).toEqual(expected);
  });

  // 案内の行き先（href）をリンクの形に書けば、リンクとして読まれ、行き先が元の URL と同じ所を指す。
  // WHY: 案内の形と、リンクを読む式（parseInline）が食い違うと、案内どおりに直してもリンクにならないか、行き先が途中で切れる
  test.each<[string, string, string]>([
    ["https の URL", "資料はhttps://example.com/a/b?c=1#dです。", "https://example.com/a/b?c=1#d"],
    ["スキームの無いドメインには https:// を付ける", "example.com/docs を見る", "https://example.com/docs"],
    ["括弧を含む URL", "https://example.com/wiki/Foo_(bar)", "https://example.com/wiki/Foo_(bar)"],
    ["括弧が 2 組ある URL", "https://example.com/a_(b)_(c)/d", "https://example.com/a_(b)_(c)/d"],
    ["大文字のスキームは小文字にする", "HTTPS://EXAMPLE.COM/A", "https://EXAMPLE.COM/A"],
    ["大文字と小文字のまじったスキーム", "Http://example.com/b", "http://example.com/b"],
    ["ポートの付いた、スキームの無いドメイン", "example.com:8080/a", "https://example.com:8080/a"],
    ["ポートの付いた URL", "http://localhost:3000/a", "http://localhost:3000/a"],
    ["% で書いた文字は、そのまま", "https://example.com/%E8%B3%87?q=%28", "https://example.com/%E8%B3%87?q=%28"],
    ["括弧で囲んだ URL", "（参考: (https://example.com/a)。）", "https://example.com/a"],
  ])("案内どおりに直すと、リンクになる: %s", (_name, text, target) => {
    const [found, ...rest] = bareUrls(text);
    expect(rest).toEqual([]);
    if (found === undefined) throw new Error("URL が見つからない");
    const fixed = text.replace(found.url, `[表示](${found.href})`);
    expect(bareUrls(fixed)).toEqual([]);
    const links = parseInline(fixed).flatMap((i) => (i.kind === "link" ? [i.href] : []));
    // 括弧は % で書いてある。% で書いたほかの文字はそのままなので、括弧だけを戻して比べる
    expect(links.map((h) => h.replaceAll("%28", "(").replaceAll("%29", ")"))).toEqual([target.replaceAll("%28", "(")]);
    expect(links.every((h) => !/[()]/.test(h))).toBe(true);
  });

  test.each<[string, string, string]>([
    ["太字の中の URL", "**https://example.com/a**", "[表示](https://example.com/a)"],
    ["蛍光ペンの中のドメイン", "==example.com/docs==", "[表示](https://example.com/docs)"],
    ["太字の中に書いたリンクの形", "**[表示](https://example.com/a)**", "[表示](https://example.com/a)"],
  ])("装飾を外して、案内のリンクの形だけにすると、リンクになる: %s", (_name, text, fixed) => {
    expect(bareUrls(text).map((u) => `[表示](${u.href})`)).toEqual([fixed]);
    expect(bareUrls(fixed)).toEqual([]);
    expect(parseInline(fixed).map((i) => i.kind)).toEqual(["link"]);
  });
});
