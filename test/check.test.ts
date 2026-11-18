import { describe, expect, test } from "bun:test";
import { checkBoard, type CheckContext } from "../src/shared/check.ts";
import { applyOps, emptyDoc } from "../src/shared/model.ts";

const add = (el: Record<string, unknown>) => ({ op: "add", el });
const box = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => add({ id, type: "shape", shape: "rect", x, y, w: 200, h: 80, ...extra });
const section = (id: string, x: number, y: number, w = 504, h = 300) => add({ id, type: "container", x, y, w, h });

function check(ops: unknown[]): string[] {
  const r = applyOps(emptyDoc("t"), ops);
  if (!r.ok) throw new Error(r.error);
  return checkBoard(r.value.doc).map((i) => `${i.kind}:${i.ids.join(",")}`);
}

/** 種類と id に、どれくらいか（px）も付けて返す */
function checkPx(ops: unknown[]): string[] {
  const r = applyOps(emptyDoc("t"), ops);
  if (!r.ok) throw new Error(r.error);
  return checkBoard(r.value.doc).map((i) => `${i.kind}:${i.ids.join(",")}:${i.px}`);
}

describe("問題の無い置き方では、何も返さない", () => {
  test.each([
    ["間を空けて並べた箱", [box("a", 0, 0), box("b", 260, 0)]],
    ["セクションの中に、余白を取って置いた箱", [section("s", 0, 0), box("a", 24, 52)]],
    ["自動で置いた付箋（in）", [section("s", 0, 0), { op: "add", in: "s", el: { id: "a", type: "shape", text: "付箋" } }, { op: "add", in: "s", el: { id: "b", type: "shape", text: "付箋" } }]],
    ["箱と箱を結ぶ矢印", [box("a", 0, 0), box("b", 400, 0), add({ id: "ab", type: "arrow", from: "a", to: "b", label: "呼ぶ" })]],
    ["箱をよける折れ線", [box("a", 0, 0), box("mid", 300, 0), box("b", 600, 0), add({ id: "ab", type: "arrow", from: "a", to: "b", route: "elbow" })]],
    ["セクションの中を通る矢印（セクションは箱に数えない）", [section("s", 250, -100, 100, 300), box("a", 0, 0), box("b", 400, 0), add({ id: "ab", type: "arrow", from: "a", to: "b" })]],
    ["コメントは、中身に重ねてよい", [box("a", 0, 0), add({ id: "c", type: "comment", x: -10, y: -10, w: 300, h: 200 })]],
    ["文字が収まる箱", [box("a", 0, 0, { text: "短い文" })]],
    ["列で並べるセクションに、順に足した付箋", [add({ id: "s", type: "container", x: 0, y: 0, w: 736, cols: 3 }), ...["a", "b", "c", "d"].map((id) => ({ op: "add", in: "s", el: { id, type: "shape", text: "付箋" } }))]],
    ["名前が欄に入り、印の名前が重ならずに段へ分かれるガント", [add({ id: "g", type: "gantt", x: 0, y: 0, w: 456, start: "2026-12", end: "2027-11", bars: [{ name: "会議参加と調査", start: "2026-12", end: "2026-12" }], marks: [{ name: "動作確認 1 回め", date: "2026-12" }, { name: "動作確認 2 回め", date: "2027-01" }] })]],
  ])("%s", (_name, ops) => {
    expect(check(ops)).toEqual([]);
  });
});

