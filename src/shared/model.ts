// ボードのデータの形と、操作（add・set・rm・say・order・format・title・template）の適用。
// サーバー、CLI、ブラウザ、変換が同じ規則で要素を検証できるよう、ここだけに置く。
import { GANTT_STATUS, GANTT_UNITS, ganttLayout, parseDay, type GanttBar, type GanttMark, type GanttSegment, type GanttUnit } from "./gantt.ts";
import { isBoardRef, plainText } from "./rich.ts";
import { formatOp } from "./format.ts";
import { collect, itemsOf, rowsFor } from "./summary.ts";
import { expandTemplate } from "./template.ts";
import { SIDES, type Side } from "./route.ts";

export const TYPES = ["shape", "container", "text", "arrow", "table", "image", "stroke", "comment", "gantt", "summary"] as const;
export const SPEAKERS = ["human", "claude"] as const;
export const COLORS = ["yellow", "orange", "red", "pink", "purple", "blue", "teal", "green", "gray", "white", "ink"] as const;
export const SHAPES = ["note", "rect", "round", "pill", "ellipse", "diamond", "hexagon", "parallelogram", "cylinder", "document", "queue", "cloud"] as const;
export const SIZES = ["s", "m", "l", "xl", "huge"] as const;
export const ALIGNS = ["left", "center", "right"] as const;
export const HEADS = ["end", "start", "both", "none"] as const;
export const ROUTES = ["straight", "elbow"] as const;
/** 付箋の状態。決定、未決、持ち越し、優先 */
export const NOTE_STATUS = ["decided", "open", "todo", "carried", "priority"] as const;
export type NoteStatus = (typeof NOTE_STATUS)[number];
/** 持ち越しの日付（carriedFrom）と一緒に書ける状態。決定と優先は、持ち越しにならない */
export const CARRIABLE: readonly NoteStatus[] = ["carried", "todo", "open"];
/** まとめの帯の条件。書いた項目の全部に当てはまる付箋を集める。who と tag は、前後の空白を除いて、付箋の値と完全に一致するもの */
export interface SummaryFilter {
  status?: NoteStatus;
  who?: string;
  tag?: string;
}
const FILTER_KEYS = ["status", "who", "tag"] as const;

/**
 * まとめの帯の show を読む。状態の名前（"decided"）は { status: "decided" } と同じ。
 * 項目が 1 つも無い、知らない項目、空の文字列は、理由を付けて断る
 */
export function parseShow(v: unknown): Res<SummaryFilter> {
  if (isOneOf(NOTE_STATUS, v)) return ok({ status: v });
  if (!isRecord(v)) return fail(`show は、状態の名前（${NOTE_STATUS.join(" | ")}）か、{ status・who・tag } の組`);
  const keys = Object.keys(v);
  const unknown = keys.find((k) => !FILTER_KEYS.some((f) => f === k));
  if (unknown !== undefined) return fail(`show に ${unknown} は書けない。書けるのは status・who・tag`);
  if (keys.length === 0) return fail("show の組に、status・who・tag のどれも書いていない。1 つ以上書く");
  const out: SummaryFilter = {};
  if (v.status !== undefined) {
    if (!isOneOf(NOTE_STATUS, v.status)) return fail(`show の status は ${NOTE_STATUS.join(" | ")} のどれか`);
    out.status = v.status;
  }
  for (const k of ["who", "tag"] as const) {
    if (v[k] === undefined) continue;
    const s = v[k];
    if (typeof s !== "string" || s.trim() === "") return fail(`show の ${k} は、空でない文字列`);
    out[k] = s;
  }
  return ok(out);
}
export const STATUS_LABEL: Record<NoteStatus, string> = { decided: "決定", open: "未決", todo: "宿題", carried: "持ち越し", priority: "優先" };
/** 矢印の端の形。矢じり、丸、無し */
export const END_MARKS = ["arrow", "dot", "none"] as const;
export type EndMark = (typeof END_MARKS)[number];

export type ElType = (typeof TYPES)[number];
export type Color = (typeof COLORS)[number];
export type ShapeKind = (typeof SHAPES)[number];
export type Size = (typeof SIZES)[number];
export type Heads = (typeof HEADS)[number];
export type Point = [number, number];
/** 矢印の端。要素の id か、どの要素にも付かない座標 */
export type End = string | Point;

/** コメントのやりとりの 1 件 */
export interface Message {
  by: (typeof SPEAKERS)[number];
  at: string;
  text: string;
}

export interface El {
  id: string;
  type: ElType;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: Color;
  text?: string;
  tag?: string;
  size?: Size;
  /** 文字の寄せ。書かなければ、文字（text）と付箋は左、ほかの図形は中央 */
  align?: (typeof ALIGNS)[number];
  shape?: ShapeKind;
  title?: string;
  from?: End;
  to?: End;
  label?: string;
  dashed?: boolean;
  heads?: Heads;
  /** 図形の枠線の色。書かなければ color に合う色 */
  border?: Color;
  /** 図形の中を塗らない */
  hollow?: boolean;
  /** 固定。人が画面で動かす・直す・消すことを止める。エージェントの書き込みは止めない */
  locked?: boolean;
  /** 矢印の通り道。elbow は直角に折れる線 */
  route?: (typeof ROUTES)[number];
  fromSide?: Side;
  toSide?: Side;
  /** elbow の折れ目の位置。出る向きから順に、横に出るなら x・y・x…、縦に出るなら y・x・y… */
  bends?: number[];
  /** 端ごとの形。書いた端は heads より優先する */
  startHead?: EndMark;
  endHead?: EndMark;
  head?: string[];
  rows?: string[][];
  src?: string;
  /** 画像の切り抜き。zoom は拡大率（1 以上）、x・y は見せたい場所（画像の左上が 0,0、右下が 1,1） */
  crop?: { zoom: number; x: number; y: number };
  /** 画像を押したときに開くリンク。http と https の URL か、ほかのボードへの相対パス */
  href?: string;
  svg?: string;
  points?: Point[];
  width?: number;
  /** コメントが指している要素の id。その要素が動くと、コメントも一緒に動く */
  on?: string;
  thread?: Message[];
  resolved?: boolean;
  /** 人が書いたが、まだ Claude に届けていないやりとりがある */
  unsent?: boolean;
  /** ガントの目盛りの単位。既定は month */
  unit?: GanttUnit;
  /** ガントに表示する範囲。書かなければ、行とマイルストーンが全部入る範囲 */
  start?: string;
  end?: string;
  bars?: GanttBar[];
  marks?: GanttMark[];
  /** ガントの、行の名前を入れる欄の幅。既定は 150 */
  labelW?: number;
  /** ガントに「今日」の線を引く日付 */
  today?: string;
  /** セクションの論点。枠の上部に大きく出す */
  question?: string;
  /** セクションの結論。論点の下に、帯で出す */
  answer?: string;
  /** 付箋と図形の、発言者の札 */
  who?: string;
  /** 付箋と図形の状態の札。carriedFrom だけを書いたときは、持ち越しとして出す */
  status?: NoteStatus;
  /** 持ち越しの元の会議の日付。札に「持ち越し 11/11」と出す。本文に日付を書かないので、同じ日付の繰り返しの検査にかからない */
  carriedFrom?: string;
  /** まとめの帯（summary）が集める条件。状態の名前（前の形）か、状態・発言者・tag の組（全部に当てはまる付箋を集める） */
  show?: NoteStatus | SummaryFilter;
  /** 付箋と図形の、宿題の期限。YYYY-MM-DD か YYYY-MM。札の段に「〆11/20」と出す */
  due?: string;
  /** セクションの中身を、この列の数で詰めて並べる。書くと、中身の位置と幅、セクションの高さを xwb が決める */
  cols?: number;
}

/** 人がブラウザで変えて、まだ Claude に送っていない要素。before は、前に送った時点の要素 */
export interface Pending {
  action: "added" | "changed" | "removed";
  before?: El;
}

export interface Doc {
  version: 1;
  title: string;
  /** 自動で振る id（e1, e2…）の最後の番号 */
  seq: number;
  elements: El[];
  /** WHY ボードのファイルに持つ: サーバーを起動し直しても、送っていない変更を失わないため */
  pending?: Record<string, Pending>;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Res<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Res<T> => ({ ok: true, value });
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** 見出し（title）がある付箋の、本文の文字の大きさ。見出しは 15px の太字 */
export const NOTE_SUB_FONT = 13;
export const NOTE_TITLE_FONT = 15;
export const FONT: Record<Size, number> = { s: 12, m: 16, l: 24, xl: 40, huge: 96 };

/** セクションの中の余白と、題名の帯の高さ。自動配置とブラウザの見た目で同じ値を使う */
export const PAD = 24;
export const TITLE_H = 52;
export const GAP = 16;
/** セクションの外に自動で置くときの、隣との間隔 */
export const OUTER_GAP = 60;

const FIELDS: Record<ElType, readonly string[]> = {
  shape: ["x", "y", "w", "h", "text", "title", "who", "status", "carriedFrom", "due", "tag", "color", "shape", "size", "align", "border", "hollow", "dashed"],
  container: ["x", "y", "w", "h", "title", "question", "answer", "color", "cols"],
  text: ["x", "y", "w", "text", "size", "align", "color"],
  arrow: ["from", "to", "label", "dashed", "heads", "color", "route", "fromSide", "toSide", "bends", "startHead", "endHead"],
  table: ["x", "y", "w", "head", "rows"],
  image: ["x", "y", "w", "h", "src", "svg", "crop", "href"],
  stroke: ["points", "color", "width"],
  // w・h があれば範囲を囲むコメント、無ければ 1 点を指すピン
  comment: ["x", "y", "w", "h", "on", "thread", "resolved", "unsent"],
  // 高さは、行の数から決まる
  gantt: ["x", "y", "w", "labelW", "title", "unit", "start", "end", "bars", "marks", "today"],
  // まとめの帯。高さは、集めた行の数から決まる。h は受け取って捨てる（画面の「元に戻す」とファイルが、h の付いた帯を渡すため。cols のセクションの h と同じ扱い）
  summary: ["x", "y", "w", "h", "show", "title", "color"],
};

const REQUIRED: Record<ElType, readonly string[]> = {
  comment: ["x", "y"],
  gantt: ["x", "y", "bars"],
  shape: ["x", "y", "w", "h"],
  container: ["x", "y", "w", "h"],
  text: ["x", "y", "text"],
  arrow: ["from", "to"],
  table: ["x", "y", "rows"],
  image: ["x", "y", "w", "h"],
  stroke: ["points"],
  summary: ["show"],
};

/**
 * まとめの帯の大きさ。題名の帯の高さ、1 行の高さ、下の余白、既定の幅、幅の下限。
 * 画面の CSS（board.css の .summary）と同じ値。片方だけ変えると、置く場所と見た目がずれる
 */
export const SUMMARY_HEAD_H = 52;
export const SUMMARY_ROW_H = 28;
export const SUMMARY_PAD_BOTTOM = 12;
export const SUMMARY_W = 480;
export const SUMMARY_MIN_W = 240;

/** 行の数から決まる、まとめの帯の高さ。0 行のときは「無し」の 1 行を出すので、1 行と同じ */
export function summaryHeight(rows: number): number {
  return SUMMARY_HEAD_H + Math.max(1, rows) * SUMMARY_ROW_H + SUMMARY_PAD_BOTTOM;
}

export const DEFAULT_SIZE = {
  shape: { w: 220, h: 110 },
  container: { w: 504, h: 160 },
  image: { w: 320, h: 240 },
} satisfies Partial<Record<ElType, { w: number; h: number }>>;

/** セクションの中身を並べる列の数の上限 */
export const MAX_COLS = 8;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && list.some((x) => x === v);
}

function isPoint(v: unknown): v is Point {
  return Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
}

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** 画像の src は、ボードのファイルと同じフォルダより上を指せない（サーバーが任意のファイルを返さないため） */
export function isSafeSrc(src: string): boolean {
  if (src.startsWith("data:image/")) return true;
  if (src.startsWith("/") || src.includes("\\") || src.includes(":")) return false;
  if (src.split("/").some((part) => part === ".." || part === "")) return false;
  return IMAGE_EXT.test(src);
}

