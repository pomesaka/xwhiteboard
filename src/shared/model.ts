// ボードのデータの形と、操作（add・set・rm・title）の適用。
// サーバー、CLI、ブラウザ、変換が同じ規則で要素を検証できるよう、ここだけに置く。
import { GANTT_STATUS, GANTT_UNITS, ganttLayout, parseDay, type GanttBar, type GanttMark, type GanttSegment, type GanttUnit } from "./gantt.ts";
import { isBoardRef, plainText } from "./rich.ts";
import { expandTemplate } from "./template.ts";
import { SIDES, type Side } from "./route.ts";

export const TYPES = ["shape", "container", "text", "arrow", "table", "image", "stroke", "comment", "gantt"] as const;
export const SPEAKERS = ["human", "claude"] as const;
export const COLORS = ["yellow", "orange", "red", "pink", "purple", "blue", "teal", "green", "gray", "white", "ink"] as const;
export const SHAPES = ["note", "rect", "round", "pill", "ellipse", "diamond", "hexagon", "parallelogram", "cylinder", "document", "queue", "cloud"] as const;
export const SIZES = ["s", "m", "l", "xl", "huge"] as const;
export const ALIGNS = ["left", "center", "right"] as const;
export const HEADS = ["end", "start", "both", "none"] as const;
export const ROUTES = ["straight", "elbow"] as const;
/** 付箋の状態。決定、未決、持ち越し、優先 */
export const NOTE_STATUS = ["decided", "open", "carried", "priority"] as const;
export type NoteStatus = (typeof NOTE_STATUS)[number];
export const STATUS_LABEL: Record<NoteStatus, string> = { decided: "決定", open: "未決", carried: "持ち越し", priority: "優先" };
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
  /** 持ち越しの元の会議の日付。札に「11/11 から」と出す。本文に日付を書かないので、同じ日付の繰り返しの検査にかからない */
  carriedFrom?: string;
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
  shape: ["x", "y", "w", "h", "text", "title", "who", "status", "carriedFrom", "tag", "color", "shape", "size", "align", "border", "hollow", "dashed"],
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
};

const DEFAULT_SIZE: Partial<Record<ElType, { w: number; h: number }>> = {
  shape: { w: 220, h: 110 },
  container: { w: 504, h: 160 },
  image: { w: 320, h: 240 },
};

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
      case "carriedFrom":
        if (typeof v !== "string" || parseDay(v, false) === null) return fail("carriedFrom は YYYY-MM-DD か YYYY-MM の日付");
        el.carriedFrom = v;
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
  if (el.carriedFrom !== undefined && el.status !== undefined && el.status !== "carried") return fail("carriedFrom を書くなら、status は carried か、書かない");
  if (type === "image" && (el.src === undefined) === (el.svg === undefined)) return fail("image には src か svg のどちらか 1 つを書く");
  return ok(el);
}

/** 付箋の状態の札に出す文字。状態が無ければ null。持ち越しには、元の日付を付ける（「持ち越し · 11/11 から」） */
export function statusBadge(el: El): { status: NoteStatus; label: string } | null {
  const status = el.status ?? (el.carriedFrom === undefined ? undefined : "carried");
  if (status === undefined) return null;
  const [, month, day] = (el.carriedFrom ?? "").split("-").map(Number);
  const from = month === undefined ? "" : day === undefined ? ` · ${month}月から` : ` · ${month}/${day} から`;
  return { status, label: STATUS_LABEL[status] + from };
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
  // 論点は行の高さ 1.4 と下の間 8。結論は行の高さ 1.5、帯の上下の余白 12、左右の余白 20（「→ 」のぶんを含めて 2 文字ぶん狭い）、下の間 8
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
  const c = boxOf(container);
  if (!c) return [];
  const out: El[] = [];
  for (const el of els) {
    if (el.id === container.id || el.type === "arrow" || el.type === "container") continue;
    const b = boxOf(el);
    if (!b) continue;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    if (cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h) out.push(el);
  }
  return out;
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
    out.push({ head: c.id, box, ids });
  }
  for (const e of els) {
    if (e.type === "container" || claimed.has(e.id)) continue;
    const box = boxOf(e);
    if (box) out.push({ head: e.id, box, ids: [e.id] });
  }
  return out;
}