describe("崩れを、種類と要素の id で返す", () => {
  test.each([
    ["箱どうしが重なっている", [box("a", 0, 0), box("b", 150, 40)], ["overlap:a,b"]],
    ["文字が箱に隠れている", [box("a", 0, 0), add({ id: "t", type: "text", x: 20, y: 30, text: "隠れた文字" })], ["overlap:a,t"]],
    ["中身がセクションからはみ出している", [section("s", 0, 0), box("a", 380, 60)], ["outside-section:a,s"]],
    ["外の要素がセクションの枠にかかっている", [section("s", 0, 0), box("a", 490, 60)], ["on-section-edge:a,s"]],
    ["中身がセクションの端に詰まっている", [section("s", 0, 0), box("a", 2, 60)], ["cramped:a,s"]],
    ["中身がセクションの題名にかかっている", [section("s", 0, 0), box("a", 24, 10)], ["cramped:a,s"]],
    ["矢印が、間の箱を突き抜けている", [box("a", 0, 0), box("mid", 300, 0), box("b", 600, 0), add({ id: "ab", type: "arrow", from: "a", to: "b" })], ["arrow-through:ab,mid"]],
    ["矢印のラベルが、両端の箱にかかっている", [box("a", 0, 0), box("b", 230, 0), add({ id: "ab", type: "arrow", from: "a", to: "b", label: "長いラベルが入らない" })], ["label-overlap:ab,a", "label-overlap:ab,b"]],
    [
      "矢印のラベルに、ほかの矢印がかかっている",
      [box("a", 0, 0), box("b", 600, 0), box("c", 300, -300), box("d", 300, 300), add({ id: "ab", type: "arrow", from: "a", to: "b", label: "横の線" }), add({ id: "cd", type: "arrow", from: "c", to: "d" })],
      ["label-overlap:ab,cd"],
    ],
    ["文字が小さくなりすぎる", [box("a", 0, 0, { text: "この箱には、とても入りきらないくらいの長い文を、たくさん書いてあります。読める大きさでは収まりません。" })], ["small-text:a"]],
    ["ガントの行の名前が、欄に入りきらず切れている", [add({ id: "g", type: "gantt", x: 0, y: 0, bars: [{ name: "本格化（開発・2 要素認証など）", start: "2027-02", end: "2027-11" }] })], ["gantt-text:g"]],
    ["ガントの印の名前が、枠からはみ出している", [add({ id: "g", type: "gantt", x: 0, y: 0, w: 300, bars: [{ name: "a", start: "2027-01", end: "2027-02" }], marks: [{ name: "とても長い名前のマイルストーンで枠に入らない", date: "2027-02" }] })], ["gantt-text:g"]],
    ["文字が、いちばん小さくしても収まらない", [box("a", 0, 0, { h: 30, text: "1 行め\n2 行め\n3 行め\n4 行め" })], ["text-overflow:a"]],
  ])("%s", (_name, ops, expected) => {
    expect(check(ops)).toEqual(expected);
  });
});

describe("蛍光ペンの色が地の色に近いと、見分けにくいと知らせる", () => {
  const note = (color: string, text: string, extra: Record<string, unknown> = {}) => [add({ id: "n", type: "shape", x: 0, y: 0, w: 400, h: 110, color, text, ...extra })];

  test.each([
    ["地と同じ色: 黄の上の黄", note("yellow", "==帯=="), ["highlight-contrast:n"]],
    ["地と同じ色: 緑の上の緑", note("green", "=={green}帯=="), ["highlight-contrast:n"]],
    ["地と同じ色: 青の上の青", note("blue", "=={blue}帯=="), ["highlight-contrast:n"]],
    ["地と同じ色: ピンクの上のピンク", note("pink", "=={pink}帯=="), ["highlight-contrast:n"]],
    ["地と同じ色: オレンジの上のオレンジ", note("orange", "=={orange}帯=="), ["highlight-contrast:n"]],
    ["地に近い色: 紫の上の青", note("purple", "=={blue}帯=="), ["highlight-contrast:n"]],
    ["地に近い色: 紫の上のピンク", note("purple", "=={pink}帯=="), ["highlight-contrast:n"]],
    ["地に近い色: 赤の上のピンク", note("red", "=={pink}帯=="), ["highlight-contrast:n"]],
    ["地に近い色: 黄の上のオレンジ", note("yellow", "=={orange}帯=="), ["highlight-contrast:n"]],
    ["同じ付箋に同じ弱い色が何度出ても、1 件だけ返す", note("blue", "=={blue}帯==と=={blue}もう 1 つ==と==黄=="), ["highlight-contrast:n"]],
    ["黄の上のピンク・青・緑は見分けられる", note("yellow", "=={pink}帯== =={blue}帯== =={green}帯=="), []],
    ["青緑の上の青と緑は見分けられる", note("teal", "=={blue}帯== =={green}帯=="), []],
    ["灰の上は、どの色も見分けられる", note("gray", "==黄== =={green}緑== =={blue}青== =={pink}ピンク== =={orange}オレンジ=="), []],
    ["白の地の上は、どの色も見分けられる", note("white", "==黄== =={green}緑== =={blue}青== =={pink}ピンク== =={orange}オレンジ=="), []],
    ["濃い箱の上は、どの色も見分けられる", note("ink", "==黄== =={blue}青==", { shape: "rect" }), []],
    ["中を塗らない箱は、ボードの地の上なので、箱の色と同じ色でも見分けられる", note("blue", "=={blue}帯==", { shape: "rect", hollow: true }), []],
    ["蛍光ペンが無ければ、何も返さない", note("blue", "ふつうの文"), []],
    ["文字（text）の上は、どの色も見分けられる", [add({ id: "t", type: "text", x: 0, y: 0, text: "==黄== =={green}緑== =={blue}青== =={pink}ピンク== =={orange}オレンジ==" })], []],
    ["表のセルと見出しの上は、どの色も見分けられる", [add({ id: "tb", type: "table", x: 0, y: 0, head: ["=={blue}青=="], rows: [["=={blue}青== ==黄=="]] })], []],
  ])("%s", (_name, ops, expected) => {
    expect(check(ops)).toEqual(expected);
  });
});