export function parseEl(raw: unknown): Res<El> {
  if (!isRecord(raw)) return fail("要素はオブジェクトで書く");
  const { id, type } = raw;
  if (typeof id !== "string" || !ID_RE.test(id)) return fail(`id は英数字と - _ で 40 文字まで: ${JSON.stringify(id)}`);
  if (!isOneOf(TYPES, type)) return fail(`type は ${TYPES.join(" | ")} のどれか: ${JSON.stringify(type)}`);
  const el: El = { id, type };
  // locked は、どの種類の要素にも書ける
  const allowed = [...FIELDS[type], "locked"];
  for (const [k, v] of Object.entries(raw)) {
    if (k === "id" || k === "type") continue;
    if (!allowed.includes(k)) return fail(`${type} に ${k} は無い。使える項目: ${allowed.join(", ")}`);
    switch (k) {
      case "x":
      case "y":
        if (!isNum(v)) return fail(`${k} は数値`);
        el[k] = v;
        break;
      case "w":
      case "h":
      case "width":
      case "labelW":
        if (!isNum(v) || v <= 0) return fail(`${k} は正の数値`);
        el[k] = v;
        break;
      case "text":
      case "tag":
      case "title":
      case "label":
      case "who":
      case "question":
      case "answer":
      case "svg":
        if (typeof v !== "string") return fail(`${k} は文字列`);
        el[k] = v;
        break;
      case "href":
        if (typeof v !== "string" || !(/^https?:\/\/\S+$/.test(v) || isBoardRef(v))) return fail("href は http:// か https:// で始まる URL か、ほかのボードへの相対パス（.board.json で終わる）");
        el.href = v;
        break;
      case "status":
        if (!isOneOf(NOTE_STATUS, v)) return fail(`status は ${NOTE_STATUS.join(" | ")} のどれか`);
        el.status = v;
        break;
      case "show": {
        const r = parseShow(v);
        if (!r.ok) return r;
        // 状態の名前で書かれた show は、そのまま残す（前の形のファイルと、書いた形を変えない）
        el.show = isOneOf(NOTE_STATUS, v) ? v : r.value;
        break;
      }
      case "carriedFrom":
        if (typeof v !== "string" || parseDay(v, false) === null) return fail("carriedFrom は YYYY-MM-DD か YYYY-MM の日付");
        el.carriedFrom = v;
        break;
      case "due":
        if (typeof v !== "string" || parseDay(v, false) === null) return fail("due は YYYY-MM-DD か YYYY-MM の日付");
        el.due = v;
        break;
      case "cols":
        if (!isNum(v) || !Number.isInteger(v) || v < 1 || v > MAX_COLS) return fail(`cols は 1〜${MAX_COLS} の整数`);
        el.cols = v;
        break;
      case "crop": {
        if (!isRecord(v) || !isNum(v.zoom) || !isNum(v.x) || !isNum(v.y)) return fail("crop は { zoom, x, y }");
        if (v.zoom < 1 || v.x < 0 || v.x > 1 || v.y < 0 || v.y > 1) return fail("crop の zoom は 1 以上、x・y は 0〜1");
        el.crop = { zoom: v.zoom, x: v.x, y: v.y };
        break;
      }
      case "src":
        if (typeof v !== "string" || !isSafeSrc(v)) return fail("src は、ボードと同じフォルダからの相対パス（png・jpg・gif・webp・svg）か data:image/ の URL");
        el.src = v;
        break;
      case "color":
        if (!isOneOf(COLORS, v)) return fail(`color は ${COLORS.join(" | ")} のどれか`);
        el.color = v;
        break;
      case "shape":
        if (!isOneOf(SHAPES, v)) return fail(`shape は ${SHAPES.join(" | ")} のどれか`);
        el.shape = v;
        break;
      case "align":
        if (!isOneOf(ALIGNS, v)) return fail(`align は ${ALIGNS.join(" | ")} のどれか`);
        el.align = v;
        break;
      case "size":
        if (!isOneOf(SIZES, v)) return fail(`size は ${SIZES.join(" | ")} のどれか`);
        el.size = v;
        break;
      case "heads":
        if (!isOneOf(HEADS, v)) return fail(`heads は ${HEADS.join(" | ")} のどれか`);
        el.heads = v;
        break;
      case "dashed":
      case "hollow":
      case "locked":
        if (typeof v !== "boolean") return fail(`${k} は true か false`);
        el[k] = v;
        break;
      case "border":
        if (!isOneOf(COLORS, v)) return fail(`border は ${COLORS.join(" | ")} のどれか`);
        el.border = v;
        break;
      case "route":
        if (!isOneOf(ROUTES, v)) return fail(`route は ${ROUTES.join(" | ")} のどれか`);
        el.route = v;
        break;
      case "fromSide":
      case "toSide":
        if (!isOneOf(SIDES, v)) return fail(`${k} は ${SIDES.join(" | ")} のどれか`);
        el[k] = v;
        break;
      case "startHead":
      case "endHead":
        if (!isOneOf(END_MARKS, v)) return fail(`${k} は ${END_MARKS.join(" | ")} のどれか`);
        el[k] = v;
        break;
      case "bends":
        if (!Array.isArray(v) || !v.every(isNum)) return fail("bends は数値の配列");
        el.bends = v;
        break;
      case "from":
      case "to":
        if (typeof v === "string" && ID_RE.test(v)) el[k] = v;
        else if (isPoint(v)) el[k] = v;
        else return fail(`${k} は要素の id か [x, y]`);
        break;
      case "head":
        if (!isStrings(v)) return fail("head は文字列の配列");
        el.head = v;
        break;
      case "rows":
        if (!Array.isArray(v) || !v.every(isStrings)) return fail("rows は文字列の配列の配列");
        el.rows = v;
        break;
      case "on":
        if (typeof v !== "string" || !ID_RE.test(v)) return fail("on は要素の id");
        el.on = v;
        break;
      case "resolved":
      case "unsent":
        if (typeof v !== "boolean") return fail(`${k} は true か false`);
        el[k] = v;
        break;
      case "unit":
        if (!isOneOf(GANTT_UNITS, v)) return fail(`unit は ${GANTT_UNITS.join(" | ")} のどれか`);
        el.unit = v;
        break;
      case "start":
      case "end":
      case "today":
        if (typeof v !== "string" || parseDay(v, k === "end") === null) return fail(`${k} は YYYY-MM-DD か YYYY-MM の日付`);
        el[k] = v;
        break;
      case "bars": {
        if (!Array.isArray(v)) return fail("bars は配列");
        const bars: GanttBar[] = [];
        for (const [i, b] of v.entries()) {
          const at = `bars[${i}]`;
          if (!isRecord(b) || typeof b.name !== "string") return fail(`${at} は { name, start, end } か { name, segments }`);
          // 期間 1 つ（start・end）か、期間の並び（segments）の、どちらか片方で書く
          const period = (p: Record<string, unknown>, where: string): Res<GanttSegment> => {
            if (typeof p.start !== "string" || typeof p.end !== "string") return fail(`${where} には start と end が要る`);
            const s = parseDay(p.start, false);
            const e = parseDay(p.end, true);
            if (s === null || e === null) return fail(`${where} の start・end は YYYY-MM-DD か YYYY-MM の日付`);
            if (s > e) return fail(`${where} の start が end より後になっている`);
            if (p.status !== undefined && !isOneOf(GANTT_STATUS, p.status)) return fail(`${where} の status は ${GANTT_STATUS.join(" | ")} のどれか`);
            return ok({ start: p.start, end: p.end, ...(p.status === undefined ? {} : { status: p.status }) });
          };
          const bar: GanttBar = { name: b.name };
          if (b.segments !== undefined) {
            if (b.start !== undefined || b.end !== undefined) return fail(`${at} は、start・end と segments のどちらか片方で書く`);
            if (!Array.isArray(b.segments) || b.segments.length === 0) return fail(`${at} の segments は、{ start, end } を 1 つ以上`);
            bar.segments = [];
            for (const [j, seg] of b.segments.entries()) {
              if (!isRecord(seg)) return fail(`${at}.segments[${j}] は { start, end }`);
              for (const key of Object.keys(seg)) if (!["start", "end", "status"].includes(key)) return fail(`${at}.segments[${j}] に ${key} は無い`);
              const p = period(seg, `${at}.segments[${j}]`);
              if (!p.ok) return p;
              bar.segments.push(p.value);
            }
            if (b.status !== undefined && !isOneOf(GANTT_STATUS, b.status)) return fail(`${at} の status は ${GANTT_STATUS.join(" | ")} のどれか`);
            if (b.status !== undefined) bar.status = b.status;
          } else {
            const p = period(b, at);
            if (!p.ok) return p;
            Object.assign(bar, p.value);
          }
          if (b.color !== undefined && !isOneOf(COLORS, b.color)) return fail(`${at} の color は ${COLORS.join(" | ")} のどれか`);
          if (b.color !== undefined) bar.color = b.color;
          for (const key of ["tag", "group"] satisfies ("tag" | "group")[]) {
            const v2 = b[key];
            if (v2 === undefined) continue;
            if (typeof v2 !== "string") return fail(`${at} の ${key} は文字列`);
            bar[key] = v2;
          }
          for (const key of Object.keys(b)) if (!["name", "start", "end", "segments", "color", "status", "tag", "group"].includes(key)) return fail(`${at} に ${key} は無い`);
          bars.push(bar);
        }
        el.bars = bars;
        break;
      }
      case "marks": {
        if (!Array.isArray(v)) return fail("marks は配列");
        const marks: GanttMark[] = [];
        for (const [i, m] of v.entries()) {
          if (!isRecord(m) || typeof m.name !== "string" || typeof m.date !== "string" || parseDay(m.date, false) === null) return fail(`marks[${i}] は { name, date }。date は YYYY-MM-DD か YYYY-MM`);
          marks.push({ name: m.name, date: m.date });
        }
        el.marks = marks;
        break;
      }
      case "thread": {
        if (!Array.isArray(v)) return fail("thread は配列");
        const thread: Message[] = [];
        for (const m of v) {
          if (!isRecord(m) || !isOneOf(SPEAKERS, m.by) || typeof m.at !== "string" || typeof m.text !== "string") return fail("thread の 1 件は { by: human | claude, at, text }");
          thread.push({ by: m.by, at: m.at, text: m.text });
        }
        el.thread = thread;
        break;
      }
      case "points":
        if (!Array.isArray(v) || v.length < 2 || !v.every(isPoint)) return fail("points は [x, y] を 2 つ以上");
        el.points = v;
        break;
    }
  }
  for (const k of REQUIRED[type]) {
    if (raw[k] === undefined) return fail(`${type} には ${k} が要る`);
  }
  if (el.carriedFrom !== undefined && el.status !== undefined && !isOneOf(CARRIABLE, el.status)) return fail("carriedFrom を書くなら、status は carried か todo か open か、書かない");
  if (type === "image" && (el.src === undefined) === (el.svg === undefined)) return fail("image には src か svg のどちらか 1 つを書く");
  if (type === "summary" && el.w !== undefined && el.w < SUMMARY_MIN_W) return fail(`summary の w は ${SUMMARY_MIN_W} 以上（行の文字が入らない）`);
  return ok(el);
}

/**
 * 付箋の状態の札に出す文字。状態が無ければ null。持ち越しには、元の日付を付ける（「持ち越し 11/11」。月までの日付は「持ち越し 11月」）。
 * 持ち越しの宿題と未決（status が todo か open で、carriedFrom がある）は、1 つの札に「宿題11/11から」「未決11/11から」と出す。
 * WHY 短く書く: 札の段は 1 段で、tag と期限と発言者も同じ段に並ぶ。「持ち越し · 11/11 から」と書くと、幅 220 の付箋で発言者が切れる。
 * 宿題と持ち越しを 2 つの札に分けると、期限と発言者が入らない
 */
