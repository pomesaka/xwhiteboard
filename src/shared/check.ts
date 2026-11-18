// ボードの見た目の問題を、描かずに測る。エージェントが、スクショを見なくても崩れに気づけるようにする。
// 文字と表の大きさは見積もり（model.ts の sizeOf）なので、画面で測った値とは数 px ずれる。
import { sectionTop, FONT, NOTE_SUB_FONT, NOTE_TITLE_FONT, PAD, TITLE_H, statusBadge, boxOf, colWidth, isSolid, textWidth, type Box, type Doc, type El, type Point, type ShapeKind } from "./model.ts";
import { FILL, HIGHLIGHT, PAPER, TABLE_CELL, TABLE_HEAD, colorDistance } from "./colors.ts";
import { ganttLayout } from "./gantt.ts";
import type { Color } from "./model.ts";
import { isBoardRef, parseRich, plainText, type MarkColor } from "./rich.ts";
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
  /** 列で並べるセクション（cols）の 1 列が狭くて、付箋の文字が入りにくい */
  | "narrow-column"
  /** 付箋の欄（title・status・carriedFrom）に書けることを、本文や札（tag）に手で書いている */
  | "handwritten-field"
  /** 付箋の見出し（title）が 1 行に入らない */
  | "long-title"
  /** セクションに論点（question）があって、結論（answer）が無い */
  | "open-question";

export interface Issue {
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
const TAG_H = 18;
/** 付箋の、状態と発言者の札の段の高さ。画面の CSS（.shape .meta）と同じ値 */
const META_H = 21;
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
}

const round = (n: number): number => Math.round(n);

/** 要素に書かれた、ほかのボードへのリンクの行き先 */
function boardRefs(el: El): string[] {
  const texts = [el.text ?? "", ...(el.head ?? []), ...(el.rows ?? []).flat()];
  const inText = texts.flatMap((t) => parseRich(t).flatMap((b) => b.lines.flatMap((line) => line.flatMap((i) => (i.kind === "link" && isBoardRef(i.href) ? [i.href] : [])))));
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

/** 図形の文字が収まる、いちばん大きい文字の大きさ。いちばん小さくしても収まらなければ null */
/** 付箋の見出しが、何行になるか。見出しが無ければ 0 */
function titleLines(el: El): number {
  if (!el.title) return 0;
  const inner = innerSize(el.shape ?? "note", el.w ?? 0, el.h ?? 0);
  return Math.max(1, Math.ceil(textWidth(el.title, NOTE_TITLE_FONT) / Math.max(NOTE_TITLE_FONT, inner.w)));
}

function fittedFont(el: El): number | null {
  const inner = innerSize(el.shape ?? "note", el.w ?? 0, el.h ?? 0);
  // 本文が空なら、行は無い（見出しだけの付箋）
  const lines = el.text ? plainText(el.text).split("\n") : [];
  const heading = titleLines(el);
  const room = inner.h - (el.tag ? TAG_H : 0) - (statusBadge(el) || el.who ? META_H : 0) - (heading > 0 ? heading * NOTE_TITLE_FONT * LINE + 2 : 0);
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

function checkRepeats(doc: Doc): Issue[] {
  const issues: Issue[] = [];
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

export function checkBoard(doc: Doc, ctx: CheckContext = {}): Issue[] {
  const issues: Issue[] = [];
  // リンクの行き先。人が押すまで気づけないので、ここで知らせる
  if (ctx.boardExists) {
    for (const el of doc.elements) {
      for (const ref of boardRefs(el)) {
        if (!ctx.boardExists(ref)) issues.push({ kind: "dead-link", ids: [el.id], message: `${el.id} のリンクの行き先のボードが無い: ${ref}。パスを直すか、xwb open でボードを作る` });
      }
    }
  }
  // 論点を書いたセクションの結論。会議の終わりに、結論の出ていない論点を拾えるようにする
  for (const el of doc.elements) {
    if (el.type === "container" && el.question && !el.answer) issues.push({ kind: "open-question", ids: [el.id], message: `セクション ${el.id} の論点「${el.question}」に結論（answer）が無い。決まったら書く。持ち越すなら、その旨を answer に書く` });
  }
  // 列で並べるセクションの、列の幅
  for (const el of doc.elements) {
    const box = el.type === "container" && el.cols !== undefined ? boxOf(el) : null;
    if (!box || el.cols === undefined) continue;
    const w = colWidth(box, el.cols);
    if (w < MIN_COL_W) issues.push({ kind: "narrow-column", ids: [el.id], message: `セクション ${el.id} の 1 列の幅が ${w} しかない（cols ${el.cols}）。cols を減らすか、セクションの w を増やす`, px: w });
  }
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const boxed = (list: El[]): { el: El; box: Box }[] =>
    list.flatMap((el) => {
      const box = boxOf(el);
      return box ? [{ el, box }] : [];
    });
  const solids = boxed(doc.elements.filter(isSolid));
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
      if (out > TOLERANCE) {
        const cx = m.box.x + m.box.w / 2;
        const cy = m.box.y + m.box.h / 2;
        const member = cx >= s.box.x && cx <= s.box.x + s.box.w && cy >= s.box.y && cy <= s.box.y + s.box.h;
        if (member) issues.push({ kind: "outside-section", ids: [m.el.id, s.el.id], message: `${m.el.id} がセクション ${s.el.id} から ${round(out)} はみ出している`, px: round(out) });
        else issues.push({ kind: "on-section-edge", ids: [m.el.id, s.el.id], message: `${m.el.id} がセクション ${s.el.id} の枠に ${round(Math.min(hit.w, hit.h))} かかっている`, px: round(Math.min(hit.w, hit.h)) });
        continue;
      }
      // 題名の帯（上 TITLE_H）にかかるか、左右と下の余白が足りない
      const head = sectionTop(s.el);
      if (top < head - TOLERANCE - MIN_MARGIN) {
        issues.push({ kind: "cramped", ids: [m.el.id, s.el.id], message: `${m.el.id} がセクション ${s.el.id} の題名${head > TITLE_H ? "か論点・結論" : ""}に近い（上から ${round(top)}。${head} 空ける）`, px: round(top) });
      } else if (Math.min(left, right, bottom) < MIN_MARGIN) {
        const margin = Math.min(left, right, bottom);
        issues.push({ kind: "cramped", ids: [m.el.id, s.el.id], message: `${m.el.id} がセクション ${s.el.id} の端に詰まっている（余白 ${round(margin)}。${PAD} 空ける）`, px: round(margin) });
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
    if (el.carriedFrom === undefined && /\d+\/\d+\s*から/.test(`${el.tag ?? ""}\n${plainText(el.text ?? "")}`)) issues.push({ kind: "handwritten-field", ids: [el.id], message: `${el.id} の持ち越しの日付（「11/11 から」）は、carriedFrom に YYYY-MM-DD で書く` });
    if (el.status === undefined && /^(決定|未決|持ち越し|優先)/.test(el.tag ?? "")) issues.push({ kind: "handwritten-field", ids: [el.id], message: `${el.id} の札（tag）の状態は、status に書く（decided・open・carried・priority）。発言者は who に書く` });
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