describe("同じ中身の繰り返しを知らせる", () => {
  const notes = (...texts: string[]) => texts.map((text, i) => add({ id: `n${i + 1}`, type: "shape", x: i * 300, y: 0, w: 260, h: 140, text }));

  test.each([
    ["同じ文の付箋が 2 枚", notes("ゴールは 2027 年度中に外販できる状態にすること", "ゴールは 2027 年度中に外販できる状態にすること"), ["duplicate-text:n1,n2"]],
    ["言い換えた文（短いほうの中身が、長いほうにほぼ含まれる）", notes("相談役だけでなく、Accel-Hack から誰か出して、2 要素認証やドメイン別開発を実際に開発してほしい", "Accel-Hack も 2 要素認証などを実際に開発する"), ["duplicate-text:n1,n2"]],
    ["同じ話でも、言い回しが大きく違えば拾わない（重なりが 6 割に届かない）", notes("12/1 ごろから Accel-Hack が入る。週 1〜2 のミーティングに参加する形で進める", "12/1 ごろから Accel-Hack が週 1・8 時間で入る"), []],
    ["装飾の記号と空白の違いは、同じ文として数える", notes("本番切替は **2027/11** のベンダー案で進める", "本番切替は2027/11のベンダー案で進める"), ["duplicate-text:n1,n2"]],
    ["互いに似ている 3 枚は、1 件にまとめる", notes("移行リハーサルを 2 回行う予定で進める", "移行リハーサルを 2 回行う予定で進めたい", "移行リハーサルは 2 回行う予定で進める"), ["duplicate-text:n1,n2,n3"]],
    ["社名が 1 つ重なるだけの文は、似ているとしない", notes("メディステップ側の体制は須藤さん 1 人", "メディステップが新しいシステムを外販する"), []],
    ["違う話の付箋は、何も返さない", notes("テストの充実と重複ソースの整理が先", "インフラのミーティングにも一緒に出てほしい"), []],
    ["短い語が同じでも、似ているとしない", notes("未定", "未定"), []],
    [
      "同じ日付が 3 枚に書かれている",
      notes("12/1 ごろから入る", "提案は 12/1 までに出す", "12/1 のミーティングで決める"),
      ["repeated-value:n1,n2,n3"],
    ],
    ["同じ日付が 2 枚なら、知らせない", notes("12/1 ごろから入る", "提案は 12/1 までに出す"), []],
    [
      "書き方の違う同じ年度は、同じものとして数える",
      notes("2027 年度中に外販する", "外販できる状態は2027年度中", "2027年度中がゴール"),
      ["repeated-value:n1,n2,n3"],
    ],
    ["年の無い月や、単位の無い数は数えない", notes("1 月に相談する", "1 月に増やすか決める", "1 月の稼働を出す", "2 要素認証を入れる"), []],
  ])("%s", (_name, ops, expected) => {
    expect(check(ops)).toEqual(expected);
  });
});