/** 列で並べるセクション（cols）の、1 列の幅 */
export function colWidth(c: Box, cols: number): number {
  return Math.max(40, Math.floor((c.w - PAD * 2 - GAP * (cols - 1)) / cols));
}

/**
 * 列で並べるセクションの中身を、並べる順にして返す。順番は、今の位置から読む（上の行から、行の中は左から）。
 * WHY 位置から読む: 人がドラッグで入れ替えても、エージェントが座標で置いても、順番を別の項目に書き直さずに済む。
 * 行は、上の端が前の行の下の端より上にあるものをまとめる。背の違う付箋が並んだ行も、1 つの行と読める。
 */
function arrangedOrder(els: El[], container: El): El[] {
  const items = membersOf(els, container).flatMap((m) => {
    const b = isSolid(m) ? boxOf(m) : null;
    return b ? [{ m, b }] : [];
  });
  items.sort((a, b) => a.b.y - b.b.y);
  const rows: (typeof items)[] = [];
  let bottom = -Infinity;
  for (const it of items) {
    const row = rows.at(-1);
    if (row && it.b.y < bottom) row.push(it);
    else rows.push([it]);
    bottom = row && it.b.y < bottom ? Math.max(bottom, it.b.y + it.b.h) : it.b.y + it.b.h;
  }
  return rows.flatMap((row) => row.sort((a, b) => a.b.x - b.b.x).map((it) => it.m));
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

const NEEDS_PLACE: readonly ElType[] = ["shape", "container", "text", "table", "image", "gantt"];

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

const TEXT_FIELDS = ["text", "tag", "title", "question", "answer", "who", "status", "carriedFrom", "label", "head", "rows", "color", "shape", "bars", "marks"] as const;

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
    if (!area || !b) return false;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return cx >= area.x && cx <= area.x + area.w && cy >= area.y && cy <= area.y + area.h;
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
  };

  /** threshold より下から始まるまとまりを、dy だけ下へずらす */
  const pushDown = (units: Unit[], threshold: number, dy: number): void => {
    for (const u of units) {
      if (u.box.y < threshold) continue;
      for (const id of u.ids) {
        const el = byId.get(id);
        if (!el) continue;
        replace(shifted(el, 0, dy));
        if (!addedIds.has(id)) updatedIds.add(id);
      }
    }
  };

  /**
   * セクションが下へ伸びて、下のものに届くなら、その段から下を全部ずらす。
   * WHY 段ごと: 届いたものだけをずらすと、横に並んだセクションの上がそろわなくなる。
   */
  const growthPush = (id: string, before: Box, after: Box, others: Unit[] = unitsOf(doc.elements).filter((u) => u.head !== id)): { units: Unit[]; threshold: number; dy: number } | null => {
    const below = others.filter((u) => u.box.y >= before.y + before.h && u.box.x < after.x + after.w && after.x < u.box.x + u.box.w);
    const threshold = Math.min(...below.map((u) => u.box.y));
    const dy = after.y + after.h + OUTER_GAP - threshold;
    return below.length > 0 && dy > 0 ? { units: others, threshold, dy } : null;
  };

  /**
   * 列の指定（cols）があるセクションの中身を、左上から列に詰めて並べ、セクションの高さを中身に合わせる。
   * 中身が無ければ、題名の帯だけの高さに畳む。
   * WHY 操作のたびに全部を並べ直す: 足す・消す・動かす・幅を変えるのどれでも、同じ規則で詰まった状態に戻すため。
   * 並べ終わった状態にもう一度かけても、何も変わらない。
   */
  const arrange = (id: string): void => {
    const c = byId.get(id);
    const cb = c ? boxOf(c) : null;
    if (!c || !cb || c.cols === undefined) return;
    const put = (old: El, next: El): void => {
      if (JSON.stringify(old) === JSON.stringify(next)) return;
      replace(next);
      if (!addedIds.has(next.id)) updatedIds.add(next.id);
    };
    // WHY 並べる前にまとまりを取る: まとまりは、中心がセクションの中にあるかで中身を見分ける。
    // 並べている途中（中身は動いたが、セクションの高さは古い）や、伸ばした後（下にあった要素が枠に入る）に取ると、見分けを間違える
    const others = unitsOf(doc.elements).filter((u) => u.head !== c.id);
    const ordered = arrangedOrder(doc.elements, c);
    const colW = colWidth(cb, c.cols);
    let y = cb.y + sectionTop(c);
    for (let i = 0; i < ordered.length; i += c.cols) {
      let rowH = 0;
      for (const [k, m] of ordered.slice(i, i + c.cols).entries()) {
        const x = cb.x + PAD + k * (colW + GAP);
        // 画像は、縦横の比を保って列の幅に合わせる
        const h = m.type === "image" && m.w !== undefined && m.h !== undefined ? { h: Math.round((m.h * colW) / m.w) } : {};
        const next: El = { ...m, ...h, w: colW, x, y };
        rowH = Math.max(rowH, sizeOf(next).h);
        // この要素を指しているコメントは、一緒に動かす
        for (const note of doc.elements.filter((e) => e.type === "comment" && e.on === m.id)) put(note, shifted(note, x - (m.x ?? 0), y - (m.y ?? 0)));
        put(m, next);
      }
      y += rowH + GAP;
    }
    const h = ordered.length === 0 ? sectionTop(c) : y - GAP + PAD - cb.y;
    if (h === cb.h) return;
    put(c, { ...c, h });
    if (h > cb.h) {
      const push = growthPush(c.id, cb, { ...cb, h }, others);
      if (push) pushDown(push.units, push.threshold, push.dy);
    }
  };
  const arrangeAll = (): void => {
    const sections = doc.elements.filter((e) => e.type === "container" && e.cols !== undefined).sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    for (const c of sections) arrange(c.id);
  };

  // 型（template）は、要素を足す操作の並びに展開して、その場に差し込む。labels は、エラーに出す操作の番号（渡された並びでの番号）
  const queue: unknown[] = [...ops];
  const labels = ops.map((_, i) => `ops[${i}]`);
  for (let i = 0; i < queue.length; i++) {
    const op = queue[i];
    const at = labels[i] ?? `ops[${i}]`;
    if (!isRecord(op)) return fail(`${at}: 操作はオブジェクトで書く`);
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
        const def = type ? DEFAULT_SIZE[type] : undefined;
        if (def) {
          raw.w ??= def.w;
          raw.h ??= def.h;
        }
        let grown: El | null = null;
        // 置いた後に下へずらすもの。新しい要素を入れる前のまとまりで決める（新しい要素が、重なった先の中身に数えられないように）
        let push: { units: Unit[]; threshold: number; dy: number } | null = null;
        place: if (type && NEEDS_PLACE.includes(type)) {
          const hasPos = raw.x !== undefined && raw.y !== undefined;
          const hints = [hasPos, op.in !== undefined, op.above !== undefined].filter(Boolean).length;
          if (hints > 1) return fail(`${at}: x・y と in と above は、どれか 1 つだけ書く`);
          if (!hasPos) {
            raw.x = 0;
            raw.y = 0;
            // 列で並べるセクションに足すものは、先に列の幅にする（幅で高さが変わる文字と表の、場所の見積もりを合わせる）
            const into = typeof op.in === "string" ? byId.get(op.in) : undefined;
            const intoBox = into?.cols === undefined ? null : boxOf(into);
            if (into?.cols !== undefined && intoBox && type !== "image" && type !== "container") raw.w = colWidth(intoBox, into.cols);
            const probe = parseEl(raw);
            if (!probe.ok) return fail(`${at}: ${probe.error}`);
            const size = sizeOf(probe.value);
            if (op.in !== undefined) {
              const c = typeof op.in === "string" ? byId.get(op.in) : undefined;
              if (!c || c.type !== "container") return fail(`${at}: in のセクションが無い: ${JSON.stringify(op.in)}`);
              const cb = boxOf(c) ?? { x: 0, y: 0, w: 0, h: 0 };
              if (c.cols !== undefined) {
                // 列で並べるセクションでは、右下の隅に、中心がセクションに入るように仮に置く。
                // 並べる順は位置から読むので、いちばん後ろになり、操作の後の並べ直し（arrange）が列の末尾へ入れる。
                // WHY セクションを仮に伸ばさない: 伸ばした枠に、下にあった別の要素が入って、中身に数えられる
                raw.x = cb.x + cb.w - size.w / 2 - 1;
                raw.y = cb.y + cb.h - size.h / 2 - 1;
                break place;
              }
              const [x, y] = placeInside(doc.elements, c, size);
              raw.x = x;
              raw.y = y;
              const w = Math.max(cb.w, x + size.w + PAD - cb.x);
              const h = Math.max(cb.h, y + size.h + PAD - cb.y);
              if (w !== cb.w || h !== cb.h) grown = { ...c, w, h };
              if (grown) push = growthPush(c.id, cb, { ...cb, w, h });
            } else if (op.above !== undefined) {
              const units = unitsOf(doc.elements);
              const target = units.find((u) => typeof op.above === "string" && u.ids.includes(op.above));
              if (!target) return fail(`${at}: above の要素が無い: ${JSON.stringify(op.above)}`);
              raw.x = target.box.x;
              raw.y = target.box.y;
              push = { units, threshold: target.box.y, dy: size.h + OUTER_GAP };
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
        if (push) pushDown(push.units, push.threshold, push.dy);
        replace(r.value);
        addedIds.add(r.value.id);
        if (grown) {
          replace(grown);
          if (!addedIds.has(grown.id)) updatedIds.add(grown.id);
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
        const before = el.type === "container" ? boxOf(el) : null;
        const after = boxOf(r.value);
        // セクションの下の端を set で下げたときも、in で伸びたときと同じに、下のものをずらす
        if (before && after && before.x === after.x && before.y === after.y && after.h > before.h) {
          const push = growthPush(el.id, before, after);
          if (push) pushDown(push.units, push.threshold, push.dy);
        }
        // セクションの中の要素が下へ伸びたら（h を増やした、文字や行が増えた）、同じセクションの、その下にある中身を押し下げる。
        // 入りきらなくなったら、セクションも伸ばす。WHY: 文字が小さいという検査の指摘を、箱を大きくするだけで直せるようにする
        const old = boxOf(el);
        if (isSolid(el) && old && after && old.x === after.x && old.y === after.y && after.h > old.h) {
          const section = doc.elements.find((c) => c.type === "container" && membersOf(doc.elements, c).some((m) => m.id === el.id));
          const sb = section ? boxOf(section) : null;
          if (section && sb) {
            const others = membersOf(doc.elements, section).flatMap((m) => {
              const b = m.id === el.id ? null : boxOf(m);
              return b ? [{ m, b }] : [];
            });
            const below = others.filter(({ b }) => b.y >= old.y + old.h && b.x < after.x + after.w && after.x < b.x + b.w);
            const threshold = Math.min(...below.map(({ b }) => b.y));
            const dy = below.length > 0 ? after.y + after.h + GAP - threshold : 0;
            let bottom = after.y + after.h;
            for (const { m, b } of others) {
              // 真下のものだけでなく、その高さから下にある中身を全部ずらす。横に並んだ付箋の上をそろえたままにするため
              const moved = dy > 0 && b.y >= threshold;
              if (moved) {
                replace(shifted(m, 0, dy));
                if (!addedIds.has(m.id)) updatedIds.add(m.id);
              }
              bottom = Math.max(bottom, b.y + b.h + (moved ? dy : 0));
            }
            const need = bottom + PAD - sb.y;
            if (need > sb.h) {
              const push = growthPush(section.id, sb, { ...sb, h: need });
              if (push) pushDown(push.units, push.threshold, push.dy);
              replace({ ...section, h: need });
              if (!addedIds.has(section.id)) updatedIds.add(section.id);
            }
          }
        }
        replace(r.value);
        if (!addedIds.has(el.id)) updatedIds.add(el.id);
        // この要素を指しているコメントは、要素が動いたぶんだけ一緒に動かす
        const was = boxOf(el);
        if (was && after && el.type !== "comment" && (was.x !== after.x || was.y !== after.y)) {
          for (const c of doc.elements.filter((e) => e.type === "comment" && e.on === el.id)) {
            replace(shifted(c, after.x - was.x, after.y - was.y));
            if (!addedIds.has(c.id)) updatedIds.add(c.id);
          }
        }
        break;
      }
      case "say": {
        const el = typeof op.id === "string" ? byId.get(op.id) : undefined;
        if (!el || el.type !== "comment") return fail(`${at}: id ${JSON.stringify(op.id)} のコメントが無い`);
        if (typeof op.text !== "string" || op.text.trim() === "") return fail(`${at}: say には text（本文）が要る`);
        // WHY 専用の操作: set で thread を丸ごと書き直すと、同時に書かれた相手のやりとりを消す
        replace({ ...el, thread: [...(el.thread ?? []), { by: ctx.by, at: ctx.at, text: op.text.trim() }] });
        if (!addedIds.has(el.id)) updatedIds.add(el.id);
        break;
      }
      case "rm": {
        if (typeof op.id !== "string" || !byId.has(op.id)) return fail(`${at}: id ${JSON.stringify(op.id)} の要素が無い`);
        remove(op.id);
        break;
      }
      case "compact": {
        // fit: 中身より背の高いセクションを、中身が入る高さまで低くする
        if (op.fit === true) {
          for (const c of doc.elements.filter((e) => e.type === "container")) {
            const cb = boxOf(c);
            const bottoms = membersOf(doc.elements, c).flatMap((m) => {
              const b = m.type === "comment" ? null : boxOf(m);
              return b ? [b.y + b.h] : [];
            });
            if (!cb || bottoms.length === 0) continue;
            const need = Math.max(...bottoms) + PAD - cb.y;
            if (need >= cb.h) continue;
            replace({ ...c, h: need });
            if (!addedIds.has(c.id)) updatedIds.add(c.id);
          }
        }
        // 上から順に見て、段と段の間が OUTER_GAP より空いていたら、その下を全部上へ詰める。
        // 段は「それまでに見たものの下の端より下から始まるまとまり」で切る。横に並んだものは同じ段として一緒に動く
        const units = unitsOf(doc.elements).sort((a, b) => a.box.y - b.box.y);
        let bottom = -Infinity;
        let shift = 0;
        for (const u of units) {
          const gap = u.box.y - shift - bottom;
          if (bottom !== -Infinity && gap > OUTER_GAP) shift += gap - OUTER_GAP;
          bottom = Math.max(bottom, u.box.y - shift + u.box.h);
          if (shift === 0) continue;
          for (const id of u.ids) {
            const el = byId.get(id);
            if (!el) continue;
            replace(shifted(el, 0, -shift));
            if (!addedIds.has(id)) updatedIds.add(id);
          }
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
        // 場所を書かなければ、全体の右に置く。id を書かなければ、tp1、tp2…と振る
        const b = boundsOf(doc.elements);
        do doc.seq += 1;
        while (byId.has(`tp${doc.seq}`));
        const expanded = expandTemplate(op, b ? [b.x + b.w + OUTER_GAP, b.y] : [0, 0], `tp${doc.seq}`);
        if (!expanded.ok) return fail(`${at}: ${expanded.error}`);
        queue.splice(i + 1, 0, ...expanded.value);
        labels.splice(i + 1, 0, ...expanded.value.map(() => `${at}（${String(op.kind)} の展開）`));
        break;
      }
      case "title": {
        if (typeof op.title !== "string") return fail(`${at}: title は文字列`);
        doc.title = op.title;
        titleChanged = true;
        break;
      }
      default:
        return fail(`${at}: op は add | set | rm | title | say | order | compact | template のどれか`);
    }
    // WHY 操作 1 つごと: 同じまとまりの後ろの操作（above、コメントを置く場所）が、並べ終わった位置を見られるようにする
    arrangeAll();
  }

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
