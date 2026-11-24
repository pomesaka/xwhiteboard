// ボードの見た目の問題を、描かずに測る。エージェントが、スクショを見なくても崩れに気づけるようにする。
// 文字と表の大きさは見積もり（model.ts の sizeOf）なので、画面で測った値とは数 px ずれる。
import { sectionTop, CARRIABLE, FONT, NOTE_SUB_FONT, NOTE_STATUS, NOTE_TITLE_FONT, PAD, STATUS_LABEL, TITLE_H, isOverdue, membersOf, ridersOf, metaParts, statusBadge, boxOf, colWidth, isSolid, textWidth, type Box, type Doc, type El, type MetaPart, type Point, type ShapeKind } from "./model.ts";
import { FILL, HIGHLIGHT, PAPER, TABLE_CELL, TABLE_HEAD, colorDistance } from "./colors.ts";
import { ganttLayout } from "./gantt.ts";
import type { Color } from "./model.ts";
import { collect, filterKey, filterOf, filterTitle, rowsFor } from "./summary.ts";
import { bareUrls, isBoardRef, parseRich, plainText, type MarkColor } from "./rich.ts";
import { LABEL_FONT, LABEL_LIFT, arrowPath, labelSpot } from "./route.ts";

export type IssueKind =
  /** 中身どうしが重なっている */
  | "overlap"
  /** セクションの中身が、枠からはみ出している */
  | "outside-section"
  /** セクションの外の要素が、枠にかかっている */
  | "on-section-edge"
  /** 中身が、セクションの端か題名に詰まっている */
  | "cramped"
  /** 矢印が、両端ではない箱を突き抜けている */
  | "arrow-through"
  /** 矢印のラベルが、箱か、ほかの矢印にかかっている */
  | "label-overlap"
  /** 図形の文字が、収めるために読みにくい大きさまで小さくなっている */
  | "small-text"
  /** 図形の文字が、いちばん小さくしても収まらない */
  | "text-overflow"
  /** ガントの行の名前が欄に入りきらず「…」で切れている。または、印の名前がガントの枠からはみ出している */
  | "gantt-text"
  /** 蛍光ペンの色が地の色に近くて、帯が見分けにくい */
  | "highlight-contrast"
  /** 似た中身の付箋や文字が、複数ある */
  | "duplicate-text"
  /** 同じ日付や金額が、3 つ以上の付箋や文字に書かれている */
  | "repeated-value"
  /** ほかのボードへのリンクの行き先に、ファイルが無い */
  | "dead-link"
  /** URL が、リンクの形（[文字](https://…)）で書かれていなくて、押せない */
  | "bare-url"
  /** 列で並べるセクション（cols）の 1 列が狭くて、付箋の文字が入りにくい */
  | "narrow-column"
  /** 付箋の欄（title・status・carriedFrom）に書けることを、本文や札（tag）に手で書いている */
  | "handwritten-field"
  /** 付箋の見出し（title）が 1 行に入らない */
  | "long-title"
  /** 付箋の札の段（状態の札、tag、発言者）が 1 段に入りきらず、tag か発言者が「…」で切れる */
  | "meta-overflow"
  /** 付箋の期限（due）を過ぎている */
  | "overdue"
  /** セクションに論点（question）があって、結論（answer）が無い */
  | "open-question"
  /** 列で並べるセクション（cols）の中に、別のセクションがある */
  | "nested-section"
  /** 透明な枠（frame: "none"）に、中身が 1 つも無い */
  | "empty-frame"
  /** 同じ状態を集めるまとめの帯（summary）が、2 つ以上ある */
  | "duplicate-summary"
  /** 固定したセクションの中に、同じ状態の付箋が並んでいる（手で写したまとめ） */
  | "manual-summary"
  /** 発言者か tag で集めるまとめの帯に、当たる付箋が 1 枚も無い */
  | "empty-summary"
  /** まとめの帯が、セクションの中にある */
  | "summary-in-section"
  /** 未解決のコメントの on が、ボードに無い要素を指している */
  | "dead-comment-target";

/**
 * 検査の種類。break は崩れ（見た目が壊れている、押しても動かない、書いた意図どおりに描けていない）。いつも出す。
 * style は書き方の提案（会議のボードの書き方の決まりに沿っていない。崩れてはいない）。CheckContext の style を付けたときだけ出す。
 * WHY 分ける: 書き方の決まりまでいつも出すと、ふつうのホワイトボードとして自然に書いた文が「直すもの」と出て、エージェントが人の書いた文を書き換えにいく
 */
export type IssueLevel = "break" | "style";

/**
 * 規則ごとの種類。規則を足すときは、ここで必ずどちらかを決める（Record なので、決めないと型検査が落ちる）。
 * 判断の基準は「直さないと、見た目か動きが壊れたままか」。壊れたままなら break、そうでなければ style
 */
export const LEVEL: Record<IssueKind, IssueLevel> = {
  overlap: "break",
  "outside-section": "break",
  "on-section-edge": "break",
  cramped: "break",
  "arrow-through": "break",
  "label-overlap": "break",
  "small-text": "break",
  "text-overflow": "break",
  "gantt-text": "break",
  "meta-overflow": "break",
  "highlight-contrast": "break",
  "dead-link": "break",
  "bare-url": "break",
  "narrow-column": "break",
  "nested-section": "break",
  // 見えない枠が場所を取り、format で 1 つのまとまりとして動く。画面では気づけないが、見た目は崩れていない
  "empty-frame": "style",
  "summary-in-section": "break",
  // 書いた条件が、意図した付箋を集めていない
  "empty-summary": "break",
  // ピンが要素に付いて動かず、Claude に届く中身から、指していた要素が抜ける
  "dead-comment-target": "break",
  "handwritten-field": "style",
  "long-title": "style",
  "open-question": "style",
  overdue: "style",
  "duplicate-text": "style",
  "repeated-value": "style",
  "manual-summary": "style",
  "duplicate-summary": "style",
};