test("どれくらいかを数で返す（重なりの幅と高さ、はみ出した長さ、文字の大きさ）", () => {
  const r = applyOps(emptyDoc("t"), [section("s", 0, 0), box("a", 380, 60), box("b", 100, 160), box("c", 250, 200), box("d", 2000, 0, { h: 100, text: "あ".repeat(84) })]);
  if (!r.ok) throw new Error(r.error);
  const issues = checkBoard(r.value.doc).map(({ kind, ids, w, h, px }) => ({ kind, ids, w, h, px }));
  expect(issues).toEqual([
    { kind: "overlap", ids: ["b", "c"], w: 50, h: 40, px: undefined },
    { kind: "outside-section", ids: ["a", "s"], w: undefined, h: undefined, px: 76 },
    { kind: "small-text", ids: ["d"], w: undefined, h: undefined, px: 10 },
  ]);
});

describe("列で並べるセクションの、列の幅", () => {
  // 列の幅は (w − 48 − 16 × (cols − 1)) ÷ cols。120 より狭いと知らせる
  test.each([
    ["3 列で幅 439 は、1 列が 119", { w: 439, cols: 3 }, ["narrow-column:s:119"]],
    ["3 列で幅 440 は、1 列が 120 で足りる", { w: 440, cols: 3 }, []],
    ["既定の幅（504）に 4 列は、1 列が 102", { w: 504, cols: 4 }, ["narrow-column:s:102"]],
    ["cols が無いセクションは見ない", { w: 100 }, []],
  ])("%s", (_name, extra, expected) => {
    expect(checkPx([add({ id: "s", type: "container", x: 0, y: 0, h: 160, ...extra })])).toEqual(expected);
  });
});

describe("ほかのボードへのリンクの行き先", () => {
  const exists = (ref: string): boolean => ref === "ある.board.json";
  const run = (el: Record<string, unknown>, ctx: CheckContext = { boardExists: exists }): string[] => {
    const r = applyOps(emptyDoc("t"), [add(el)]);
    if (!r.ok) throw new Error(r.error);
    return checkBoard(r.value.doc, ctx).map((i) => `${i.kind}:${i.ids.join(",")}`);
  };
  test.each([
    ["付箋の文字のリンクの行き先が無い", { id: "a", type: "shape", text: "[x](無い.board.json)" }, ["dead-link:a"]],
    ["行き先がある", { id: "a", type: "shape", text: "[x](ある.board.json)" }, []],
    ["表のセルのリンク", { id: "t", type: "table", rows: [["[x](無い.board.json)"]] }, ["dead-link:t"]],
    ["表の見出しのリンク", { id: "t", type: "table", head: ["[x](無い.board.json)"], rows: [["a"]] }, ["dead-link:t"]],
    ["画像の href", { id: "i", type: "image", svg: "<svg/>", href: "無い.board.json" }, ["dead-link:i"]],
    ["Web のリンクは見ない", { id: "a", type: "shape", text: "[x](https://example.com/無い.board.json)" }, []],
  ])("%s", (_name, el, expected) => {
    expect(run(el)).toEqual(expected);
  });

  test("ファイルを確かめる手段を渡さなければ、リンクは見ない", () => {
    expect(run({ id: "a", type: "shape", text: "[x](無い.board.json)" }, {})).toEqual([]);
  });
});