export function statusBadge(el: El): { status: NoteStatus; label: string } | null {
  const status = el.status ?? (el.carriedFrom === undefined ? undefined : "carried");
  if (status === undefined) return null;
  const date = el.carriedFrom === undefined ? "" : shortDay(el.carriedFrom);
  // 持ち越し（carried）は「持ち越し 11/11」。持ち越しの宿題と未決は、状態の名前に「11/11から」を続ける
  const from = date === "" ? "" : status === "carried" ? ` ${date}` : `${date}から`;
  return { status, label: STATUS_LABEL[status] + from };
}

/** 日付（YYYY-MM-DD か YYYY-MM）の、年を出さない短い書き方。「11/20」、月までの日付は「11月」。札の段と、まとめの帯の行に使う */
export function shortDay(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return day === undefined ? `${month}月` : `${month}/${day}`;
}

/**
 * 付箋の札の段に出す、期限の文字。期限が無ければ null。年は出さない（「〆11/20」。月までの期限は「〆11月」）。
 * WHY 「〆」の 1 文字: 日付だけだと、持ち越しの札の日付や会議の日付と見分けられない。札の段は 1 段で幅がきつく、
 * 「期限 11/20」と書くと、幅 220 の付箋で「持ち越し 11/11」と発言者の札と並ばない
 */
export function dueLabel(el: El): string | null {
  return el.due === undefined ? null : `〆${shortDay(el.due)}`;
}

/** 付箋の札の段に並ぶ部品。status は、状態の札の色を決める状態 */
export type MetaPart = { kind: "status"; text: string; status: NoteStatus } | { kind: "tag" | "due" | "who"; text: string };

/**
 * 付箋の札の段に、左から並ぶ部品。状態の札、tag、期限、発言者の順。何も無ければ、段そのものが出ない。
 * WHY 1 か所で決める: 画面（描く）と検査（幅と高さを見積もる）が別々に並べると、欄を足したときに片方だけ変わる
 */
export function metaParts(el: El): MetaPart[] {
  const badge = statusBadge(el);
  const due = dueLabel(el);
  return [
    ...(badge ? [{ kind: "status" as const, text: badge.label, status: badge.status }] : []),
    ...(el.tag ? [{ kind: "tag" as const, text: el.tag }] : []),
    ...(due ? [{ kind: "due" as const, text: due }] : []),
    ...(el.who ? [{ kind: "who" as const, text: el.who }] : []),
  ];
}

/** その場所の時計での日付（YYYY-MM-DD）。期限切れを決める「今日」に使う */
export function localDay(now: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/**
 * 期限を過ぎているか。today は YYYY-MM-DD。期限の日は、まだ過ぎていない。月までの期限は、その月が終わるまで過ぎていない。
 * 状態には関わらない。終わった宿題は、期限（due）か付箋を消す
 */
export function isOverdue(el: El, today: string): boolean {
  if (el.due === undefined) return false;
  return el.due < today.slice(0, el.due.length);
}

/** セクションの論点と結論の文字の大きさ。画面の CSS（.container .sq と .sa）と同じ値 */
export const SECTION_Q_FONT = 18;
export const SECTION_A_FONT = 15;

/**
 * セクションの上の端から、中身を置き始める場所までの高さ。題名の帯に、論点と結論のぶんを足す。
 * 文字の高さは見積もり（折り返しの行の数 × 行の高さ）。
 */
export function sectionTop(c: El): number {
  const inner = Math.max(SECTION_Q_FONT, (c.w ?? 0) - PAD * 2);
  const lines = (text: string, px: number, width: number): number => text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l, px) / width)), 0);
  // 論点は行の高さ 1.4 と下の間 8。結論は行の高さ 1.5、帯の上下の余白 12、左右の余白 20（結論の札のぶん、2 文字ぶん狭い）、下の間 8
  const q = c.question ? Math.ceil(lines(c.question, SECTION_Q_FONT, inner) * SECTION_Q_FONT * 1.4) + 8 : 0;
  const a = c.answer ? Math.ceil(lines(c.answer, SECTION_A_FONT, inner - 20 - SECTION_A_FONT * 2) * SECTION_A_FONT * 1.5) + 12 + 8 : 0;
  return TITLE_H + q + a;
}

export function emptyDoc(title: string): Doc {
  return { version: 1, title, seq: 0, elements: [] };
}

export function parseDoc(text: string): Res<Doc> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`JSON として読めない: ${String(e)}`);
  }
  if (!isRecord(raw) || raw.version !== 1) return fail("version: 1 のボードではない");
  if (typeof raw.title !== "string" || !isNum(raw.seq) || !Array.isArray(raw.elements)) return fail("title・seq・elements が要る");
  const elements: El[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.elements.entries()) {
    const r = parseEl(item);
    if (!r.ok) return fail(`elements[${i}]: ${r.error}`);
    if (seen.has(r.value.id)) return fail(`elements[${i}]: id が重なっている: ${r.value.id}`);
    seen.add(r.value.id);
    elements.push(r.value);
  }
  const pending: Record<string, Pending> = {};
  if (raw.pending !== undefined) {
    if (!isRecord(raw.pending)) return fail("pending はオブジェクトで書く");
    for (const [id, p] of Object.entries(raw.pending)) {
      if (!isRecord(p) || !isOneOf(PENDING_ACTIONS, p.action)) return fail(`pending.${id}: action は ${PENDING_ACTIONS.join(" | ")} のどれか`);
      if (p.before === undefined) {
        pending[id] = { action: p.action };
        continue;
      }
      const before = parseEl(p.before);
      if (!before.ok) return fail(`pending.${id}.before: ${before.error}`);
      pending[id] = { action: p.action, before: before.value };
    }
  }
  return ok({ version: 1, title: raw.title, seq: raw.seq, elements, ...(Object.keys(pending).length > 0 ? { pending } : {}) });
}