/** 検査の結果の 1 件 */
export interface Issue extends Found {
  level: IssueLevel;
}

/** 規則が見つけたもの。種類（level）は、checkBoard が LEVEL から付ける */
interface Found {
  kind: IssueKind;
  /** 関わる要素の id。1 つめが、直す側の要素 */
  ids: string[];
  message: string;
  /** どれくらいか。重なりなら重なった幅と高さ、はみ出しなら出た長さ、文字なら大きさ */
  w?: number;
  h?: number;
  px?: number;
}

/** これより小さい重なりは、見積もりの誤差として数えない */
const TOLERANCE = 4;
/** セクションの端からこれより近い中身は、詰まっているとみなす */
const MIN_MARGIN = 10;
/** 図形の文字は、これより小さくなったら読みにくい。これ未満にはしない（画面の fitText と同じ下限） */
const SMALL_FONT = 11;
const MIN_FONT = 9;
const SHAPE_FONT = 15;
const LINE = 1.4;
/** 付箋の札の段（状態の札、tag、発言者を並べる 1 段）の高さ。どれか 1 つでもあれば、この高さを取る。画面の CSS（.shape .meta）と同じ値 */
const META_H = 21;
/**
 * 札の段の横の大きさ。文字の大きさ、状態の札と発言者の札の左右の余白の合計、札どうしの間、tag の字の間。
 * 画面の CSS（--board-text-tag、.shape .st と .who の padding、.shape .meta の gap、.shape .tag の letter-spacing）と同じ値
 */
const META_FONT = 10.5;
const META_PILL_PAD = 12;
const META_GAP = 4;
const META_TAG_SPACING = 0.04;
/** ガントの行の名前の文字の大きさと、欄の左右の余白の合計。画面の CSS（.gantt と .gname）と同じ値 */
const GANTT_FONT = 12;
const GANTT_NAME_PAD = 12;
/** ガントの行の札の文字の大きさと、札の余白と名前との間の合計（.gtag） */
const GANTT_TAG_FONT = 10;
const GANTT_TAG_PAD = 18;
/**
 * 蛍光ペンの帯と地の色の差（CIE76 の ΔE）が、これより小さければ見分けにくいとみなす。
 * WHY 26: 全部の組み合わせを画面に並べて見て、帯の境目がすぐには分からなかった組み合わせ（差 11〜25）と、
 * 見分けられた組み合わせ（26 以上）の間に引いた。
 * 地と同じ名前の色（黄の付箋に黄の蛍光ペン、など）は、差の数字にかかわらず知らせる。
 * WHY: 黄の上の黄は差が 35 あって帯の境目は見えるが、同じ色なので、目立たせたい所が目立たない。
 */
const MIN_HIGHLIGHT_DISTANCE = 26;
const MARK_NAME: Record<MarkColor, string> = { yellow: "黄", green: "緑", blue: "青", pink: "ピンク", orange: "オレンジ" };
const FILL_NAME: Record<Color, string> = { yellow: "黄", orange: "オレンジ", red: "赤", pink: "ピンク", purple: "紫", blue: "青", teal: "青緑", green: "緑", gray: "灰", white: "白", ink: "濃い色" };

/** 列で並べるセクションの 1 列が、これより狭ければ知らせる。付箋の既定の幅（220）の半分ほどで、1 行に全角 6 文字しか入らない */
const MIN_COL_W = 120;

/** 検査が、ボードの外のことを確かめる手段。渡さなければ、その検査はしない */
export interface CheckContext {
  /** ほかのボードへのリンクの行き先（相対パス）に、ファイルがあるか */
  boardExists?: (ref: string) => boolean;
  /** 今日の日付（YYYY-MM-DD）。期限切れ（overdue）を見るのに使う */
  today?: string;
  /** 書き方の提案（level: style）も返すか。渡さなければ、崩れだけ */
  style?: boolean;
}

/**
 * 札（tag）に手で書いた状態。札が状態の名前だけか、状態の名前の後ろに区切りが続くものを拾う（「決定」「決定 · 竹内さん」「決定（竹内）」）。
 * WHY 区切りを求める: 状態の名前で始まるだけの語（「決定事項の確認」「優先度 高」）は、状態ではない。
 */
const HANDWRITTEN_STATUS = new RegExp(`^\\s*(?:${Object.values(STATUS_LABEL).map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:$|[\\s·・:：/（(→])`);
/**
 * 手で書いた持ち越しの日付。区切り（「·」「・」「→」、開き括弧）の後ろの「M/D から」か、行の全体が「M/D から」のものを拾う。
 * 札と、本文の各行を見る。
 * WHY 区切りか行の全体を求める: 「4/1 から新体制で始める」「2/3 から 3/4 に上げる」のような、ふつうの文の日付や分数は持ち越しではない。
 */