describe("リンクの形で書いていない URL", () => {
  // どの文字を URL と読むかは、test/rich.test.ts の表で確かめる。ここは、どの要素のどの文字を見るかと、案内の文
  const run = (el: Record<string, unknown>): string[] => {
    const r = applyOps(emptyDoc("t"), [add(el)]);
    if (!r.ok) throw new Error(r.error);
    return checkBoard(r.value.doc)
      .filter((i) => i.kind === "bare-url")
      .map((i) => `${i.ids.join(",")}: ${i.message}`);
  };
  const hint = "（「表示」は、行き先が分かる短い名前に替える）";
  const decorated = "装飾（太字・斜体・取り消し線・蛍光ペン）の中にあり、リンクにならない。装飾は重ねられないので、装飾を外して、リンクの形だけで書く";
  test.each([
    ["付箋の本文の https の URL", { id: "a", type: "shape", text: "資料は https://example.com/a。" }, ["a: a の URL（https://example.com/a）は、ただの文字で出て押せない。リンクの形で書く: [表示](https://example.com/a)" + hint]],
    ["スキームの無いドメインは、https:// を付けて案内する", { id: "a", type: "shape", text: "example.com/docs を見る" }, ["a: a の URL（example.com/docs）は、ただの文字で出て押せない。リンクの形で書く: [表示](https://example.com/docs)" + hint]],
    [
      "1 つの要素にいくつあっても、知らせは 1 件。同じ URL は 1 回だけ出す",
      { id: "a", type: "shape", text: "https://example.com/a と example.org\nhttps://example.com/a" },
      ["a: a の URL（https://example.com/a、example.org）は、ただの文字で出て押せない。リンクの形で書く: [表示](https://example.com/a)、[表示](https://example.org)" + hint],
    ],
    ["文字（text）の要素", { id: "x", type: "text", text: "http://example.com", x: 0, y: 0 }, ["x: x の URL（http://example.com）は、ただの文字で出て押せない。リンクの形で書く: [表示](http://example.com)" + hint]],
    ["表のセル", { id: "t", type: "table", rows: [["a", "https://example.com/a"]] }, ["t: t の URL（https://example.com/a）は、ただの文字で出て押せない。リンクの形で書く: [表示](https://example.com/a)" + hint]],
    ["表の見出し", { id: "t", type: "table", head: ["example.com"], rows: [["a"]] }, ["t: t の URL（example.com）は、ただの文字で出て押せない。リンクの形で書く: [表示](https://example.com)" + hint]],
    ["括弧は % で、スキームは小文字で案内する", { id: "a", type: "shape", text: "HTTPS://example.com/wiki/Foo_(bar)" }, ["a: a の URL（HTTPS://example.com/wiki/Foo_(bar)）は、ただの文字で出て押せない。リンクの形で書く: [表示](https://example.com/wiki/Foo_%28bar%29)" + hint]],
    ["装飾の中の URL には、装飾を外すよう案内する", { id: "a", type: "shape", text: "**https://example.com/a**" }, ["a: a の URL（https://example.com/a）は、" + decorated + ": [表示](https://example.com/a)" + hint]],
    ["装飾の中に書いたリンクの形にも、同じ案内を出す", { id: "a", type: "shape", text: "==[仕様](https://example.com/a)==" }, ["a: a の URL（https://example.com/a）は、" + decorated + ": [表示](https://example.com/a)" + hint]],
    [
      "装飾の中と外の両方にあれば、知らせを分ける",
      { id: "a", type: "shape", text: "example.org と **example.com**" },
      ["a: a の URL（example.org）は、ただの文字で出て押せない。リンクの形で書く: [表示](https://example.org)" + hint, "a: a の URL（example.com）は、" + decorated + ": [表示](https://example.com)" + hint],
    ],
    ["リンクの形で書いた URL は知らせない", { id: "a", type: "shape", text: "[仕様](https://example.com/a)" }, []],
    ["コードの中の URL は知らせない", { id: "a", type: "shape", text: "`https://example.com/a`" }, []],
    ["ほかのボードへのリンクとファイル名は知らせない", { id: "a", type: "shape", text: "[x](anken.board.json) と README.md" }, []],
    ["付箋の見出し（title）と札（tag）は見ない（装飾が効かない）", { id: "a", type: "shape", title: "example.com", tag: "example.org", text: "本文" }, []],
    ["セクションの題名は見ない", { id: "s", type: "container", title: "https://example.com/a", x: 0, y: 0, w: 400, h: 200 }, []],
  ])("%s", (_name, el, expected) => {
    expect(run(el)).toEqual(expected);
  });
});