/** 1 要素を 1 行に書く。会議のリポジトリで差分が要素ごとに出るようにするため */
export function serialize(doc: Doc): string {
  const lines = doc.elements.map((e) => `    ${JSON.stringify(e)}`);
  const pending = doc.pending && Object.keys(doc.pending).length > 0 ? `  "pending": ${JSON.stringify(doc.pending)},\n` : "";
  return `{\n  "version": 1,\n  "title": ${JSON.stringify(doc.title)},\n  "seq": ${doc.seq},\n${pending}  "elements": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

// ---- 人が変えたことの記録 ----

const PENDING_ACTIONS = ["added", "changed", "removed"] as const;

/**
 * 人の操作を 1 回適用した後の、まだ送っていない変更の一覧を返す。
 * エージェントの書き込みでは呼ばない（エージェントが変えた要素は、人からの知らせに入れないため）。
 */
export function trackHuman(prev: Doc, applied: Applied): Record<string, Pending> {
  const pending: Record<string, Pending> = { ...(prev.pending ?? {}) };
  const prevById = new Map(prev.elements.map((e) => [e.id, e]));
  // コメントは、コメントごとの「送る」で届ける。ボード全体の変更の一覧には入れない
  const tracked = (els: El[]): El[] => els.filter((e) => e.type !== "comment");
  for (const el of tracked(applied.added)) {
    // 消したものを「元に戻す」で足し直したときは、足したのではなく、消す前から変わったかどうかで見る
    const was = pending[el.id];
    pending[el.id] = was?.action === "removed" && was.before ? { action: "changed", before: was.before } : { action: "added" };
  }
  for (const el of tracked(applied.updated)) {
    const before = prevById.get(el.id);
    if (!pending[el.id] && before) pending[el.id] = { action: "changed", before };
  }
  for (const el of tracked(applied.removed)) {
    const was = pending[el.id];
    if (was?.action === "added") delete pending[el.id];
    else pending[el.id] = { action: "removed", before: was?.before ?? el };
  }
  return pending;
}

export interface Change {
  id: string;
  action: "added" | "changed" | "removed";
  /** 直したとき、変わった項目の名前。位置だけの変更（x・y）を読む側が見分けられるようにする */
  fields?: string[];
  /** 直したとき、前に送った時点の要素 */
  before?: El;
  /** 今の要素。消したときは、消える前の要素 */
  el: El;
}

function changedFields(a: El, b: El): string[] {
  const ra: Record<string, unknown> = { ...a };
  const rb: Record<string, unknown> = { ...b };
  return [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((k) => JSON.stringify(ra[k]) !== JSON.stringify(rb[k]));
}

/** 送る一覧。変えてから元に戻した要素と、人が変えた後にエージェントが消した要素は入れない */
export function pendingChanges(doc: Doc): Change[] {
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const out: Change[] = [];
  for (const [id, p] of Object.entries(doc.pending ?? {})) {
    const el = byId.get(id);
    if (!el) {
      if (p.action === "removed" && p.before) out.push({ id, action: "removed", el: p.before });
      continue;
    }
    if (!p.before) {
      out.push({ id, action: "added", el });
      continue;
    }
    const fields = changedFields(p.before, el);
    if (fields.length > 0) out.push({ id, action: "changed", fields, before: p.before, el });
  }
  return out;
}

// ---- 大きさの見積もり ----
// サーバーと CLI は描画できないので、文字と表の大きさは文字数から見積もる。
// ブラウザの CSS（行の高さ、表のフォントと余白）をこの式に合わせてある。

export const TEXT_LINE = 1.45;
export const TABLE_FONT = 13;
export const TABLE_LINE = 19;
export const TABLE_PAD_X = 10;
export const TABLE_PAD_Y = 7;
export const TABLE_COL = 150;

export function textWidth(s: string, px: number): number {
  let em = 0;
  for (const ch of s) em += (ch.codePointAt(0) ?? 0) > 0xff ? 1 : 0.58;
  return em * px;
}

export function tableCols(el: El): number {
  return Math.max(1, el.head?.length ?? 0, ...(el.rows ?? []).map((r) => r.length));
}

export function sizeOf(el: El): { w: number; h: number } {
  switch (el.type) {
    case "text": {
      const px = FONT[el.size ?? "m"];
      const lines = plainText(el.text ?? "").split("\n");
      const widths = lines.map((l) => textWidth(l, px));
      const w = el.w ?? Math.max(px, ...widths);
      const count = widths.reduce((n, lw) => n + Math.max(1, Math.ceil(lw / w)), 0);
      return { w, h: Math.ceil(count * px * TEXT_LINE) };
    }
    case "table": {
      const cols = tableCols(el);
      const w = el.w ?? cols * TABLE_COL;
      const inner = Math.max(TABLE_FONT, w / cols - TABLE_PAD_X * 2);
      const all = el.head ? [el.head, ...(el.rows ?? [])] : (el.rows ?? []);
      let h = 1;
      for (const row of all) {
        // セルの中の改行と箇条書きも行に数える
        const lines = Math.max(1, ...row.map((c) => plainText(c).split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l, TABLE_FONT) / inner)), 0)));
        h += lines * TABLE_LINE + TABLE_PAD_Y * 2 + 1;
      }
      return { w, h };
    }
    case "gantt": {
      const layout = ganttLayout(el);
      return { w: layout.w, h: layout.h };
    }
    case "summary":
      // 高さは、集めた行の数から決まる。操作のまとまりの最後に、applyOps（settleSummaries）が h に書く。まだ書かれていなければ、1 行ぶん
      return { w: el.w ?? SUMMARY_W, h: el.h ?? summaryHeight(1) };
    default:
      return { w: el.w ?? 0, h: el.h ?? 0 };
  }
}

function pointsBox(points: Point[]): Box | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** 要素が占める四角。両端が要素に付いた矢印は、自分の場所を持たないので null */
export function boxOf(el: El): Box | null {
  switch (el.type) {
    case "arrow":
      return pointsBox([el.from, el.to].filter(isPoint));
    case "stroke":
      return pointsBox(el.points ?? []);
    default: {
      if (el.x === undefined || el.y === undefined) return null;
      return { x: el.x, y: el.y, ...sizeOf(el) };
    }
  }
}

/** 場所をふさぐ中身。矢印がよけ、互いに重ならないように置くもの。セクション・線・コメントは入らない */
export function isSolid(el: El): boolean {
  return el.type === "shape" || el.type === "text" || el.type === "table" || el.type === "image" || el.type === "gantt";
}

/**
 * 要素の全体が入る四角。コメントは、頼まれたときだけ数える。
 * WHY: コメントはボードの中身ではなく、ボードについてのやりとり。自動で置く場所とスクショの範囲を、コメントで広げない。
 */
export function boundsOf(els: Iterable<El>, withComments = false): Box | null {
  let b: { x1: number; y1: number; x2: number; y2: number } | null = null;
  for (const el of els) {
    if (el.type === "comment" && !withComments) continue;
    const r = boxOf(el);
    if (!r) continue;
    b = b
      ? { x1: Math.min(b.x1, r.x), y1: Math.min(b.y1, r.y), x2: Math.max(b.x2, r.x + r.w), y2: Math.max(b.y2, r.y + r.h) }
      : { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h };
  }
  return b ? { x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 } : null;
}

function overlaps(a: Box, b: Box, gap: number): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/**
 * セクションの中身。親子の項目は持たず、中心がセクションの中にある要素を中身とみなす。
 * WHY: 人がドラッグで出し入れしても、エージェントが座標で置いても、親の id を書き直さずに済む。
 */
export function membersOf(els: Iterable<El>, container: El): El[] {
  return insideOf(els, container).filter((el) => el.type !== "arrow" && el.type !== "container");
}

function centerIn(b: Box, c: Box): boolean {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h;
}

/** 中心がセクションの枠の中にある要素の全部。中身（membersOf）に加えて、中のセクションと、端を座標で書いた矢印も入る */
function insideOf(els: Iterable<El>, container: El): El[] {
  const c = boxOf(container);
  if (!c) return [];
  const out: El[] = [];
  for (const el of els) {
    const b = el.id === container.id ? null : boxOf(el);
    if (b && centerIn(b, c)) out.push(el);
  }
  return out;
}

/**
 * セクションを動かすときに、一緒に動かす要素。枠の中に中心がある要素の全部と、中のセクションの中身。
 * 列で並べるセクションを set で動かすときと、並べ直し（format）が、同じ決まりで連れていく
 */
export function ridersOf(els: readonly El[], section: El): El[] {
  const within = insideOf(els, section);
  return [...new Set([...within, ...within.filter((n) => n.type === "container").flatMap((n) => membersOf(els, n))])];
}

export function shifted(el: El, dx: number, dy: number): El {
  const move = (p: Point): Point => [p[0] + dx, p[1] + dy];
  const end = (e: End | undefined): End | undefined => (e === undefined || typeof e === "string" ? e : move(e));
  switch (el.type) {
    case "stroke":
      return { ...el, points: (el.points ?? []).map(move) };
    case "arrow":
      return { ...el, from: end(el.from), to: end(el.to) };
    default:
      return { ...el, x: (el.x ?? 0) + dx, y: (el.y ?? 0) + dy };
  }
}

interface Unit {
  head: string;
  box: Box;
  ids: string[];
  /** section は、セクションとその中身。solid は、場所をふさぐ要素 1 つ。other は、線・コメント・座標の矢印 1 つ */
  kind: "section" | "solid" | "other";
}

/**
 * 一緒に動かすまとまり。セクションはその中身ごと、どのセクションにも入っていない要素は 1 つずつ。
 * WHY: 押し下げるときに要素ごとに判定すると、背の高いセクションの下半分の中身だけが動いて、枠から出る。
 */
function unitsOf(els: El[]): Unit[] {
  const claimed = new Set<string>();
  const out: Unit[] = [];
  for (const c of els) {
    const box = c.type === "container" ? boxOf(c) : null;
    if (!box) continue;
    const ids = [c.id];
    for (const m of membersOf(els, c)) {
      if (claimed.has(m.id)) continue;
      claimed.add(m.id);
      ids.push(m.id);
    }
    out.push({ head: c.id, box, ids, kind: "section" });
  }
  for (const e of els) {
    if (e.type === "container" || claimed.has(e.id)) continue;
    const box = boxOf(e);
    if (box) out.push({ head: e.id, box, ids: [e.id], kind: isSolid(e) ? "solid" : "other" });
  }
  return out;
}

/** 列で並べるセクション（cols）の、1 列の幅 */
export function colWidth(c: Box, cols: number): number {
  return Math.max(40, Math.floor((c.w - PAD * 2 - GAP * (cols - 1)) / cols));
}


/**
 * セクションが before から after へ下に伸びたときに、下へずらすまとまりと、ずらす量を返す。ずらすものが無ければ null。
 * 伸びる前の下の端より下から始まり、横が重なるまとまりのうち、いちばん上のものの高さから下を、横の列も含めて全部ずらす。
 * WHY 段ごと: 届いたものだけをずらすと、横に並んだセクションの上がそろわなくなる。
 * gap は、伸びた下の端と、ずらしたものの間に空ける量。
 *
 * arranged は、列で並べるセクションが伸びたときに true を渡す。
 * 伸びた枠に中心が入る、場所をふさぐ要素を、下の端より上から始まっていても、一緒にずらす。
 * 中心が下の端より下にあって、伸びた枠にかかるセクションも、一緒にずらす。
 * WHY: 残すと、その要素か、そのセクションの中身が、並べる中身になる。線・コメント・矢印は、並べる中身にならないので残す。
 * 伸びるセクションの中心を含むセクションは残す。囲んでいるセクションで、ずらすと、囲む側が中身ごと下へ動く。
 * 中心が入る要素があると、その上の端からずらす量を決めるので、下のものは、間が gap より広く空く。
 * WHY その要素だけを別の量でずらさない: 下にあるものの上に重なる。
 */
function growthPush(others: readonly Unit[], before: Box, after: Box, gap: number, arranged = false): { units: Unit[]; dy: number } | null {
  const bottom = before.y + before.h;
  const end = after.y + after.h;
  const facing = (u: Unit): boolean => u.box.x < after.x + after.w && after.x < u.box.x + u.box.w;
  const under = (h: number): Box => ({ x: after.x, y: bottom, w: after.w, h });
  const swallowed = (u: Unit): boolean => {
    if (!arranged || u.kind === "other") return false;
    return u.kind === "solid" ? centerIn(u.box, under(end - bottom)) : centerIn(u.box, under(Number.POSITIVE_INFINITY)) && u.box.y < end && !centerIn(before, u.box);
  };
  const starts = others.filter((u) => (u.box.y >= bottom && facing(u)) || swallowed(u));
  const threshold = Math.min(...starts.map((u) => u.box.y));
  const dy = end + gap - threshold;
  if (starts.length === 0 || dy <= 0) return null;
  // 中心が入る要素を相手にすると、threshold は下の端より上になる。横の列にあって、下の端より上から始まるものは、同じ段に並んでいるので動かさない
  const from = Math.max(threshold, bottom);
  return { units: others.filter((u) => u.box.y >= from || swallowed(u)), dy };
}

/**
 * セクションが before から after へ右に伸びたときに、右へずらすまとまりと、ずらす量を返す。ずらすものが無ければ null。
 * 下への押し下げ（growthPush）を横に写したもの。伸びる前の右の端より右から始まり、縦の範囲が重なるまとまりのうち、いちばん左のものの位置から右を、
 * 縦の列も含めて全部、伸びた右の端から gap 空く所までずらす。
 * WHY 列ごと: 届いたものだけをずらすと、縦に並んだセクションの左の端がそろわなくなる。さらに右のものも同じだけ動くので、ずらした先で重ならない。
 * まとめの帯、固定した要素、線とコメントも、押し下げと同じに、一緒にずらす。
 */
function growthPushRight(others: readonly Unit[], before: Box, after: Box, gap: number): { units: Unit[]; dx: number } | null {
  const right = before.x + before.w;
  const end = after.x + after.w;
  const facing = (u: Unit): boolean => u.box.y < after.y + after.h && after.y < u.box.y + u.box.h;
  const starts = others.filter((u) => u.box.x >= right && facing(u));
  if (starts.length === 0) return null;
  const threshold = Math.min(...starts.map((u) => u.box.x));
  const dx = end + gap - threshold;
  if (dx <= 0) return null;
  return { units: others.filter((u) => u.box.x >= threshold), dx };
}

interface Item {
  el: El;
  box: Box;
}

/**
 * 列で並べるセクションの中身（items。ボードの要素の並びの順）を、並べる順にして返す。
 * 並ぶ順は、ボードの要素の並び。このまとまりで場所を書いた要素（placed）だけ、書いた場所から、入れる位置を決める。
 * WHY 場所を書いた要素だけ位置から読む: 全部の中身の位置を毎回読むと、高さが変わっただけで行の読みが変わり、順が入れ替わる。
 * 入れる位置は、場所を書いていない中身（錨）の行から読む。行は、上の端が同じで、並びが続いている錨。行の帯は、上の端から、その行でいちばん背の高い錨の下の端まで。
 * 行を上から見て、要素の中心が帯より上なら、その行の前。要素の上の端が帯の下の端までにあれば、その行の中で、中心が右にある最初の錨の前（無ければ行の末尾）。
 * どの行にも当たらなければ末尾。
 * WHY 行を先に決める: 錨 1 つずつの上下の範囲で見ると、錨より背の高い要素は、中心が錨の下の端より下に出て、その行の要素と読まれない。
 * 同じ位置に入る要素どうしは、上の端、左の端の順に並べる。
 */
function orderOf(items: readonly Item[], placed: ReadonlySet<string>): El[] {
  const rest = items.filter((it) => !placed.has(it.el.id));
  const rows: { y: number; bottom: number; from: number; to: number }[] = [];
  for (const [i, { box }] of rest.entries()) {
    const row = rows.at(-1);
    if (row && row.y === box.y) {
      row.bottom = Math.max(row.bottom, box.y + box.h);
      row.to = i + 1;
    } else {
      rows.push({ y: box.y, bottom: box.y + box.h, from: i, to: i + 1 });
    }
  }
  const slotOf = ({ box }: Item): number => {
    const cx = box.x + box.w / 2;
    for (const row of rows) {
      if (box.y + box.h / 2 < row.y) return row.from;
      if (box.y > row.bottom) continue;
      const i = rest.slice(row.from, row.to).findIndex((anchor) => cx < anchor.box.x + anchor.box.w / 2);
      return i < 0 ? row.to : row.from + i;
    }
    return rest.length;
  };
  const movers = items.filter((it) => placed.has(it.el.id)).map((it) => ({ it, slot: slotOf(it) }));
  movers.sort((p, q) => p.it.box.y - q.it.box.y || p.it.box.x - q.it.box.x);
  const out: El[] = [];
  for (let i = 0; i <= rest.length; i++) {
    out.push(...movers.filter((k) => k.slot === i).map((k) => k.it.el));
    const anchor = rest[i];
    if (anchor) out.push(anchor.el);
  }
  return out;
}

/**
 * 列で並べるセクション c（枠は cb）に、中身（ordered。並べる順）を左上から列に詰めたときの、中身の形（cells）と、セクションの高さ（h）。
 * 中身が無ければ、題名の帯だけの高さ。
 */
function gridOf(c: El, cb: Box, cols: number, ordered: readonly El[]): { cells: El[]; h: number } {
  const colW = colWidth(cb, cols);
  const cells: El[] = [];
  let y = cb.y + sectionTop(c);
  for (let i = 0; i < ordered.length; i += cols) {
    let rowH = 0;
    for (const [k, m] of ordered.slice(i, i + cols).entries()) {
      // 画像は、縦横の比を保って列の幅に合わせる
      const h = m.type === "image" && m.w !== undefined && m.h !== undefined ? { h: Math.round((m.h * colW) / m.w) } : {};
      const next: El = { ...m, ...h, w: colW, x: cb.x + PAD + k * (colW + GAP), y };
      rowH = Math.max(rowH, sizeOf(next).h);
      cells.push(next);
    }
    y += rowH + GAP;
  }
  return { cells, h: ordered.length === 0 ? sectionTop(c) : y - GAP + PAD - cb.y };
}

interface Arranged {
  /** 並べ直した後の、ボードの全要素 */
  els: El[];
  /** 形が変わった要素の id */
  changed: string[];
  /** 要素の並び（重なり順）が変わった */
  reordered: boolean;
}

/**
 * 列の指定（cols）があるセクションを、全部並べ直す。
 * 中身（中心が枠の中にある、場所をふさぐ要素）を、左上から列に詰め、セクションの高さを中身に合わせる。中身が無ければ、題名の帯だけの高さに畳む。
 * kept は、セクションの id ごとの、位置に関わらず、そのセクションの中身と読む要素の id（applyOps の kept）。ほかのセクションの中身には数えない。
 * placed は、このまとまりで場所を書いた要素の id（orderOf）。
 */
function arrangeCols(els: readonly El[], kept: ReadonlyMap<string, readonly string[]>, placed: ReadonlySet<string>): Arranged {
  const work = [...els];
  const index = new Map(work.map((e, i) => [e.id, i]));
  const get = (id: string): El | undefined => work[index.get(id) ?? -1];
  const changed = new Set<string>();
  let reordered = false;
  const put = (next: El): void => {
    const i = index.get(next.id);
    if (i === undefined || JSON.stringify(work[i]) === JSON.stringify(next)) return;
    work[i] = next;
    changed.add(next.id);
  };
  const sections = work.filter((e) => e.type === "container" && e.cols !== undefined);
  for (const { id } of sections) {
    // 先に並べたセクションが伸びて、押し下げられていることがあるので、今の形を読み直す
    const c = get(id);
    const cb = c ? boxOf(c) : null;
    if (!c || !cb || c.cols === undefined) continue;
    const own = new Set(kept.get(id) ?? []);
    const elsewhere = new Set([...kept].flatMap(([section, ids]) => (section === id ? [] : ids)));
    const items = work.flatMap((el): Item[] => {
      const box = isSolid(el) ? boxOf(el) : null;
      return box && !elsewhere.has(el.id) && (own.has(el.id) || centerIn(box, cb)) ? [{ el, box }] : [];
    });
    const grid = gridOf(c, cb, c.cols, orderOf(items, placed));
    // 並ぶ順を、ボードの要素の並びに書き戻す。中身が占めていた位置の中で入れ替える。
    // WHY: 要素の並びは重なり順でもある。中身の集まりが同じなら、中身でない要素との前後は変わらない。
    // 中身が加わるか抜けると、前からいた中身が、中身でない要素をまたいで動くことがある
    if (grid.cells.some((m, i) => m.id !== items[i]?.el.id)) {
      const slots = items.flatMap((it) => index.get(it.el.id) ?? []);
      // 書き戻す前の要素を先に全部取る。書き戻しの途中は、位置の表（index）が古い
      const moving = grid.cells.flatMap((m) => get(m.id) ?? []);
      for (const [i, el] of moving.entries()) {
        const slot = slots[i];
        if (slot === undefined) continue;
        work[slot] = el;
        index.set(el.id, slot);
      }
      reordered = true;
    }
    const mine = new Set([id, ...grid.cells.map((m) => m.id)]);
    // WHY 並べる前にまとまりを取る: まとまりは、中心がセクションの中にあるかで中身を見分ける。
    // 並べている途中（中身は動いたが、セクションの高さは古い）や、伸ばした後（下にあった要素が枠に入る）に取ると、見分けを間違える
    const others = unitsOf(work).flatMap((u) => (mine.has(u.head) ? [] : [{ ...u, ids: u.ids.filter((i) => !mine.has(i)) }]));
    for (const next of grid.cells) {
      const old = get(next.id);
      // この要素を指しているコメントは、一緒に動かす
      for (const note of work.filter((e) => e.type === "comment" && e.on === next.id)) put(shifted(note, (next.x ?? 0) - (old?.x ?? 0), (next.y ?? 0) - (old?.y ?? 0)));
      put(next);
    }
    const h = grid.h;
    put({ ...c, h });
    // 縮んだときは、下のものを動かさない（間が OUTER_GAP より狭くなっていても、押し下げない）
    const push = h > cb.h ? growthPush(others, cb, { ...cb, h }, OUTER_GAP, true) : null;
    // 押し下げた要素を指しているコメントは、一緒に動かす
    const pushed = new Set(push?.units.flatMap((u) => u.ids));
    for (const el of [...work]) {
      if (pushed.has(el.id) || (el.type === "comment" && el.on !== undefined && pushed.has(el.on))) put(shifted(el, 0, push?.dy ?? 0));
    }
  }
  return { els: work, changed: [...changed], reordered };
}

/**
 * まとめの帯の高さ（h）を、集めた行の数に合わせ、高さが変わったぶんだけ、下にあるものを動かす。伸びたら下げ、縮んだら上げる。
 * 動かす相手は、押し下げ（growthPush）と同じ選び方。帯の、変わる前の下の端より下から始まり、横が重なるまとまりのうち、いちばん上のものの高さから下を、横の列も含めて全部。
 * 動かす量は、「動かす相手の先頭の段（いちばん上の高さから始まるまとまり）の上にあって、横が重なる、動かさない要素（帯、セクション、場所をふさぐ要素）の、
 * いちばん下の端」が変わったぶん。
 * WHY 帯ごとの伸び縮みで動かさない: 帯は横に並べて置く（決定事項、ToDo、未決）。背の低い帯が 1 行伸びるたびに下を動かすと、いちばん背の高い帯と下の段の間が、
 * ほかの帯の行の数で変わる。いちばん下の端を基準にすれば、その端と下の段の間が保たれ、行が元の数に戻れば、下の段も元の場所に戻る。
 * いちばん下の端が変わらなくても、伸びた帯が、すぐ下の相手に重なるときは、重ならない所まで下げる（前から、ほかの要素と重なって置かれていた相手に起きる）
 */
function settleSummaries(els: readonly El[]): { els: El[]; changed: string[] } {
  if (!els.some((e) => e.type === "summary")) return { els: [...els], changed: [] };
  const rows = collect(els);
  const work = [...els];
  const index = new Map(work.map((e, i) => [e.id, i]));
  const changed = new Set<string>();
  const put = (next: El): void => {
    const i = index.get(next.id);
    if (i === undefined) return;
    work[i] = next;
    changed.add(next.id);
  };
  for (const { id } of els.filter((e) => e.type === "summary")) {
    // 先に見た帯が、この帯を動かしていることがあるので、今の形を読み直す
    const band = work[index.get(id) ?? -1];
    const h = band ? summaryHeight(itemsOf(rows, band).length) : 0;
    if (!band || band.h === h) continue;
    // 高さの無い帯（前の版で書いた帯）は、高さを書くだけで、下は動かさない。
    // WHY: 前の版は高さを書かなかったので、書かれていた配置は、今の行の数の高さに合わせて置かれている（帯の下を、行のぶん空けてある）
    if (band.h === undefined) {
      put({ ...band, h });
      continue;
    }
    const before = boxOf(band);
    // WHY 帯を書き換える前にまとまりを取る: まとまりは、中心がセクションの中にあるかで中身を見分ける
    const others = unitsOf(work).flatMap((u) => (u.head === id ? [] : [{ ...u, ids: u.ids.filter((i) => i !== id) }]));
    put({ ...band, h });
    if (!before) continue;
    const after = { ...before, h };
    const bottom = before.y + before.h;
    const across = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w;
    const starts = others.filter((u) => u.box.y >= bottom && across(u.box, after));
    if (starts.length === 0) continue;
    const threshold = Math.min(...starts.map((u) => u.box.y));
    const moving = others.filter((u) => u.box.y >= threshold);
    // 先頭の段は、動かす相手のうち、いちばん上の高さから始まるもの全部（帯と横が重ならない列のものも）
    const front = moving.filter((u) => u.box.y === threshold);
    const isBand = (u: Unit): boolean => work[index.get(u.head) ?? -1]?.type === "summary";
    // 基準の端に入れるのは、伸び縮みした帯と、先頭の段の上にあって、先頭の段と横が重なる、ほかの帯だけ。
    // WHY 帯でない要素を入れない: 帯の横の、関係の無い列の要素（下の端が深い付箋やセクション）が入ると、帯が伸びても下が動かなくなる。
    // 帯と下の相手の間にある帯でない要素は、動かす相手に入るので、基準に要らない
    const above = others.filter((u) => u.box.y < threshold && isBand(u) && front.some((f) => across(u.box, f.box)));
    const edge = (own: Box): number => Math.max(own.y + own.h, ...above.map((u) => u.box.y + u.box.h));
    const byEdge = edge(after) - edge(before);
    // 上げるときは、いちばん下の端より上へは上げず、動かさない要素（線・コメント・座標の矢印のほか）に重なる所の手前で止める
    const blocking = others.filter((u) => u.box.y < threshold && (u.kind !== "other" || isBand(u)));
    const room = Math.max(-Infinity, ...moving.flatMap((m) => blocking.filter((o) => across(o.box, m.box) && o.box.y < m.box.y).map((o) => o.box.y + o.box.h - m.box.y)));
    const dy = h > before.h ? Math.max(byEdge, after.y + after.h - threshold, 0) : Math.max(byEdge, Math.min(0, edge(after) - threshold), Math.min(0, room));
    if (dy === 0) continue;
    const moved = new Set(moving.flatMap((u) => u.ids));
    // 動かした要素を指しているコメントは、一緒に動かす
    for (const el of [...work]) {
      if (moved.has(el.id) || (el.type === "comment" && el.on !== undefined && moved.has(el.on))) put(shifted(el, 0, dy));
    }
  }
  return { els: work, changed: [...changed] };
}

/** セクションの中で、左上から順に、ほかの中身と重ならない最初の場所を返す */
function placeInside(els: El[], container: El, size: { w: number; h: number }): Point {
  const c = boxOf(container) ?? { x: 0, y: 0, w: 0, h: 0 };
  const left = c.x + PAD;
  const top = c.y + sectionTop(container);
  const right = Math.max(c.x + c.w - PAD, left + size.w);
  const taken: Box[] = [];
  for (const m of membersOf(els, container)) {
    // 範囲を囲むコメントは、付箋の上に重ねて置くもの。場所をふさいでいるとは数えない
    if (m.type === "comment") continue;
    const b = boxOf(m);
    if (b) taken.push(b);
  }
  const xs = [left, ...taken.map((b) => b.x + b.w + GAP)].sort((a, b) => a - b);
  const ys = [top, ...taken.map((b) => b.y + b.h + GAP)].sort((a, b) => a - b);
  for (const y of ys) {
    for (const x of xs) {
      if (x < left || y < top || x + size.w > right + 0.5) continue;
      const cand = { x, y, ...size };
      if (!taken.some((b) => overlaps(cand, b, GAP - 1))) return [x, y];
    }
  }
  return [left, top];
}

// ---- 操作 ----

export interface Applied {
  doc: Doc;
  added: El[];
  updated: El[];
  removed: El[];
  titleChanged: boolean;
  /** 重なり順が変わったときだけ。全要素の id を、背面から前面の順に並べたもの */
  order?: string[];
}

const NEEDS_PLACE: readonly ElType[] = ["shape", "container", "text", "table", "image", "gantt", "summary"];

/** 操作をした人と時刻。コメントのやりとり（say）に書き込む */
export interface OpsContext {
  by: (typeof SPEAKERS)[number];
  at: string;
}

export interface CommentPayload {
  kind: "comment";
  id: string;
  /** 今回送った本文（いちばん新しい、人のやりとり） */
  text: string;
  /** それより前のやりとり */
  thread: Message[];
  resolved: boolean;
  anchor: { type: "area"; x: number; y: number; w: number; h: number } | { type: "pin"; x: number; y: number; on?: string };
  /** 枠の中にある要素（ピンなら、指している要素）。Claude がボードを読み直さずに答えられるように、文字を付ける */
  elements: Record<string, unknown>[];
}

const TEXT_FIELDS = ["text", "tag", "title", "question", "answer", "who", "status", "carriedFrom", "due", "show", "label", "head", "rows", "color", "shape", "bars", "marks"] as const;

function briefOf(el: El): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...el };
  const out: Record<string, unknown> = { id: el.id, type: el.type };
  for (const k of TEXT_FIELDS) if (rec[k] !== undefined) out[k] = rec[k];
  return out;
}

/** コメント 1 件を Claude に届ける中身 */
export function commentPayload(doc: Doc, id: string): Res<CommentPayload> {
  const c = doc.elements.find((e) => e.id === id);
  if (!c || c.type !== "comment") return fail(`コメントが無い: ${id}`);
  const thread = c.thread ?? [];
  const last = thread.findLastIndex((m) => m.by === "human");
  const text = thread[last]?.text;
  if (text === undefined) return fail("送る本文が無い");
  const x = c.x ?? 0;
  const y = c.y ?? 0;
  const area = c.w !== undefined && c.h !== undefined ? { x, y, w: c.w, h: c.h } : null;
  const inside = (e: El): boolean => {
    if (e.type === "comment" || e.type === "container") return false;
    const b = boxOf(e);
    return area !== null && b !== null && centerIn(b, area);
  };
  const elements = doc.elements.filter((e) => (area ? inside(e) : e.id === c.on)).map(briefOf);
  return ok({
    kind: "comment",
    id,
    text,
    thread: thread.slice(0, last),
    resolved: c.resolved === true,
    anchor: area ? { type: "area", ...area } : { type: "pin", x, y, ...(c.on === undefined ? {} : { on: c.on }) },
    elements,
  });
}

export function applyOps(base: Doc, ops: unknown, ctx: OpsContext = { by: "claude", at: "" }): Res<Applied> {
  if (!Array.isArray(ops)) return fail("ops は配列で書く");
  const doc: Doc = structuredClone(base);
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const addedIds = new Set<string>();
  const updatedIds = new Set<string>();
  const removed = new Map<string, El>();
  let titleChanged = false;
  let reordered = false;

  const replace = (el: El): void => {
    byId.set(el.id, el);
    const i = doc.elements.findIndex((e) => e.id === el.id);
    if (i >= 0) doc.elements[i] = el;
    else doc.elements.push(el);
  };

  const remove = (id: string): void => {
    const el = byId.get(id);
    if (!el) return;
    byId.delete(id);
    doc.elements = doc.elements.filter((e) => e.id !== id);
    if (addedIds.has(id)) addedIds.delete(id);
    else removed.set(id, el);
    updatedIds.delete(id);
    detach(id);
    // 消したセクションに in で足した要素は、位置で読む。
    // WHY: 控えに残すと、同じまとまりで同じ場所に置いた別のセクションの中身にもならず、並べられないまま残る
    kept.delete(id);
  };

  /** 変えた要素を、返事の updated に入れる。このまとまりで足した要素は、added で返るので入れない */
  const touch = (id: string): void => {
    if (!addedIds.has(id)) updatedIds.add(id);
  };

  /** まとまりを、dy だけ下へずらす */
  const pushDown = (push: { units: Unit[]; dy: number } | null): void => {
    for (const id of push?.units.flatMap((u) => u.ids) ?? []) {
      const el = byId.get(id);
      if (!el) continue;
      replace(shifted(el, 0, push?.dy ?? 0));
      touch(id);
    }
  };
  /** まとまりを、dx だけ右へずらす */
  const pushRight = (push: { units: Unit[]; dx: number } | null): void => {
    for (const id of push?.units.flatMap((u) => u.ids) ?? []) {
      const el = byId.get(id);
      if (!el) continue;
      replace(shifted(el, push?.dx ?? 0, 0));
      touch(id);
    }
  };
  /** セクション id のほかの、まとまり */
  const unitsBut = (id: string): Unit[] => unitsOf(doc.elements).filter((u) => u.head !== id);

  /**
   * 列で並べるセクションの id ごとの、次の並べ直し（settle）が、位置に関わらず、そのセクションの中身と読む要素の id。
   * in で足して、まだ仮の場所にある要素と、set でその場で高さが増えた中身。
   * WHY 高さが増えた中身も: 中心が、伸びる前の枠の下に出ることがある。
   * 足した後に消すか、座標を書いて動かした要素は、ここから外す。消したセクションのぶんは、丸ごと外す。
   */
  const kept = new Map<string, string[]>();
  const detach = (id: string): void => {
    for (const [section, ids] of kept) kept.set(section, ids.filter((x) => x !== id));
  };
  const isKept = (id: string): boolean => [...kept.values()].some((ids) => ids.includes(id));
  const keep = (section: string, ids: readonly string[]): void => {
    kept.set(section, [...new Set([...(kept.get(section) ?? []), ...ids])]);
  };
  /** 前の並べ直しの後に、場所を書いた要素（座標を書いた add、x・y を変えた set）。並べ直しが、書いた場所から並ぶ順を決める */
  const placed = new Set<string>();
  /**
   * このまとまりで、もう動かした要素。set が x・y を変えた要素と、セクションの set が連れていった要素。
   * 後からセクションか、指す先の要素を動かしても、もう一度は連れていかない
   */
  const relocated = new Set<string>();

  /**
   * このまとまりで、場所を決めたセクション（足した、x・y・w を変えた、cols を書いた）の id と、その操作の番号。
   * まとまりの最後に、列で並べるセクションと、ほかのセクションの重なりを、これらについて確かめる。
   * WHY 操作ごとに確かめない: 画面は、選んだセクションを 1 つずつ set で送る。2 つを一緒に少し動かすと、途中では重なる
   */
  const sited = new Map<string, string>();

  /** 列で並べるセクションを並べ直し、まとめの帯の高さを合わせる。位置を読む操作の前と、まとまりの最後に呼ぶ */
  const settle = (): void => {
    const r = arrangeCols(doc.elements, kept, placed);
    // WHY 並べ直しの後: 並べ直しで伸びたセクションが、帯を押し下げていることがある。帯の高さは、付箋の状態だけで決まり、並べ直しでは変わらない
    const s = settleSummaries(r.els);
    doc.elements = s.els;
    for (const el of s.els) byId.set(el.id, el);
    for (const id of [...r.changed, ...s.changed]) touch(id);
    reordered ||= r.reordered;
    kept.clear();
    placed.clear();
  };
  /**
   * 今の位置を読んで場所を決める操作か。その前に、列で並べるセクションを並べ直す。
   * WHY 操作 1 つごとに並べ直さない: セクションだけ動かした、空の枠を足してまだ中身を置いていない、という途中の状態を並べ直すと、後ろの操作と食い違う。
   * 並べ直しを後回しにするのは、場所を今の位置から決めない操作（cols のセクションへの in、座標を書いた add、set、rm、order、title、say）が続く間だけ。
   * set は、伸びた付箋の下の中身と、動かすセクションの枠の中を、並べ直す前の位置で読む。in で足して仮の場所にある要素は、伸びの処理から除いてある。
   */
  const readsLayout = (op: Record<string, unknown>): boolean => {
    // 型は、場所を書かなければ、全体の右に置く
    if (op.op === "template" || op.op === "format") return true;
    // cols を外すと、in で足した要素を並べる機会が無くなる
    if (op.op === "set") return isRecord(op.patch) && op.patch.cols === null;
    if (op.op !== "add" || !isRecord(op.el)) return false;
    // コメントは、指す要素の、並べ終わった場所に書かれる
    if (op.el.type === "comment") return true;
    if (!isOneOf(NEEDS_PLACE, op.el.type) || (op.el.x !== undefined && op.el.y !== undefined)) return false;
    // 場所を書かない add（above、cols の無いセクションへの in、全体の右）。cols のセクションへの in だけは、場所を並べ直しが決めるので、位置を読まない
    return (typeof op.in === "string" ? byId.get(op.in) : undefined)?.cols === undefined;
  };

  // 型（template）は、要素を足す操作の並びに展開して、その場に差し込む。labels は、エラーに出す操作の番号（渡された並びでの番号）
  const queue: unknown[] = [...ops];
  const labels = ops.map((_, i) => `ops[${i}]`);
  for (let i = 0; i < queue.length; i++) {
    const op = queue[i];
    const at = labels[i] ?? `ops[${i}]`;
    if (!isRecord(op)) return fail(`${at}: 操作はオブジェクトで書く`);
    if (readsLayout(op)) settle();
    switch (op.op) {
      case "add": {
        if (!isRecord(op.el)) return fail(`${at}: add には el（要素）が要る`);
        const raw: Record<string, unknown> = { ...op.el };
        if (raw.id === undefined) {
          do doc.seq += 1;
          while (byId.has(`e${doc.seq}`));
          raw.id = `e${doc.seq}`;
        } else if (typeof raw.id === "string" && byId.has(raw.id)) {
          return fail(`${at}: id ${raw.id} はもうある。直すなら set を使う`);
        }
        const type = isOneOf(TYPES, raw.type) ? raw.type : null;
        if (type === "shape" && raw.shape === undefined) raw.shape = "note";
        // 既定の大きさが無い種類もあるので、全部の種類で引ける型で読む
        const sizes: Partial<Record<ElType, { w: number; h: number }>> = DEFAULT_SIZE;
        const def = type ? sizes[type] : undefined;
        if (def) {
          raw.w ??= def.w;
          raw.h ??= def.h;
        }
        if (type === "summary") {
          raw.w ??= SUMMARY_W;
          // まとめの帯の高さは、集めた行の数から決まる。書かれた h は使わず、今の行の数からの高さにする。
          // WHY: 書かれた h を変わる前の高さと読むと、まとまりの最後に、下にあるものを、行の数と関係ない量だけ動かす。
          // 足す時点で高さを入れるのは、場所を書かない add と above が、本当の大きさで場所を決めるため
          const show = parseShow(raw.show);
          raw.h = summaryHeight(show.ok ? rowsFor(collect(doc.elements), show.value).length : 0);
          if (op.in !== undefined) return fail(`${at}: まとめの帯（summary）は、in でセクションに足せない。セクションの外に置く（x・y を書くか、何も書かずに全体の右へ置く）`);
        }
        let grown: El | null = null;
        // 置いた後に下へずらすもの。新しい要素を入れる前のまとまりで決める（新しい要素が、重なった先の中身に数えられないように）
        let push: { units: Unit[]; dy: number } | null = null;
        /** in で、自由なセクションが右へ広がったときの、広がる前と後の枠 */
        let widen: { id: string; before: Box; after: Box } | null = null;
        // 列で並べるセクションに in で足すときの、そのセクションの id
        let intoCols: string | null = null;
        place: if (type && NEEDS_PLACE.includes(type)) {
          const hasPos = raw.x !== undefined && raw.y !== undefined;
          const hints = [hasPos, op.in !== undefined, op.above !== undefined].filter(Boolean).length;
          if (hints > 1) return fail(`${at}: x・y と in と above は、どれか 1 つだけ書く`);
          if (!hasPos) {
            raw.x = 0;
            raw.y = 0;
            const probe = parseEl(raw);
            if (!probe.ok) return fail(`${at}: ${probe.error}`);
            const size = sizeOf(probe.value);
            if (op.in !== undefined) {
              const c = typeof op.in === "string" ? byId.get(op.in) : undefined;
              if (!c || c.type !== "container") return fail(`${at}: in のセクションが無い: ${JSON.stringify(op.in)}`);
              const cb = boxOf(c) ?? { x: 0, y: 0, w: 0, h: 0 };
              if (c.cols !== undefined) {
                if (type === "container") return fail(`${at}: cols のあるセクション（${c.id}）に、in でセクションは足せない。cols はセクションを並べない`);
                // 場所は、次の並べ直し（settle）が決める。ここでは、中身を置き始める場所に仮に置き、このセクションに足したと控える。
                // WHY セクションを仮に伸ばさない: 伸ばした枠に、下にあった別の要素が入って、中身に数えられる
                raw.x = cb.x + PAD;
                raw.y = cb.y + sectionTop(c);
                intoCols = c.id;
                break place;
              }
              const [x, y] = placeInside(doc.elements, c, size);
              raw.x = x;
              raw.y = y;
              const w = Math.max(cb.w, x + size.w + PAD - cb.x);
              const h = Math.max(cb.h, y + size.h + PAD - cb.y);
              if (w !== cb.w || h !== cb.h) grown = { ...c, w, h };
              if (grown) push = growthPush(unitsBut(c.id), cb, { ...cb, w, h }, OUTER_GAP);
              if (grown && w > cb.w) widen = { id: c.id, before: cb, after: { ...cb, w, h } };
            } else if (op.above !== undefined) {
              const units = unitsOf(doc.elements);
              const target = units.find((u) => typeof op.above === "string" && u.ids.includes(op.above));
              if (!target) return fail(`${at}: above の要素が無い: ${JSON.stringify(op.above)}`);
              raw.x = target.box.x;
              raw.y = target.box.y;
              push = { units: units.filter((u) => u.box.y >= target.box.y), dy: size.h + OUTER_GAP };
            } else {
              const b = boundsOf(doc.elements);
              raw.x = b ? b.x + b.w + OUTER_GAP : 0;
              raw.y = b ? b.y : 0;
            }
          }
        } else if (op.in !== undefined || op.above !== undefined) {
          return fail(`${at}: ${String(raw.type)} に in と above は使えない`);
        }
        const r = parseEl(raw);
        if (!r.ok) return fail(`${at}: ${r.error}`);
        pushDown(push);
        // 右へも伸びたら、右のものをずらす。下へずらした後のまとまりで見る（下へずれたものは、縦の範囲が重ならない）
        // 足した要素は、まだボードに無いので、ずらすものに入らない
        if (widen) {
          const { id, before, after } = widen;
          pushRight(growthPushRight(unitsBut(id), before, after, OUTER_GAP));
        }
        replace(r.value);
        addedIds.add(r.value.id);
        if (r.value.type === "container") sited.set(r.value.id, at);
        if (intoCols !== null) keep(intoCols, [r.value.id]);
        if (op.el.x !== undefined && op.el.y !== undefined) placed.add(r.value.id);
        if (grown) {
          replace(grown);
          touch(grown.id);
        }
        break;
      }
      case "set": {
        const el = typeof op.id === "string" ? byId.get(op.id) : undefined;
        if (!el) return fail(`${at}: id ${JSON.stringify(op.id)} の要素が無い`);
        if (!isRecord(op.patch)) return fail(`${at}: set には patch（変える項目）が要る`);
        const merged: Record<string, unknown> = { ...el };
        for (const [k, v] of Object.entries(op.patch)) {
          if (k === "id" || k === "type") return fail(`${at}: ${k} は変えられない`);
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        const r = parseEl(merged);
        if (!r.ok) return fail(`${at}: ${r.error}`);
        // 列で並べるセクションの高さは、中身から決まる。set で書かれた h は捨てる（cols を初めて書く set でも同じ）。
        // WHY: 書かれた h で枠を広げると、並べ直しが、下にあった外の要素を中身と読む
        if (r.value.cols !== undefined) r.value.h = el.h;
        // まとめの帯の高さも同じ（集めた行の数から決まる）。今の h のままにして、まとまりの最後に合わせる
        if (r.value.type === "summary") {
          if (el.h === undefined) delete r.value.h;
          else r.value.h = el.h;
        }
        const before = el.type === "container" ? boxOf(el) : null;
        const after = boxOf(r.value);
        if (before && after && (before.x !== after.x || before.y !== after.y || before.w !== after.w || (el.cols === undefined && r.value.cols !== undefined))) sited.set(el.id, at);
        // セクションの下の端を set で下げたときも、in で伸びたときと同じに、下のものをずらす
        if (before && after && before.x === after.x && before.y === after.y && after.h > before.h) pushDown(growthPush(unitsBut(el.id), before, after, OUTER_GAP));
        // 右の端を set で右へ広げたときも、同じ考え方で、右のものをずらす。縮んだときは、左へ詰めない（詰めるのは format）
        if (before && after && before.x === after.x && before.y === after.y && after.w > before.w) pushRight(growthPushRight(unitsBut(el.id), before, { ...after, h: Math.max(before.h, after.h) }, OUTER_GAP));
        // セクションの中の要素が下へ伸びたら（h を増やした、文字や行が増えた）、同じセクションの、その下にある中身を押し下げる。
        // 入りきらなくなったら、セクションも伸ばす。WHY: 文字が小さいという検査の指摘を、箱を大きくするだけで直せるようにする
        const old = boxOf(el);
        // in で足して仮の場所にある要素（kept）は飛ばす。WHY: 中心が、別のセクションの枠に入っていることがある
        if (isSolid(el) && !isKept(el.id) && old && after && old.x === after.x && old.y === after.y && after.h > old.h) {
          const section = doc.elements.find((c) => c.type === "container" && membersOf(doc.elements, c).some((m) => m.id === el.id));
          const sb = section ? boxOf(section) : null;
          // 列で並べるセクションの中身は、並べ直しが行の高さから置き直し、セクションも伸ばす。伸びた要素は、そのセクションの中身のままにする。
          // WHY ここで伸ばさない: ここの押し下げは、下の端にかかっていた外の要素を残すので、その要素が、伸びた枠に入って中身になる
          const home = doc.elements.find((c) => c.cols !== undefined && membersOf(doc.elements, c).some((m) => m.id === el.id));
          if (home) keep(home.id, [el.id]);
          if (section && sb && section.cols === undefined) {
            // WHY 中身をずらす前にまとまりを取る: ずらした後だと、枠から出た中身が、セクションの外の要素と読まれて、もう一度押し下げられる
            const outside = unitsBut(section.id);
            // 同じセクションの、ほかの中身。in で足して仮の場所にある要素は、このセクションの中身ではないので除く
            const mates = membersOf(doc.elements, section).flatMap((m): Unit[] => {
              const box = m.id === el.id || isKept(m.id) ? null : boxOf(m);
              return box ? [{ head: m.id, box, ids: [m.id], kind: "solid" }] : [];
            });
            // 真下のものだけでなく、その高さから下にある中身を全部ずらす。横に並んだ付箋の上をそろえたままにするため
            const push = growthPush(mates, old, after, GAP);
            pushDown(push);
            const pushed = new Set(push?.units.map((u) => u.head));
            const bottom = Math.max(after.y + after.h, ...mates.map((u) => u.box.y + u.box.h + (pushed.has(u.head) ? (push?.dy ?? 0) : 0)));
            const need = bottom + PAD - sb.y;
            if (need > sb.h) {
              pushDown(growthPush(outside, sb, { ...sb, h: need }, OUTER_GAP));
              replace({ ...section, h: need });
              touch(section.id);
            }
          }
        }
        const moved = old && after && (old.x !== after.x || old.y !== after.y) ? { dx: after.x - old.x, dy: after.y - old.y } : null;
        // 列で並べるセクションを動かしたら、この set の時点で枠の中にある要素（中のセクションは、その中身も）を、同じ量だけ一緒に動かす。
        // WHY: 中身を置き去りにすると、並べ直しが、空のセクションと読んで畳む。
        // WHY このまとまりでもう動かした要素は連れていかない: 画面は、選んだ順に、セクションと中身を絶対座標の set で送る。中身の set が先に来ると、2 回動く。
        // セクションを 2 つ動かすと、先のセクションが連れていった中身が、後のセクションの動かす前の枠に入って、2 回動く
        const within = moved && el.type === "container" && el.cols !== undefined ? ridersOf(doc.elements, el) : [];
        const riders = new Set(within.map((e) => e.id).filter((id) => !relocated.has(id)));
        replace(r.value);
        touch(el.id);
        if (moved) {
          const carry = (e: El): void => {
            replace(shifted(e, moved.dx, moved.dy));
            touch(e.id);
          };
          for (const id of riders) {
            const m = byId.get(id);
            if (m) carry(m);
            relocated.add(id);
          }
          // この要素と、一緒に動かした中身を指しているコメントは、同じぶんだけ動かす。
          // このまとまりでもう動かしたコメントは動かさない（画面は、選んだ要素とコメントを、どちらも絶対座標の set で送る。2 回動く）
          // コメントを指すコメントは、動かさない
          const led = el.type === "comment" ? new Set<string>() : new Set([el.id, ...riders]);
          for (const c of doc.elements.filter((e) => e.type === "comment" && e.on !== undefined && led.has(e.on) && !riders.has(e.id) && !relocated.has(e.id))) carry(c);
          // 場所を書いた要素は、in で足した控えから外し、書いた場所から、中身かどうかと並ぶ順を読む
          detach(el.id);
          placed.add(el.id);
          relocated.add(el.id);
        }
        break;
      }
      case "say": {
        const el = typeof op.id === "string" ? byId.get(op.id) : undefined;
        if (!el || el.type !== "comment") return fail(`${at}: id ${JSON.stringify(op.id)} のコメントが無い`);
        if (typeof op.text !== "string" || op.text.trim() === "") return fail(`${at}: say には text（本文）が要る`);
        // WHY 専用の操作: set で thread を丸ごと書き直すと、同時に書かれた相手のやりとりを消す
        replace({ ...el, thread: [...(el.thread ?? []), { by: ctx.by, at: ctx.at, text: op.text.trim() }] });
        touch(el.id);
        break;
      }
      case "rm": {
        if (typeof op.id !== "string" || !byId.has(op.id)) return fail(`${at}: id ${JSON.stringify(op.id)} の要素が無い`);
        remove(op.id);
        break;
      }
      case "compact":
        // compact は format に統合した。前に書かれた手順のために、案内だけを残す
        return fail(`${at}: compact は format に統合した。xwb format を使う（apply では {"op":"format"}。中身より背の高いセクションを縮めてから揃える）`);
      case "format": {
        // 中身より背の高い自由なセクションを縮めてから、セクションとまとめの帯を、揃える（既定）か組み直す（rebuild）。置き場所は shared/format.ts が決める。ここは、その結果を書くだけ。
        // 動かした要素は、場所を書いた要素（placed）に入れない。WHY: 列で並べるセクションは中身ごと同じだけ動くので、並ぶ順を位置から読み直す理由が無い
        const plan = formatOp(doc.elements, op);
        if (!plan.ok) return fail(`${at}: ${plan.error}`);
        for (const el of plan.value.moved) {
          replace(el);
          touch(el.id);
          if (el.type === "container") sited.set(el.id, at);
        }
        break;
      }
      case "order": {
        // elements の並びが重なり順。後ろにあるほど前面に描く（セクションは種類として常に背面、線とコメントは常に前面）
        const el = typeof op.id === "string" ? byId.get(op.id) : undefined;
        if (!el) return fail(`${at}: id ${JSON.stringify(op.id)} の要素が無い`);
        if (op.to !== "front" && op.to !== "back") return fail(`${at}: to は front | back のどちらか`);
        const rest = doc.elements.filter((e) => e.id !== el.id);
        doc.elements = op.to === "front" ? [...rest, el] : [el, ...rest];
        reordered = true;
        break;
      }
      case "template": {
        // 場所を書かなければ、全体の右に置く。id を書かなければ、tp に連番を付けて振る
        const b = boundsOf(doc.elements);
        // WHY 番号を使い回さない: 消した型と同じ id を振ると、人が消した記録（pending）が、別の中身を「直した」記録に化ける。
        // 要素の連番（doc.seq）を進めて使う。
        // WHY 尾の付いた id も見る: 型は「tp3-l」のように尾を付けた id の要素だけを足し、「tp3」という id の要素は作らない
        const used = (n: number): boolean => doc.elements.some((e) => e.id === `tp${n}` || e.id.startsWith(`tp${n}-`));
        if (op.id === undefined) {
          do doc.seq += 1;
          while (used(doc.seq));
        }
        const expanded = expandTemplate(op, b ? [b.x + b.w + OUTER_GAP, b.y] : [0, 0], `tp${doc.seq}`);
        if (!expanded.ok) return fail(`${at}: ${expanded.error}`);
        queue.splice(i + 1, 0, ...expanded.value);
        labels.splice(i + 1, 0, ...expanded.value.map(() => `${at}（${String(op.kind)} の展開）`));
        break;
      }
      case "restore": {
        // 画面の「元に戻す」が送る（shared/restore.ts の restoreOp）。書かれた形を、そのまま書く。
        // rm（消す id）、add（足し直す要素）、set（要素ごとの、項目と値。null は項目を消す）、order（要素の並び）の順に当てる。members は下に書く。
        // WHY 専用の操作: 「元に戻す」は、変える前の形を全部知っている。set で送ると、押し下げと、中身を連れていく処理が働いて、書いた形にならない。
        // まとまりの最後の並べ直しは、ほかの操作と同じに働く。並べ終わった形を書けば、何も変わらない。
        // WHY 並べ直す: 操作を積んだ後にエージェントが中身を変えていると、書いた形は、今の中身と合わない（付箋が重なる）。
        // members は、列で並べるセクションの id ごとの、書く形での中身の id。
        // 並べ直しは、members に書いた要素（この操作が場所を書いたもの）と、この操作の直前に中身だった要素を、位置に関わらず、そのセクションの中身と読む。
        // WHY: 積んだ後にエージェントが足した付箋は、セクションの場所、列の数、高さを前の形へ書くと、中心が枠の外になる。
        // 直前に中身だった要素のうち、この操作が場所を書いて、members に入れなかった要素は、外へ戻した要素なので、位置で読む
        // もう無い要素への rm と set、もうある要素の add は飛ばす。
        // WHY: 操作を積んだ後に、エージェントやほかの画面が消していることがある。断ると、戻せるはずの残りまで戻らない
        const part = (k: string): unknown[] | null => (op[k] === undefined ? [] : Array.isArray(op[k]) ? op[k] : null);
        const [rms, adds, sets, order] = [part("rm"), part("add"), part("set"), part("order")];
        if (!rms || !adds || !sets || !order) return fail(`${at}: restore の rm・add・set・order は配列で書く`);
        const members = op.members ?? {};
        if (!isRecord(members) || Object.values(members).some((ids) => !Array.isArray(ids))) return fail(`${at}: restore の members は { セクションの id: [中身の id] } で書く`);
        const arrangedNow = doc.elements.filter((e) => e.type === "container" && e.cols !== undefined);
        const prior = new Map(arrangedNow.map((c) => [c.id, membersOf(doc.elements, c).flatMap((m) => (isSolid(m) ? [m.id] : []))]));
        /** この操作の直前の、セクションの高さ */
        const heights = new Map(doc.elements.flatMap((e): [string, number][] => (e.type === "container" && e.h !== undefined ? [[e.id, e.h]] : [])));
        /** この操作が書いた要素と、そのうち、場所を書いた要素 */
        const written = new Set<string>();
        const sitedHere = new Set<string>();
        for (const id of rms) if (typeof id === "string") remove(id);
        const back: El[] = [];
        for (const raw of adds) {
          const r = parseEl(raw);
          if (!r.ok) return fail(`${at}: ${r.error}`);
          if (byId.has(r.value.id)) continue;
          replace(r.value);
          addedIds.add(r.value.id);
          back.push(r.value);
          written.add(r.value.id);
          sitedHere.add(r.value.id);
        }
        // 足し直した矢印の端が、もう無ければ、その矢印は足さない
        for (const el of back) if ([el.from, el.to].some((end) => typeof end === "string" && !byId.has(end))) remove(el.id);
        for (const item of sets) {
          if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.patch)) return fail(`${at}: restore の set は { id, patch } で書く`);
          const el = byId.get(item.id);
          if (!el) continue;
          const merged: Record<string, unknown> = { ...el };
          for (const [k, v] of Object.entries(item.patch)) {
            if (k === "id" || k === "type") return fail(`${at}: ${k} は変えられない`);
            if (v === null) delete merged[k];
            else merged[k] = v;
          }
          const r = parseEl(merged);
          if (!r.ok) return fail(`${at}: ${r.error}`);
          // まとめの帯の高さは、書かない（add・set と同じ）。いつも、集めた行の数から決まる。
          // WHY: 操作を積んだ後に行の数が変わっていると、戻す前の高さを書いた後の並べ直しが、伸びたと読んで、下をもう一度押し下げる
          if (r.value.type === "summary") {
            if (el.h === undefined) delete r.value.h;
            else r.value.h = el.h;
          }
          replace(r.value);
          touch(el.id);
          written.add(el.id);
          if ("x" in item.patch || "y" in item.patch) sitedHere.add(el.id);
        }
        // まとめの帯の高さを、戻した付箋の状態からの行の数に合わせる。下は動かさない（戻す操作が、動いた要素の場所を書いている）。
        // WHY ここで合わせる: まとまりの最後の並べ直しに任せると、高さの変わったぶん、戻した場所から、下をもう一度動かす
        const rows = collect(doc.elements);
        /** 帯の id ごとの、高さを合わせる前の高さ。伸びた帯だけ */
        const grown = new Map<string, number>();
        for (const band of doc.elements.filter((e) => e.type === "summary")) {
          const h = summaryHeight(itemsOf(rows, band).length);
          if (band.h === h) continue;
          if (band.h !== undefined && h > band.h) grown.set(band.id, band.h);
          replace({ ...band, h });
          touch(band.id);
        }
        // 下の要素に重なる帯は、重なった要素から下を押し下げる。見るのは、次の 2 つ。
        // 場所を書いて戻した帯（足し直した帯は除く）: 戻した場所で、帯の上の端より下から始まる要素。
        // WHY: 操作を積んだ後に、帯の行が増えていることがある（人が帯を動かしている間に、エージェントが付箋の状態を変える）。
        // 帯が元の場所にいなかったので、下は押し下げられていない。そのまま戻すと、伸びた帯が下に重なる。
        // 伸びた帯: 伸びる前の下の端より下から始まる要素。WHY: 足し直した帯が、消した後に増えた行のぶん伸びることがある。
        // 伸びる前の下の端より上は見ない。前から重ねて置かれていた要素まで押し下げると、元に戻らない。
        // 戻す操作が場所を書いた要素は、もう書いた場所にあるので、重ならなければ動かない
        const readded = new Set(back.map((e) => e.id));
        for (const id of new Set([...[...sitedHere].filter((x) => !readded.has(x)), ...grown.keys()])) {
          const band = byId.get(id);
          const bb = band?.type === "summary" ? boxOf(band) : null;
          if (!bb) continue;
          // 場所を戻した帯は、上の端が同じ要素も見る（その間に、帯の空けた場所へ、エージェントが上をそろえて要素を足していることがある）
          const from = sitedHere.has(id) && !readded.has(id) ? bb.y : bb.y + (grown.get(id) ?? 0);
          const others = unitsBut(id);
          const inside = others.filter((u) => (u.kind !== "other" || byId.get(u.head)?.type === "summary") && u.box.y >= from && u.box.y < bb.y + bb.h && u.box.x < bb.x + bb.w && bb.x < u.box.x + u.box.w);
          if (inside.length === 0) continue;
          // いちばん上の重なった要素の高さから下を、帯の下の端から OUTER_GAP 空けた所へ、段ごと押し下げる（growthPush と同じ）。
          // ただし、帯の上の端と同じか上から始まり、帯と横が重ならない要素（帯の横に並ぶ、ほかの帯など）は、帯と同じ段に並んでいるので動かさない
          const top = Math.min(...inside.map((u) => u.box.y));
          const across = (u: Unit): boolean => u.box.x < bb.x + bb.w && bb.x < u.box.x + u.box.w;
          pushDown({ units: others.filter((u) => u.box.y >= top && (u.box.y > bb.y || across(u))), dy: bb.y + bb.h + OUTER_GAP - top });
        }
        // members に書いた要素のうち、この操作が場所を書いた要素と、直前もそのセクションの中身だった要素。
        // WHY 絞る: 積んだ後にエージェントが別の場所へ動かした要素を、大きさを戻すだけの操作が、前のセクションへ引き戻さない
        const membersIn = (section: string): unknown[] => {
          const ids = members[section];
          const here = new Set(prior.get(section));
          return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && (sitedHere.has(id) || (written.has(id) && here.has(id)))) : [];
        };
        for (const { id } of doc.elements.filter((e) => e.type === "container")) {
          // 先に見たセクションの押し下げで動いていることがあるので、今の形を読み直す
          const c = byId.get(id);
          const now = c ? boxOf(c) : null;
          if (!c || !now) continue;
          if (c.cols !== undefined) {
            const mine = membersIn(id);
            const stay = (prior.get(id) ?? []).filter((m) => !(sitedHere.has(m) && !mine.includes(m)));
            keep(id, [...mine, ...stay].flatMap((m) => (typeof m === "string" && isSolid(byId.get(m) ?? c) ? [m] : [])));
          }
          // 高さを戻した枠の、伸びたぶんの中から始まるセクションがあれば、下へずらす。
          // WHY: 積んだ後に、エージェントが、縮んだセクションの下を詰めている（format）か、空いた所にセクションを足していることがある。
          // そのまま高さを戻すと、下のセクションに重なる。
          // セクションだけを見る。WHY: 枠にかかる線や付箋は、前の形でもそこにあったもので、ずらすと元に戻らない
          const h = heights.get(id);
          if (h === undefined || now.h <= h) continue;
          const others = unitsBut(id);
          const covered = (u: Unit): boolean => u.kind === "section" && u.box.y >= now.y + h && u.box.y < now.y + now.h && u.box.x < now.x + now.w && now.x < u.box.x + u.box.w;
          if (others.some(covered)) pushDown(growthPush(others, { ...now, h }, now, OUTER_GAP));
        }
        // order に書いた要素を、書いた順にする。書いていない要素（積んだ後に足された要素）は、今の位置から動かさない
        const want = [...new Set(order)].flatMap((id) => (typeof id === "string" ? (byId.get(id) ?? []) : []));
        const listed = new Set(want.map((e) => e.id));
        let k = 0;
        const sorted = doc.elements.map((e) => (listed.has(e.id) ? (want[k++] ?? e) : e));
        if (sorted.some((e, n) => e.id !== doc.elements[n]?.id)) {
          doc.elements = sorted;
          reordered = true;
        }
        break;
      }
      case "title": {
        if (typeof op.title !== "string") return fail(`${at}: title は文字列`);
        doc.title = op.title;
        titleChanged = true;
        break;
      }
      default:
        return fail(`${at}: op は add | set | rm | title | say | order | template | format のどれか`);
    }
  }

  // 列で並べるセクションを、ほかのセクションに重ねる置き方は断る。相手は、cols の有無を問わない。
  // WHY: 中身は、中心が枠の中にあるかで決まる。重ねると、どちらの中身かを見分けられず、次に動かしたときに、相手の中身まで付いてくる。
  // 見るのは、このまとまりが場所を決めたセクションの、並べ直す前の枠。並べ直しで伸びて届くぶんは、押し下げで離れる。
  // まとまりの前から、どちらかが列で並べるセクションで、重なっていた相手とは、重なったままでも断らない。
  // WHY: 前に書かれたボードには、重なった配置が残っている。断ると、中にセクションのあるセクションを動かせない
  const boxBefore = new Map(base.elements.flatMap((e): [string, Box & { arranged: boolean }][] => {
    const b = e.type === "container" ? boxOf(e) : null;
    return b ? [[e.id, { ...b, arranged: e.cols !== undefined }]] : [];
  }));
  for (const [id, at] of sited) {
    const el = byId.get(id);
    const box = el ? boxOf(el) : null;
    if (!el || !box) continue;
    const was = boxBefore.get(id);
    const other = doc.elements.find((o) => {
      const ob = o.type === "container" && o.id !== id && (el.cols !== undefined || o.cols !== undefined) ? boxOf(o) : null;
      const ow = boxBefore.get(o.id);
      return ob !== null && overlaps(box, ob, 0) && !(was && ow && (was.arranged || ow.arranged) && overlaps(was, ow, 0));
    });
    if (other) return fail(`${at}: セクション ${id} が、セクション ${other.id} に重なる。列で並べるセクション（cols）は、ほかのセクションと重ねて置けない（中身が混ざる）。空いている場所へ動かす`);
  }

  settle();

  // 消えた要素に付いていた矢印は、指す先が無いので一緒に消す
  for (const el of [...doc.elements]) {
    if (el.type !== "arrow") continue;
    for (const end of [el.from, el.to]) {
      if (typeof end !== "string" || byId.has(end)) continue;
      if (removed.has(end)) remove(el.id);
      else return fail(`矢印 ${el.id} の端の要素が無い: ${end}`);
    }
  }

  const pick = (ids: Set<string>): El[] => doc.elements.filter((e) => ids.has(e.id));
  return ok({
    doc,
    added: pick(addedIds),
    updated: pick(updatedIds),
    removed: [...removed.values()],
    titleChanged,
    ...(reordered ? { order: doc.elements.map((e) => e.id) } : {}),
  });
}