const HANDWRITTEN_CARRIED = /(?:[·・→（(]\s*\d+\/\d+\s*から|^\s*\d+\/\d+\s*から\s*$)/m;

/**
 * 手で書いた期限。次の 2 つの形を、1 行の中で拾う（札と、本文の各行を、別々に見る）。
 * - 期限を表す語（期限、締切、締め切り、〆切、〆）のすぐ後ろの日付。間は、空白、「:」、「は」だけ
 * - 日付のすぐ後ろの「までに」「迄に」「締切」「締め切り」「〆切」「〆」「期限」。間は、空白だけ
 * 日付は「M/D」「M月D日」「YYYY-MM-DD」「YYYY/M/D」。後ろに曜日（「(金)」）が付いてもよい。
 * WHY 狭く拾う: 知らせに従うと、日付を due に書いて本文から消す。期限でない文を拾うと、文を言い換えるほかに知らせを消せない。見逃すほうを取る。
 * 日付だけ（「11/20 の定例」）、「まで」だけ（「1/2 まで減らす」「11/20 までの売上」）、「無期限」、行をまたぐ形は拾わない
 */
const DAY = "(?:\\d{4}-\\d{1,2}-\\d{1,2}|(?:\\d{4}/)?\\d{1,2}/\\d{1,2}|\\d{1,2}月\\d{1,2}日)(?:[ \\t　]*[（(][月火水木金土日][）)])?";
const HANDWRITTEN_DUE = new RegExp(`(?<!無)(?:期限|締切|締め切り|〆切|〆)[ \\t　:：は]*${DAY}|${DAY}[ \\t　]*(?:までに|迄に|締切|締め切り|〆切|〆|期限)`);

const round = (n: number): number => Math.round(n);

/** 要素の、文字の装飾が効く文字（付箋・図形・文字の本文と、表のセル） */
function richTexts(el: El): string[] {
  return [el.text ?? "", ...(el.head ?? []), ...(el.rows ?? []).flat()];
}

/** 要素に書かれた、ほかのボードへのリンクの行き先 */
function boardRefs(el: El): string[] {
  const inText = richTexts(el).flatMap((t) => parseRich(t).flatMap((b) => b.lines.flatMap((line) => line.flatMap((i) => (i.kind === "link" && isBoardRef(i.href) ? [i.href] : [])))));
  return [...new Set([...inText, ...(el.href !== undefined && isBoardRef(el.href) ? [el.href] : [])])];
}

function intersection(a: Box, b: Box): { w: number; h: number } | null {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** 線分が四角の中を通るか（Liang–Barsky）。四角は、誤差のぶんだけ内側に縮めて見る */
function segmentCrosses(a: Point, b: Point, box: Box): boolean {
  const x1 = box.x + TOLERANCE;
  const y1 = box.y + TOLERANCE;
  const x2 = box.x + box.w - TOLERANCE;
  const y2 = box.y + box.h - TOLERANCE;
  if (x2 <= x1 || y2 <= y1) return false;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a[0] - x1],
    [dx, x2 - a[0]],
    [-dy, a[1] - y1],
    [dy, y2 - a[1]],
  ]) {
    if (p === undefined || q === undefined) continue;
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * 図形の中の、文字が入る場所の大きさ。画面の CSS（board.css の .shape と .s-* の padding）に合わせてある。
 * 割合の padding は、CSS では幅を基準に決まる。
 */
function innerSize(kind: ShapeKind, w: number, h: number): { w: number; h: number } {
  switch (kind) {
    case "ellipse":
      return { w: w * 0.72, h: h - w * 0.24 };
    case "diamond":
      return { w: w * 0.6, h: h - w * 0.36 };
    case "hexagon":
    case "parallelogram":
      return { w: w * 0.64, h: h - 20 };
    case "cloud":
      return { w: w * 0.68, h: h - w * 0.34 };
    case "pill":
      return { w: w - 40, h: h - 20 };
    case "cylinder":
      return { w: w - 24, h: h - 38 };
    case "document":
      return { w: w - 24, h: h - 30 };
    case "queue":
      return { w: w - 42, h: h - 20 };
    default:
      return { w: w - 24, h: h - 20 };
  }
}

/**
 * 太字の文字の幅。付箋の見出しに使う。
 * WHY textWidth を使わない: textWidth は半角を一律 0.58em で見積もる。太字の半角はそれより広く、
 * 見積もりでは 1 行に入る見出し（「VALUE 案を外向けに掲げる」）が、画面では折り返した。
 * 測った値（2026-11-18、Chrome、Hiragino Sans の太字 15px、1 文字の px）:
 * 全角 15.0。大文字は W 16.2、M 15.1、そのほかは O と Q の 12.9 がいちばん広い（平均 11.7）。数字はどれも 11.1。
 * 小文字は平均 9.6（m は 15.8）。記号は % 14.5、@ 14.3、& 13.4。空白 5.0。
 * WHY 大文字と数字は、いちばん広い字の幅で見積もる: 平均で見積もると、M や W の並ぶ見出しが、検査に出ないまま画面で折り返す。
 * 多めに出るぶんには、見出しを短くすれば済む。
 * WHY 小文字は平均: 英単語の見出しはよくあり、いちばん広い字（m）で見積もると、入る見出しまで検査に出る。
 */
function boldWidth(s: string, px: number): number {
  let em = 0;
  for (const ch of s) em += (ch.codePointAt(0) ?? 0) > 0xff ? 1 : /[WM%@&]/.test(ch) ? 1.08 : /[A-Z]/.test(ch) ? 0.86 : /[0-9]/.test(ch) ? 0.75 : 0.64;
  return em * px;
}

/** 付箋の見出しが、何行になるか。見出しが無ければ 0 */
function titleLines(el: El): number {
  if (!el.title) return 0;
  const inner = innerSize(el.shape ?? "note", el.w ?? 0, el.h ?? 0);
  return Math.max(1, Math.ceil(boldWidth(el.title, NOTE_TITLE_FONT) / Math.max(NOTE_TITLE_FONT, inner.w)));
}

/**
 * 付箋の札の段（状態の札、tag、期限、発言者）を 1 段に並べたときの幅。札が無ければ 0。
 * 文字の幅は見積もり（boldWidth）で、半角は広めに数える。多めに出るぶんには、札を短くすれば済む
 */
function metaWidth(el: El): number {
  // 状態の札と発言者は札の形で、左右に余白がある。tag は字の間が空く。期限は文字だけ
  const extra = (p: MetaPart): number => (p.kind === "status" || p.kind === "who" ? META_PILL_PAD : p.kind === "tag" ? [...p.text].length * META_TAG_SPACING * META_FONT : 0);
  const parts = metaParts(el);
  return parts.reduce((sum, p) => sum + boldWidth(p.text, META_FONT) + extra(p), 0) + Math.max(0, parts.length - 1) * META_GAP;
}

/** 図形の文字が収まる、いちばん大きい文字の大きさ。いちばん小さくしても収まらなければ null */
function fittedFont(el: El): number | null {
  const inner = innerSize(el.shape ?? "note", el.w ?? 0, el.h ?? 0);
  // 本文が空なら、行は無い（見出しだけの付箋）
  const lines = el.text ? plainText(el.text).split("\n") : [];
  const heading = titleLines(el);
  const room = inner.h - (metaParts(el).length > 0 ? META_H : 0) - (heading > 0 ? heading * NOTE_TITLE_FONT * LINE + 2 : 0);
  for (let px = el.size ? FONT[el.size] : el.title ? NOTE_SUB_FONT : SHAPE_FONT; px >= MIN_FONT; px--) {
    const count = lines.reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l, px) / Math.max(px, inner.w))), 0);
    if (count * px * LINE <= room) return px;
  }
  return null;
}