describe("付箋の欄", () => {
  const note = (extra: Record<string, unknown>) => [add({ id: "a", type: "shape", x: 0, y: 0, w: 220, h: 110, ...extra })];
  test.each([
    ["欄に書いた付箋は、何も返さない", note({ title: "見積もりを出す", text: "来週の定例まで", who: "竹内", carriedFrom: "2026-11-11" }), []],
    ["1 行めの太字は、見出しに書く", note({ text: "**見積もりを出す**\n来週の定例まで" }), ["handwritten-field:a"]],
    ["太字だけの 1 行は、見出しにしなくてよい", note({ text: "**見積もりを出す**" }), []],
    ["持ち越しの日付: 本文の、区切りの後ろ", note({ text: "見積もり · 11/11 から" }), ["handwritten-field:a"]],
    ["持ち越しの日付: 本文の、「・」の後ろ", note({ text: "見積もり・11/11 から" }), ["handwritten-field:a"]],
    ["持ち越しの日付: 札の、区切りの後ろ", note({ tag: "宿題 · 11/11 から", text: "見積もり" }), ["handwritten-field:a"]],
    ["持ち越しの日付: 札の全体", note({ tag: "11/11 から", text: "見積もり" }), ["handwritten-field:a"]],
    ["持ち越しの日付: 本文の、日付だけの行", note({ text: "見積もり\n11/11 から" }), ["handwritten-field:a"]],
    ["持ち越しの日付: 本文の、括弧の中", note({ text: "見積もり（11/11 から）" }), ["handwritten-field:a"]],
    ["持ち越しの日付: 本文の、「→」の後ろ", note({ text: "見積もり→11/11 から" }), ["handwritten-field:a"]],
    ["区切りの無い「M/D から」は、ふつうの文", note({ text: "4/1 から新体制で始める" }), []],
    ["分数の後ろの「から」は、ふつうの文", note({ text: "2/3 から 3/4 に上げる" }), []],
    ["carriedFrom があれば、日付は見ない", note({ text: "見積もり · 11/11 から", carriedFrom: "2026-11-11" }), []],
    ["札の状態: 状態の名前だけ", note({ tag: "決定", text: "見積もり" }), ["handwritten-field:a"]],
    ["札の状態: 後ろに「·」", note({ tag: "決定 · 竹内さん", text: "見積もり" }), ["handwritten-field:a"]],
    ["札の状態: 後ろに空白", note({ tag: "未決 竹内さん", text: "見積もり" }), ["handwritten-field:a"]],
    ["札の状態: 後ろに「：」", note({ tag: "持ち越し：竹内さん", text: "見積もり" }), ["handwritten-field:a"]],
    ["札の状態: 後ろに「/」", note({ tag: "優先/竹内さん", text: "見積もり" }), ["handwritten-field:a"]],
    ["札の状態: 後ろに全角の括弧", note({ tag: "決定（竹内）", text: "見積もり" }), ["handwritten-field:a"]],
    ["札の状態: 後ろに半角の括弧", note({ tag: "決定(竹内)", text: "見積もり" }), ["handwritten-field:a"]],
    ["札の状態: 後ろに「→」", note({ tag: "決定→竹内", text: "見積もり" }), ["handwritten-field:a"]],
    ["状態の名前で始まる別の語（決定事項）は、状態ではない", note({ tag: "決定事項の確認", text: "見積もり" }), []],
    ["状態の名前で始まる別の語（優先度）は、状態ではない", note({ tag: "優先度 高", text: "見積もり" }), []],
    ["status があれば、札は見ない", note({ tag: "決定 · 竹内さん", status: "decided", text: "見積もり" }), []],
  ])("%s", (_name, ops, expected) => {
    expect(check(ops)).toEqual(expected);
  });

  // 幅 220 の付箋の、文字の入る幅は 196。太字の全角は 1 文字 15。大文字は、いちばん広い字の幅で見積もる（M と W は 16.2、ほかは 12.9）
  test.each([
    ["全角 13 文字は 1 行に入る", "あいうえおかきくけこさしす", []],
    ["全角 14 文字は 2 行になる", "あいうえおかきくけこさしすせ", ["long-title:a:2"]],
    ["半角の大文字が混ざると、13 文字より少なくても 2 行になる", "VALUE 案を外向けに掲げる", ["long-title:a:2"]],
    ["M が 12 文字は 1 行に入る", "MMMMMMMMMMMM", []],
    ["M が 13 文字は 2 行になる", "MMMMMMMMMMMMM", ["long-title:a:2"]],
    ["M と W のほかの大文字は、15 文字が 1 行に入る", "ABCDEFGHIJKLNOP", []],
    ["M と W のほかの大文字は、16 文字で 2 行になる", "ABCDEFGHIJKLNOPQ", ["long-title:a:2"]],
    ["半角の小文字 20 文字は 1 行に入る", "abcdefghijklmnopqrst", []],
    ["半角の小文字 21 文字は 2 行になる", "abcdefghijklmnopqrstu", ["long-title:a:2"]],
  ])("見出しの長さ: %s", (_name, title, expected) => {
    expect(checkPx(note({ title, text: "補足" }))).toEqual(expected);
  });

  // 同じ本文（1 行）で、札と見出しを足すと、入る高さの下限が上がる。札の段（状態・tag・who を並べる 1 段）で 21、見出し 1 行で 23
  test.each([
    ["本文だけ。高さ 36 で入る", { h: 36, text: "補足の文" }, []],
    ["本文だけ。高さ 35 では小さくなる", { h: 35, text: "補足の文" }, ["small-text:a:10"]],
    ["status 付き。高さ 57 で入る", { h: 57, text: "補足の文", status: "open" }, []],
    ["status 付き。高さ 56 では小さくなる", { h: 56, text: "補足の文", status: "open" }, ["small-text:a:10"]],
    ["who 付き。高さ 57 で入る", { h: 57, text: "補足の文", who: "竹内" }, []],
    ["who 付き。高さ 56 では小さくなる", { h: 56, text: "補足の文", who: "竹内" }, ["small-text:a:10"]],
    ["tag 付き。高さ 57 で入る", { h: 57, text: "補足の文", tag: "事実" }, []],
    ["tag 付き。高さ 56 では小さくなる", { h: 56, text: "補足の文", tag: "事実" }, ["small-text:a:10"]],
    ["tag と who は同じ段に並ぶ。高さ 57 で入る", { h: 57, text: "補足の文", tag: "事実", who: "竹内" }, []],
    ["tag と who。高さ 56 では小さくなる", { h: 56, text: "補足の文", tag: "事実", who: "竹内" }, ["small-text:a:10"]],
    ["tag と status と who も 1 段。高さ 57 で入る", { h: 57, text: "補足の文", tag: "事実", status: "open", who: "竹内" }, []],
    ["tag と status と who。高さ 56 では小さくなる", { h: 56, text: "補足の文", tag: "事実", status: "open", who: "竹内" }, ["small-text:a:10"]],
    ["title と tag と status と who。高さ 80 で入る", { h: 80, text: "補足の文", title: "見積もり", tag: "事実", status: "open", who: "竹内" }, []],
    ["title と tag と status と who。高さ 79 では小さくなる", { h: 79, text: "補足の文", title: "見積もり", tag: "事実", status: "open", who: "竹内" }, ["small-text:a:10"]],
    ["title 付き。高さ 59 で入る", { h: 59, text: "補足の文", title: "見積もり" }, []],
    ["title 付き。高さ 58 では小さくなる", { h: 58, text: "補足の文", title: "見積もり" }, ["small-text:a:10"]],
    ["title と status 付き。高さ 80 で入る", { h: 80, text: "補足の文", title: "見積もり", status: "open" }, []],
    ["title と status 付き。高さ 79 では小さくなる", { h: 79, text: "補足の文", title: "見積もり", status: "open" }, ["small-text:a:10"]],
    ["title だけ。高さ 43 で入る", { h: 43, title: "見積もり" }, []],
    ["title だけ。高さ 42 では収まらない", { h: 42, title: "見積もり" }, ["text-overflow:a:undefined"]],
  ])("札と見出しで減る高さ: %s", (_name, extra, expected) => {
    expect(checkPx(note(extra))).toEqual(expected);
  });

  // 札の段は 1 段で、折り返さない。幅 220 の付箋の内側は 196。全角 1 文字が 10.5、状態の札と who の札の余白が 12 ずつ、札どうしの間が 4、tag は字の間が 0.42 ずつ
  const z = (n: number): string => "あ".repeat(n);
  const over = (ops: unknown[]): string[] => {
    const r = applyOps(emptyDoc("t"), ops);
    if (!r.ok) throw new Error(r.error);
    return checkBoard(r.value.doc).flatMap((i) => (i.kind === "meta-overflow" ? [`${i.ids.join(",")}:${i.w}`] : []));
  };
  test.each([
    ["札が無い", { text: "本文" }, []],
    ["who が全角 17 文字（190.5）は入る", { who: z(17) }, []],
    ["who が全角 18 文字（201）は入りきらない", { who: z(18) }, ["a:5"]],
    ["tag が全角 17 文字（185.6）は入る", { tag: z(17) }, []],
    ["tag が全角 18 文字（196.6）は入りきらない", { tag: z(18) }, ["a:1"]],
    ["tag 8 文字と who 8 文字（187.4）は入る", { tag: z(8), who: z(8) }, []],
    ["tag 8 文字と who 9 文字（197.9）は入りきらない", { tag: z(8), who: z(9) }, ["a:2"]],
    ["状態と tag 5 文字と who 8 文字（191.6）は入る", { status: "decided", tag: z(5), who: z(8) }, []],
    ["状態と tag 6 文字と who 8 文字（202.5）は入りきらない", { status: "decided", tag: z(6), who: z(8) }, ["a:7"]],
    ["日付つきの持ち越しと、2 文字の tag と、役割つきの who は入る", { carriedFrom: "2026-11-11", tag: "宿題", who: "発言 高坂" }, []],
    ["月までの持ち越しと、2 文字の tag と、役割つきの who は入る", { carriedFrom: "2026-11", tag: "宿題", who: "発言 高坂" }, []],
    ["幅を増やせば入る", { tag: z(8), who: z(9), w: 222 }, []],
    ["幅 141 の付箋（内側 117）に、状態と tag と who は入りきらない", { status: "decided", tag: "事実", who: "担当 設楽", w: 141 }, ["a:7"]],
    ["幅 141 の付箋に、tag と who だけなら入る", { tag: "事実", who: "担当 設楽", w: 141 }, []],
    ["付箋でない箱も、同じ内側の幅で見る", { shape: "rect", tag: z(8), who: z(9) }, ["a:2"]],
    ["楕円は、内側が狭い（幅の 0.72）", { shape: "ellipse", tag: z(8), who: z(6), h: 160 }, ["a:8"]],
  ])("札の段が 1 段に入るか: %s", (_name, extra, expected) => {
    expect(over(note(extra))).toEqual(expected);
  });

  test("持ち越しの日付を carriedFrom に書けば、同じ日付の繰り返しにならない", () => {
    const ops = ["a", "b", "c"].map((id, i) => add({ id, type: "shape", x: i * 300, y: 0, text: `件 ${id}`, carriedFrom: "2026-11-11" }));
    expect(check(ops)).toEqual([]);
  });
});

describe("セクションの論点と結論", () => {
  const sec = (extra: Record<string, unknown>) => add({ id: "s", type: "container", x: 0, y: 0, w: 504, cols: 2, ...extra });
  test.each([
    ["論点があって結論が無い", [sec({ question: "来期の採用は何人か" })], ["open-question:s"]],
    ["結論がある", [sec({ question: "来期の採用は何人か", answer: "2 人。4 月入社" })], []],
    ["論点が無いセクションは見ない", [sec({})], []],
    ["自由に置くセクションで、中身が論点にかかる", [add({ id: "s", type: "container", x: 0, y: 0, w: 504, h: 300, question: "来期の採用は何人か", answer: "2 人" }), box("a", 24, 52)], ["cramped:a,s"]],
  ])("%s", (_name, ops, expected) => {
    expect(check(ops)).toEqual(expected);
  });
});

describe("列で並べるセクションの中の、別のセクション", () => {
  const outer = (extra: Record<string, unknown>) => [add({ id: "s", type: "container", x: 0, y: 0, w: 504, h: 186, ...extra }), { op: "add", in: "s", el: { id: "a", type: "shape", text: "付箋" } }];
  // 付箋 a（左の列）にかからない、右の列の空いた場所に置く
  const inner = (x: number) => add({ id: "in", type: "container", x, y: 70, w: 150, h: 70 });
  test.each([
    ["中心が、列で並べるセクションの枠の中にある", [...outer({ cols: 2 }), inner(280)], ["nested-section:in,s"]],
    ["自由に置くセクションの中のセクションは、知らせない", [...outer({}), inner(280)], []],
    ["列で並べるセクションの外にあるセクションは、知らせない", [...outer({ cols: 2 }), inner(600)], []],
  ])("%s", (_name, ops, expected) => {
    expect(check(ops)).toEqual(expected);
  });
});