// ---- 同じ中身の繰り返し ----

/** 似ているとみなす重なりの割合。短いほうの文の特徴のうち、これ以上が相手にもあれば似ている */
const SIMILAR = 0.6;
/**
 * 重なる特徴がこれより少ない組は、似ているとみなさない。
 * WHY 8: 実際の議事録のボードで試すと、社名（「メディステップ」は 2 文字ずつで 6 個）が 1 つ重なっただけの短い文が、
 * 題名と似ていると出た。固有名詞 1 つぶんより多く重なることを求める。
 */
const MIN_SHARED = 8;
/** 同じ日付や金額が、これ以上の数の要素に書かれていたら知らせる */
const REPEATED = 3;

const WORD = /[a-z0-9]+(?:[/.:\-][a-z0-9]+)*/g;
const SEPARATOR = /[\s、。，．・：；！？!?,.:;()（）「」『』［］[\]【】〜~…‥\-–—/]+/;

/**
 * 文を、比べるための特徴の集まりにする。英数字の続き（"accel-hack"、"12/1"）は 1 語、それ以外は 2 文字ずつ。
 * WHY 英数字を 1 語にする: 2 文字ずつに分けると、長い社名や製品名が 1 つ重なっただけで、似た文に見える。
 */
function featuresOf(text: string): Set<string> {
  const plain = plainText(text).normalize("NFKC").toLowerCase();
  const out = new Set<string>(plain.match(WORD) ?? []);
  for (const run of plain.replace(WORD, " ").split(SEPARATOR)) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

// 日付（12/1、2027/11、2027年11月、2027年度中）と、金額・割合。
// 単位の無い数（「2 要素認証」の 2）と、年の無い月や日だけ（「1月」「15日」）は拾わない。別の話でもよく出るため
const VALUE = /\d+(?:[/.]\d+)+|\d+(?:年度中|年度|年)(?:\d+月)?(?:\d+日)?|\d+(?:万円|円|%)/g;

function valuesOf(text: string): Set<string> {
  // 数と単位の間の空白は、書き方の揺れなので詰める（"2027 年度中" と "2027年度中" を同じに数える）
  const plain = plainText(text).normalize("NFKC").replace(/(\d)\s+(?=[年月日万円%])/g, "$1").replace(/([年月])\s+(?=\d)/g, "$1");
  return new Set(plain.match(VALUE) ?? []);
}

function checkRepeats(doc: Doc): Found[] {
  const issues: Found[] = [];
  const texts = doc.elements.flatMap((el) => ((el.type === "shape" || el.type === "text") && el.text ? [{ id: el.id, text: el.text, features: featuresOf(el.text) }] : []));

  // 似た文。重なりの割合は、短いほうの文の特徴のうち、相手にもあるものの割合
  // （短い付箋の中身が、長い付箋にそのまま含まれている場合も拾うため）
  const similarity = (a: Set<string>, b: Set<string>): number => {
    let shared = 0;
    for (const f of a) if (b.has(f)) shared += 1;
    return shared < MIN_SHARED ? 0 : shared / Math.min(a.size, b.size);
  };
  // まとまりは、全員が互いに似ているものだけで作る。
  // WHY: 「A と B が似ている、B と C が似ている」でつないでいくと、似ていない A と C まで 1 つのまとまりになる
  const done = new Set<string>();
  for (const [i, a] of texts.entries()) {
    if (done.has(a.id)) continue;
    const group = [a];
    let weakest = 1;
    for (const b of texts.slice(i + 1)) {
      if (done.has(b.id)) continue;
      const ratios = group.map((m) => similarity(m.features, b.features));
      if (ratios.some((r) => r < SIMILAR)) continue;
      group.push(b);
      weakest = Math.min(weakest, ...ratios);
    }
    if (group.length < 2) continue;
    for (const m of group) done.add(m.id);
    const ids = group.map((m) => m.id);
    const percent = round(weakest * 100);
    issues.push({ kind: "duplicate-text", ids, message: `${ids.join("・")} が似た中身（重なり ${percent}% 以上）。1 つにまとめるか、書き分ける`, px: percent });
  }

  // 同じ日付や金額
  const holders = new Map<string, string[]>();
  for (const t of texts) for (const v of valuesOf(t.text)) holders.set(v, [...(holders.get(v) ?? []), t.id]);
  for (const [value, ids] of holders) {
    if (ids.length >= REPEATED) issues.push({ kind: "repeated-value", ids, message: `「${value}」が ${ids.length} つの要素に書かれている（${ids.join("・")}）。同じ事実なら 1 か所にまとめる`, px: ids.length });
  }
  return issues;
}

/**
 * 付箋と図形の who か tag のうち、want と、大文字と小文字、全角と半角、空白だけが違う値（前後の空白を除いて同じ値は除く）。
 * WHY 見分けをこの範囲にとどめる: 似た語（「リスク」と「リスク管理」）まで拾うと、別の分類を綴りの違いと言うことになる
 */
function similarValues(els: readonly El[], key: "who" | "tag", want: string): string[] {
  const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const out = new Set<string>();
  for (const el of els) {
    const v = el.type === "shape" ? el[key] : undefined;
    if (v !== undefined && v.trim() !== want.trim() && fold(v) === fold(want)) out.add(v);
  }
  return [...out];
}

/** まとめの帯の使い方の検査 */
function summaryIssues(doc: Doc): Found[] {
  const issues: Found[] = [];
  // 同じ条件で集める帯が 2 つ以上。状態の名前で書いた show と、{ status } だけの組は、同じ条件
  const byShow = new Map<string, { title: string; ids: string[] }>();
  for (const el of doc.elements) {
    const filter = filterOf(el);
    if (!filter) continue;
    const key = filterKey(filter);
    byShow.set(key, { title: filterTitle(filter), ids: [...(byShow.get(key)?.ids ?? []), el.id] });
  }
  for (const { title, ids } of byShow.values()) {
    if (ids.length >= 2) issues.push({ kind: "duplicate-summary", ids, message: `条件が「${title}」のまとめの帯が ${ids.length} つある（${ids.join("・")}）。同じ一覧が並ぶので、1 つを残して消す` });
  }
  // 発言者か tag で集める帯に、当たる付箋が 1 枚も無い。綴りの違いに、帯を置いた時点で気づけるように、似た値を案内に入れる。
  // WHY 状態だけで集める帯は見ない: 会議の始めは、決定も宿題も 0 件が普通
  const rows = collect(doc.elements);
  for (const el of doc.elements) {
    const filter = filterOf(el);
    if (!filter || (filter.who === undefined && filter.tag === undefined) || rowsFor(rows, filter).length > 0) continue;
    const hints = (["who", "tag"] as const).flatMap((k) => {
      const want = filter[k];
      if (want === undefined) return [];
      const near = similarValues(doc.elements, k, want);
      return near.length > 0 ? [`似た ${k}: ${near.map((v) => `「${v}」`).join("・")}`] : [];
    });
    issues.push({
      kind: "empty-summary",
      ids: [el.id],
      message: `まとめの帯 ${el.id} の条件（${filterTitle(filter)}）に当たる付箋が 1 枚も無い。${hints.length > 0 ? `${hints.join("。")}。付箋の値を条件にそろえるか、帯の show を直す` : "付箋の who か tag を、条件と同じ文字で書く"}`,
    });
  }
  for (const c of doc.elements) {
    if (c.type !== "container") continue;
    const members = membersOf(doc.elements, c);
    // 帯は、セクションの外に置く。帯はセクションの中身にならない（model.ts の insideOf）ので、中身でなく、帯の中心が枠の中にあるかで見る。
    // 帯が枠の辺にかかるだけなら、on-section-edge が知らせる
    const cb = boxOf(c);
    for (const band of doc.elements) {
      const bb = band.type === "summary" ? boxOf(band) : null;
      const cx = bb ? bb.x + bb.w / 2 : 0;
      const cy = bb ? bb.y + bb.h / 2 : 0;
      if (!cb || !bb || cx < cb.x || cx > cb.x + cb.w || cy < cb.y || cy > cb.y + cb.h) continue;
      issues.push({ kind: "summary-in-section", ids: [band.id, c.id], message: `まとめの帯 ${band.id} が、セクション ${c.id} の中にある。帯はセクションの中身にならず、セクションと一緒に動かない。帯をセクションの外に置く（帯の x・y か、セクションの x・y を set で書く）` });
    }
    // 手で写したまとめ。固定したセクションに、同じ状態の付箋が 2 枚以上並ぶ形だけを拾う
    // WHY 狭く拾う: 固定したセクションは、まとめのほかにも使う（凡例、注意書き）。状態のそろった付箋が並ぶのは、まとめだけ
    if (c.locked !== true) continue;
    const noted = members.flatMap((m) => {
      const status = m.type === "shape" ? statusBadge(m)?.status : undefined;
      return status === undefined ? [] : [{ id: m.id, status }];
    });
    const status = noted[0]?.status;
    if (noted.length < 2 || status === undefined || noted.some((n) => n.status !== status)) continue;
    issues.push({
      kind: "manual-summary",
      ids: [c.id],
      message: `固定したセクション ${c.id} の中に、状態が ${status} の付箋が並んでいる（${noted.map((n) => n.id).join("・")}）。手で写したまとめは、元の付箋を直しても変わらない。セクションと中の付箋を消して、まとめの帯（{"type":"summary","show":"${status}","x":${c.x ?? 0},"y":${c.y ?? 0}}）に替える。中の付箋が写しでなく元の付箋なら、消さずに議題のセクションへ移す`,
    });
  }
  return issues;
}

/** 検査の文に書く、セクションの呼び方。透明な枠は、画面に名前が出ないので、そう書く */
function sectionName(c: El): string {
  return c.frame === "none" ? `透明な枠 ${c.id} ` : `セクション ${c.id} `;
}

/**
 * ボードの検査。崩れ（level: break）を返す。ctx.style を付けると、書き方の提案（level: style）も一緒に返す
 */
export function checkBoard(doc: Doc, ctx: CheckContext = {}): Issue[] {
  return findIssues(doc, ctx).flatMap((found) => {
    const level = LEVEL[found.kind];
    return level === "break" || ctx.style === true ? [{ ...found, level }] : [];
  });
}

function findIssues(doc: Doc, ctx: CheckContext): Found[] {
  const issues: Found[] = [];
  issues.push(...summaryIssues(doc));
  // リンクの形で書いていない URL。画面ではただの文字で出て、押せない
  for (const el of doc.elements) {
    const found = richTexts(el).flatMap(bareUrls);
    // 装飾の中の URL は、直し方が違うので、知らせを分ける
    for (const decorated of [false, true]) {
      const urls = new Map(found.filter((u) => u.decorated === decorated).map((u) => [u.url, u.href]));
      if (urls.size === 0) continue;
      const why = decorated ? "装飾（太字・斜体・取り消し線・蛍光ペン）の中にあり、リンクにならない。装飾は重ねられないので、装飾を外して、リンクの形だけで書く" : "ただの文字で出て押せない。リンクの形で書く";
      const linked = [...urls.values()].map((href) => `[表示](${href})`);
      issues.push({ kind: "bare-url", ids: [el.id], message: `${el.id} の URL（${[...urls.keys()].join("、")}）は、${why}: ${linked.join("、")}（「表示」は、行き先が分かる短い名前に替える）` });
    }
  }
  // リンクの行き先。人が押すまで気づけないので、ここで知らせる
  if (ctx.boardExists) {
    for (const el of doc.elements) {
      for (const ref of boardRefs(el)) {
        if (!ctx.boardExists(ref)) issues.push({ kind: "dead-link", ids: [el.id], message: `${el.id} のリンクの行き先のボードが無い: ${ref}。パスを直すか、xwb open でボードを作る` });
      }
    }
  }
  // コメントが指す要素。指す先を消しても、コメントは残る
  const ids = new Set(doc.elements.map((e) => e.id));
  for (const el of doc.elements) {
    if (el.type === "comment" && el.on !== undefined && !el.resolved && !ids.has(el.on)) {
      issues.push({ kind: "dead-comment-target", ids: [el.id], message: `コメント ${el.id} が指す要素 ${el.on} がボードに無い。指す先を直す（set で on）か、話が済んでいれば解決にする` });
    }
  }
  // 論点を書いたセクションの結論。会議の終わりに、結論の出ていない論点を拾えるようにする
  for (const el of doc.elements) {
    if (el.type === "container" && el.frame === "none" && ridersOf(doc.elements, el).length === 0) issues.push({ kind: "empty-frame", ids: [el.id], message: `透明な枠 ${el.id} の中に何も無い。見えないまま場所を取り、format で 1 つのまとまりとして動く。囲む図を中へ入れるか、枠を消す` });
    if (el.type === "container" && el.question && !el.answer) issues.push({ kind: "open-question", ids: [el.id], message: `セクション ${el.id} の論点「${el.question}」に結論（answer）が無い。決まったら書く。持ち越すなら、その旨を answer に書く` });
  }
  // 列で並べるセクションの、列の幅
  for (const el of doc.elements) {
    const box = el.type === "container" && el.cols !== undefined ? boxOf(el) : null;
    if (!box || el.cols === undefined) continue;
    const w = colWidth(box, el.cols);
    if (w < MIN_COL_W) issues.push({ kind: "narrow-column", ids: [el.id], message: `セクション ${el.id} の 1 列の幅が ${w} しかない（cols ${el.cols}）。cols を減らすか、セクションの w を増やす`, px: w });
  }
  // 列で並べるセクションの中の、別のセクション。
  // 列で並べるセクションは、中のセクションを枠として扱わない（中のセクションの中身も、外側の列に並ぶ）ので、入れ子が崩れる
  for (const outer of doc.elements) {
    const box = outer.type === "container" && outer.cols !== undefined ? boxOf(outer) : null;
    if (!box) continue;
    for (const inner of doc.elements) {
      const b = inner.type === "container" && inner.id !== outer.id ? boxOf(inner) : null;
      if (!b) continue;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (cx < box.x || cx > box.x + box.w || cy < box.y || cy > box.y + box.h) continue;
      issues.push({ kind: "nested-section", ids: [inner.id, outer.id], message: `セクション ${inner.id} が、列で並べるセクション ${outer.id} の中にある。列で並べるセクションは、中のセクションを扱わない。${inner.id} を外へ出すか、${outer.id} の cols を消して座標で置く` });
    }
  }
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const boxed = (list: El[]): { el: El; box: Box }[] =>
    list.flatMap((el) => {
      const box = boxOf(el);
      return box ? [{ el, box }] : [];
    });
  // WHY まとめの帯をここで足す: 帯も場所をふさぐが、isSolid には入れない。isSolid は、列で並べるセクションの中身と、自動で置くときによける相手も決める。
  // 帯を入れると、列のセクションの枠に入った帯が、中身として並べられて幅を書き換えられる
  const solids = boxed(doc.elements.filter((el) => isSolid(el) || el.type === "summary"));
  const sections = boxed(doc.elements.filter((e) => e.type === "container"));

  // 中身どうしの重なり
  for (const [i, a] of solids.entries()) {
    for (const b of solids.slice(i + 1)) {
      const hit = intersection(a.box, b.box);
      if (!hit || hit.w <= TOLERANCE || hit.h <= TOLERANCE) continue;
      issues.push({ kind: "overlap", ids: [a.el.id, b.el.id], message: `${a.el.id} と ${b.el.id} が重なっている（幅 ${round(hit.w)}・高さ ${round(hit.h)}）`, w: round(hit.w), h: round(hit.h) });
    }
  }

  // セクションとの関係
  for (const s of sections) {
    for (const m of solids) {
      const hit = intersection(s.box, m.box);
      if (!hit) continue;
      const left = m.box.x - s.box.x;
      const top = m.box.y - s.box.y;
      const right = s.box.x + s.box.w - (m.box.x + m.box.w);
      const bottom = s.box.y + s.box.h - (m.box.y + m.box.h);
      const out = Math.max(-left, -top, -right, -bottom);
      const cx = m.box.x + m.box.w / 2;
      const cy = m.box.y + m.box.h / 2;
      const member = cx >= s.box.x && cx <= s.box.x + s.box.w && cy >= s.box.y && cy <= s.box.y + s.box.h;
      // 中心が枠の中にある帯は、中身でない（model.ts の insideOf）ので、はみ出しや余白は見ない。summary-in-section が知らせる
      if (member && m.el.type === "summary") continue;
      if (out > TOLERANCE) {
        if (member) issues.push({ kind: "outside-section", ids: [m.el.id, s.el.id], message: `${m.el.id} が${sectionName(s.el)}から ${round(out)} はみ出している`, px: round(out) });
        else issues.push({ kind: "on-section-edge", ids: [m.el.id, s.el.id], message: `${m.el.id} が${sectionName(s.el)}の枠に ${round(Math.min(hit.w, hit.h))} かかっている${s.el.frame === "none" ? "。透明な枠は見えないので、画面では気づけない。枠の外へ出すか、枠を広げる" : ""}`, px: round(Math.min(hit.w, hit.h)) });
        continue;
      }
      // 題名の帯（上 TITLE_H）にかかるか、左右と下の余白が足りない
      const head = sectionTop(s.el);
      if (top < head - TOLERANCE - MIN_MARGIN) {
        const what = s.el.frame === "none" ? "上の端" : `題名${head > TITLE_H ? "か論点・結論" : ""}`;
        issues.push({ kind: "cramped", ids: [m.el.id, s.el.id], message: `${m.el.id} が${sectionName(s.el)}の${what}に近い（上から ${round(top)}。${head} 空ける）`, px: round(top) });
      } else if (Math.min(left, right, bottom) < MIN_MARGIN) {
        const margin = Math.min(left, right, bottom);
        issues.push({ kind: "cramped", ids: [m.el.id, s.el.id], message: `${m.el.id} が${sectionName(s.el)}の端に詰まっている（余白 ${round(margin)}。${PAD} 空ける）`, px: round(margin) });
      }
    }
  }

  // 矢印
  const arrows = doc.elements.flatMap((el) => {
    if (el.type !== "arrow") return [];
    const points = arrowPath(el, boxOf, (id) => byId.get(id), () => solids.map((s) => s.el));
    return points ? [{ el, points }] : [];
  });
  const segments = (points: Point[]): [Point, Point][] => points.slice(1).flatMap((b, i): [Point, Point][] => (points[i] ? [[points[i], b]] : []));
  for (const a of arrows) {
    for (const s of solids) {
      if (s.el.id === a.el.from || s.el.id === a.el.to) continue;
      if (segments(a.points).some(([p, q]) => segmentCrosses(p, q, s.box))) {
        issues.push({ kind: "arrow-through", ids: [a.el.id, s.el.id], message: `矢印 ${a.el.id} が ${s.el.id} を突き抜けている` });
      }
    }
    const spot = a.el.label ? labelSpot(a.points) : null;
    if (!spot || !a.el.label) continue;
    const lw = textWidth(a.el.label, LABEL_FONT) + 8;
    const label: Box = { x: spot.x - lw / 2, y: spot.y - (spot.flat ? LABEL_LIFT : 0) - 8, w: lw, h: 16 };
    for (const s of solids) {
      const hit = intersection(label, s.box);
      if (!hit || hit.w <= TOLERANCE || hit.h <= TOLERANCE) continue;
      issues.push({ kind: "label-overlap", ids: [a.el.id, s.el.id], message: `矢印 ${a.el.id} のラベル「${a.el.label}」が ${s.el.id} にかかっている（幅 ${round(hit.w)}）`, w: round(hit.w), h: round(hit.h) });
    }
    for (const other of arrows) {
      if (other.el.id === a.el.id) continue;
      if (segments(other.points).some(([p, q]) => segmentCrosses(p, q, label))) {
        issues.push({ kind: "label-overlap", ids: [a.el.id, other.el.id], message: `矢印 ${a.el.id} のラベル「${a.el.label}」に、矢印 ${other.el.id} がかかっている` });
      }
    }
  }

  // 図形の文字の大きさ
  for (const el of doc.elements) {
    if (el.type !== "shape") continue;
    // 付箋の欄。手で書いた見出し・状態・持ち越しの日付は、欄に書けば、見た目がそろい、検査と一覧で読める
    if (!el.title && /^\*\*[^*\n]+\*\*\n/.test(el.text ?? "")) issues.push({ kind: "handwritten-field", ids: [el.id], message: `${el.id} の 1 行めの太字は、見出しとして title に書く（本文は text に残す）` });
    // WHY due があっても見る: 本文に期限が残っていると、期限を消した（終わった）ときに、もう一度「due に書く」と知らせることになる
    const handDue = [el.tag ?? "", ...plainText(el.text ?? "").split("\n")].flatMap((line) => HANDWRITTEN_DUE.exec(line)?.[0] ?? [])[0];
    if (handDue !== undefined) {
      const fix = el.due === undefined ? "due に YYYY-MM-DD で書く（札の段に「〆11/20」の形で出る）。本文や札の期限は消す" : "due に書いてあるので、本文や札から消す（札の段と二重に出る）";
      issues.push({ kind: "handwritten-field", ids: [el.id], message: `${el.id} の期限（「${handDue}」）は、${fix}` });
    }
    if (ctx.today !== undefined && isOverdue(el, ctx.today)) {
      issues.push({ kind: "overdue", ids: [el.id], message: `${el.id} の期限（${el.due}）を過ぎている。終わったなら due を消す（null）か、付箋を消す。延ばすなら due を直す` });
    }
    // WHY 決定と優先の付箋は見ない: carriedFrom と一緒に書けない状態なので、案内どおりに直すと断られる
    if (el.carriedFrom === undefined && (el.status === undefined || CARRIABLE.includes(el.status)) && HANDWRITTEN_CARRIED.test(`${el.tag ?? ""}\n${plainText(el.text ?? "")}`)) issues.push({ kind: "handwritten-field", ids: [el.id], message: `${el.id} の持ち越しの日付（「11/11 から」）は、carriedFrom に YYYY-MM-DD で書く` });
    if (el.status === undefined && HANDWRITTEN_STATUS.test(el.tag ?? "")) issues.push({ kind: "handwritten-field", ids: [el.id], message: `${el.id} の札（tag）の状態は、status に書く（${NOTE_STATUS.join("・")}）。発言者は who に書く` });
    const metaOver = round(metaWidth(el) - innerSize(el.shape ?? "note", el.w ?? 0, el.h ?? 0).w);
    if (metaOver > 0) issues.push({ kind: "meta-overflow", ids: [el.id], message: `${el.id} の札の段（状態の札、tag、期限、who）が 1 段に入りきらず、tag か who が切れる（${metaOver} はみ出す）。状態の札と期限は縮まない。tag を短くするか省く、who を短くする、w を増やす`, w: metaOver });
    if (titleLines(el) > 1) issues.push({ kind: "long-title", ids: [el.id], message: `${el.id} の見出し（title）が 1 行に入らない。短くして、残りは text に書く`, px: titleLines(el) });
    if (!el.text && !el.title) continue;
    const px = fittedFont(el);
    if (px === null) issues.push({ kind: "text-overflow", ids: [el.id], message: `${el.id} の文字が、いちばん小さくしても収まらない。箱を大きくするか、文字を減らす` });
    else if (px < SMALL_FONT) issues.push({ kind: "small-text", ids: [el.id], message: `${el.id} の文字が ${px}px まで小さくなる。箱を大きくするか、文字を減らす`, px });
  }

  // 蛍光ペンの色と、地の色の近さ。色は直さず、知らせるだけにする（書いた色と出る色が違うと、間違いに気づけない）
  const weak = (id: string, text: string, ground: string, groundName: string, groundColor: Color | null): void => {
    const used = new Set(parseRich(text).flatMap((b) => b.lines.flatMap((line) => line.flatMap((i) => (i.kind === "mark" ? [i.color] : [])))));
    for (const color of used) {
      const d = colorDistance(ground, HIGHLIGHT[color]);
      const same = groundColor === color;
      if (!same && d >= MIN_HIGHLIGHT_DISTANCE) continue;
      issues.push({
        kind: "highlight-contrast",
        ids: [id],
        message: `${id}: ${groundName}の地の上の${MARK_NAME[color]}の蛍光ペンは、${same ? "地と同じ色で目立たない" : "地の色に近くて見分けにくい"}（色の差 ${round(d)}）。別の色にする`,
        px: round(d),
      });
    }
  };
  for (const el of doc.elements) {
    if (el.type === "text" && el.text) weak(el.id, el.text, PAPER, "ボード", null);
    if (el.type === "table") {
      if (el.head) weak(el.id, el.head.join("\n"), TABLE_HEAD, "表の見出し", null);
      weak(el.id, (el.rows ?? []).flat().join("\n"), TABLE_CELL, "表", null);
    }
    if (el.type !== "shape" || !el.text) continue;
    const color = el.color ?? ((el.shape ?? "note") === "note" ? "yellow" : "white");
    // 中を塗らない箱（hollow）は、ボードの地の上に帯が出る
    weak(el.id, el.text, el.hollow ? PAPER : FILL[color], el.hollow ? "ボード" : FILL_NAME[color], el.hollow ? null : color);
  }

  // ガントの中の文字。印の名前どうしの重なりは、配置が段をずらして避けるので、ここには出ない
  for (const el of doc.elements) {
    if (el.type !== "gantt") continue;
    const layout = ganttLayout(el);
    for (const b of el.bars ?? []) {
      // 札（tag）があると、そのぶん名前の入る幅が狭くなる
      const room = layout.labelW - GANTT_NAME_PAD - (b.tag ? textWidth(b.tag, GANTT_TAG_FONT) + GANTT_TAG_PAD : 0);
      const over = textWidth(b.name, GANTT_FONT) - room;
      if (over > 0) issues.push({ kind: "gantt-text", ids: [el.id], message: `${el.id} の行の名前「${b.name}」が欄に入りきらず切れている（${round(over)} 超過）。名前を短くするか、名前の欄の幅（labelW。いま ${layout.labelW}）を増やす`, px: round(over) });
    }
    for (const m of layout.markSpots) {
      const out = Math.max(-m.from, m.to - layout.w);
      if (out > 0) issues.push({ kind: "gantt-text", ids: [el.id], message: `${el.id} の印の名前「${m.name}」が枠から ${round(out)} はみ出している。名前を短くするか、幅（w）を増やす`, px: round(out) });
    }
  }
  issues.push(...checkRepeats(doc));
  return issues;
}
