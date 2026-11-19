import { ALIGNS, CARRIABLE, COLORS, FONT, HEADS, MAX_COLS, NOTE_STATUS, NOTE_SUB_FONT, SHAPES, SIZES, STATUS_LABEL, SUMMARY_MIN_W, SUMMARY_W, TABLE_COL, dueLabel, isOverdue, localDay, metaParts, shortDay, statusBadge, boxOf, isRecord, isSolid, membersOf, parseEl, shifted, tableCols, textWidth, type Box, type El, type End, type Point } from "../shared/model.ts";

import { LABEL_LIFT, arrowPath, labelSpot, routeArrow, type RouteEnd } from "../shared/route.ts";
import { MARK_COLORS, isBoardRef, parseRich, resolveBoardRef, toggleMarkup, type Inline, type MarkupKind } from "../shared/rich.ts";
import { svgSrc } from "./sketch.ts";
import { GANTT_GROUP_H, GANTT_GROUP_ROW_H, segmentsOf, GANTT_MARK_H, GANTT_PAD, GANTT_ROW_H, GANTT_SCALE_H, GANTT_UNITS, dragBar, formatDay, ganttLayout, parseDay, type GanttBar } from "../shared/gantt.ts";
import type { EndMark, ShapeKind } from "../shared/model.ts";
import { restoreOp, withGeometry } from "../shared/restore.ts";
import { focusLabel, keptOnFocus } from "../shared/focus.ts";
import { collect, filterOf, filterTitle, itemsOf, type Row } from "../shared/summary.ts";

const SVG_NS ="http://www.w3.org/2000/svg";
const params = new URLSearchParams(location.search);
const boardPath = params.get("board") ?? "";
const exporting = params.has("export");
const clientId = Math.random().toString(36).slice(2);
const boardQuery = `board=${encodeURIComponent(boardPath)}`;
/** API を呼ぶのに要るトークン。xwb open が URL の # の後ろに付けて渡す */
const token = new URLSearchParams(location.hash.slice(1)).get("k") ?? "";
/** ヘッダーを付けられない EventSource と <img> の URL に足す */
const tokenQuery = `k=${encodeURIComponent(token)}`;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, { ...init, headers: { ...init.headers, "x-xwb-token": token } });
}
/** 書き出しの画面の余白。サーバーが窓の大きさを決める式（shot.ts の SHOT_MARGIN）と同じ値 */
const EXPORT_MARGIN = 48;

function $<T extends Element>(id: string, ctor: new () => T): T {
  const n = document.querySelector(`#${id}`);
  if (!(n instanceof ctor)) throw new Error(`#${id} が無い`);
  return n;
}

const stage = $("stage", HTMLElement);
const world = $("world", HTMLElement);
const elsLayer = $("els", HTMLElement);
const lines = $("lines", SVGSVGElement);
const claimsLayer = $("claims", HTMLElement);
const handle = $("handle", HTMLElement);
const marquee = $("marquee", HTMLElement);
const titleNode = $("title", HTMLElement);
const conn = $("conn", HTMLElement);
const zoomLabel = $("zoom", HTMLElement);
const bar = $("bar", HTMLElement);
const toastNode = $("toast", HTMLElement);
const pngButton = $("png", HTMLButtonElement);
const undoButton = $("undo", HTMLButtonElement);
const focusChip = $("focus", HTMLElement);
const focusName = $("focusname", HTMLElement);
const resolvedButton = $("resolved", HTMLButtonElement);

type Tool = "select" | "note" | "shape" | "text" | "container" | "table" | "arrow" | "pen" | "comment";
const TOOLS: readonly Tool[] = ["select", "note", "shape", "text", "container", "table", "arrow", "pen", "comment"];
const TOOL_KEYS: Record<string, Tool> = { v: "select", n: "note", r: "shape", t: "text", s: "container", a: "arrow", p: "pen", c: "comment" };
/** スクショにコメントも出すか。既定は出さない（議事録の画像を邪魔しないため） */
const showComments = params.has("comments");

type Gesture =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  // pinId: コメントの印を押して始めたときの、そのコメントの id。動かさずに離したら、やりとりを開く
  // link: リンクの上で押して始めたときの、そのリンク。動かさずに離したら、リンクを開く
  | { kind: "move"; start: Point; orig: Map<string, El>; moved: boolean; pinId: string | null; link: HTMLAnchorElement | null; jump: string | null }
  | { kind: "resize"; start: Point; orig: El; w: number; h: number }
  // purpose: 範囲で選ぶ、セクションを描く、コメントを置く。onId は、コメントの道具で押した場所にあった要素
  | { kind: "marquee"; start: Point; sx: number; sy: number; purpose: "select" | "container" | "comment"; onId: string | null }
  // ガントの帯をつかんで動かす。edge は、つかんだ場所（左端・右端・帯の全体）
  // index は行、seg はその行の何本めの帯か
  | { kind: "gantt"; id: string; index: number; seg: number; edge: "start" | "end" | "move"; startX: number; orig: El }
  | { kind: "arrow"; from: End; start: Point }
  | { kind: "pen"; points: Point[] };

interface Editing {
  id: string;
  field: HTMLElement;
  before: string;
  /** Enter で確定する欄（題名と表のセル）。付箋と文字は Enter で改行する */
  single: boolean;
  /** 文字の装飾（太字・斜体・蛍光ペン）が効く欄か。セクションの題名には効かない */
  rich: boolean;
  save: (value: string) => Record<string, unknown>;
}

interface Claim {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

const els = new Map<string, El>();
const nodes = new Map<string, HTMLElement>();
const selection = new Set<string>();
const flashing = new Set<string>();
/** 注目しているセクションと、その中身。注目していなければ空 */
const lit = new Set<string>();
const undoStack: unknown[][] = [];
const view = { x: 0, y: 0, k: 1 };
let title = "";
let tool: Tool = "select";
let gesture: Gesture | null = null;
let editing: Editing | null = null;
let preview: SVGPathElement | null = null;
let spaceDown = false;
let lastDown = { id: "", at: 0, x: 0, y: 0 };
let fitted = false;
/** やりとりを開いているコメント。同時に開くのは 1 つ */
let openComment: string | null = null;
/** 開いているコメントに書きかけの文 */
let draft = "";
/** Claude の返事が届いて、まだ開いていないコメント */
const unread = new Set<string>();

// ---- 表示 ----

function applyView(): void {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  const step = 24 * view.k;
  stage.style.backgroundSize = `${step}px ${step}px`;
  stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
  zoomLabel.textContent = `${Math.round(view.k * 100)}%`;
  handle.style.transform = `scale(${1 / view.k})`;
  // コメントの印とやりとりは、縮小しても読める大きさに保つ（CSS の --inv で拡大し返す）
  world.style.setProperty("--inv", String(1 / view.k));
}

function toWorld(ev: { clientX: number; clientY: number }): Point {
  const r = stage.getBoundingClientRect();
  return [(ev.clientX - r.left - view.x) / view.k, (ev.clientY - r.top - view.y) / view.k];
}

function zoomAt(cx: number, cy: number, k: number): void {
  const next = Math.min(4, Math.max(0.1, k));
  view.x = cx - ((cx - view.x) * next) / view.k;
  view.y = cy - ((cy - view.y) * next) / view.k;
  view.k = next;
  applyView();
}

/** 高さが中身から決まる要素。人が変えられるのは幅だけ */
function widthOnly(el: El): boolean {
  return el.type === "text" || el.type === "table" || el.type === "gantt" || el.type === "summary";
}

/** 画面で測った四角。文字と表の大きさは、見積もりではなく描いた結果を使う */
function rectOf(el: El): Box | null {
  const b = boxOf(el);
  if (!b) return null;
  const n = nodes.get(el.id);
  if (n && (el.type === "text" || el.type === "table")) return { x: b.x, y: b.y, w: n.offsetWidth, h: n.offsetHeight };
  return b;
}

/** 全部の要素が入る範囲。要素が無ければ null */
function boardBounds(): Box | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const el of els.values()) {
    const b = rectOf(el);
    // 全体の範囲にコメントは数えない（サーバーが窓の大きさを決める boundsOf と同じ決まり）
    if (!b || (el.type === "comment" && !showComments)) continue;
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 渡した範囲が画面に収まる位置と倍率にする。範囲が無ければ、原点を真ん中に置く */
function fitTo(b: Box | null): void {
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  if (!b) {
    view.x = W / 2;
    view.y = H / 2;
    view.k = 1;
  } else {
    // 操作の部品に隠れないよう、ふだんの画面では余白を広く取る
    const m = exporting ? EXPORT_MARGIN : 90;
    view.k = Math.max(0.05, Math.min((W - m * 2) / Math.max(1, b.w), (H - m * 2) / Math.max(1, b.h), exporting ? 4 : 1));
    view.x = (W - b.w * view.k) / 2 - b.x * view.k;
    view.y = (H - b.h * view.k) / 2 - b.y * view.k;
  }
  applyView();
}

function fit(): void {
  fitTo(boardBounds());
}

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

/** リンクの行き先を付ける。ほかのボードへのリンクは、data-board に相対パスを持たせて見分ける */
function setLink(a: HTMLAnchorElement, href: string): void {
  if (isBoardRef(href)) {
    a.dataset.board = href;
    a.href = `/?board=${encodeURIComponent(resolveBoardRef(boardPath, href))}`;
    a.title = `ボードを開く: ${href}`;
    return;
  }
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
}

/** リンクを開く。Web のリンクは別のタブで、ほかのボードは同じタブで開く（戻るボタンで元のボードへ戻れる） */
async function openLink(a: HTMLAnchorElement): Promise<void> {
  const ref = a.dataset.board;
  if (ref === undefined) {
    window.open(a.href, "_blank", "noopener,noreferrer");
    return;
  }
  const query = `board=${encodeURIComponent(resolveBoardRef(boardPath, ref))}`;
  // 行き先が無いか読めないときは、今のボードにとどまって知らせる
  const r = await api(`/api/board?${query}`);
  if (!r.ok) {
    toast(`ボードを開けない: ${ref}`);
    return;
  }
  // WHY # を付け直す: トークンは URL の # の後ろにあり、リンクの行き先には書いていない
  location.assign(`/?${query}${location.hash}`);
}

const INLINE_TAG: Record<"bold" | "italic" | "strike" | "code", string> = { bold: "strong", italic: "em", strike: "s", code: "code" };

function appendInline(target: HTMLElement, line: Inline[]): void {
  for (const part of line) {
    switch (part.kind) {
      case "text":
        target.append(part.text);
        break;
      case "mark": {
        const mark = document.createElement("mark");
        mark.className = `hl-${part.color}`;
        mark.textContent = part.text;
        target.append(mark);
        break;
      }
      case "link": {
        const a = document.createElement("a");
        setLink(a, part.href);
        a.textContent = part.text;
        target.append(a);
        break;
      }
      default: {
        const node = document.createElement(INLINE_TAG[part.kind]);
        node.textContent = part.text;
        target.append(node);
      }
    }
  }
}

/** 文字を、装飾（太字・斜体・コード・リンク・箇条書き）を効かせて入れる。HTML としては読まない */
function fillRich(target: HTMLElement, text: string): void {
  target.replaceChildren();
  if (text === "") return;
  for (const block of parseRich(text)) {
    if (block.kind === "lines") {
      for (const [i, line] of block.lines.entries()) {
        if (i > 0) target.append(document.createElement("br"));
        appendInline(target, line);
      }
      continue;
    }
    const list = document.createElement(block.kind === "bullets" ? "ul" : "ol");
    for (const line of block.lines) {
      const li = document.createElement("li");
      appendInline(li, line);
      list.append(li);
    }
    target.append(list);
  }
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function defaultColor(el: El): string {
  switch (el.type) {
    case "shape":
      return el.shape === undefined || el.shape === "note" ? "yellow" : "white";
    case "container":
    case "summary":
      return "gray";
    default:
      return "ink";
  }
}

/**
 * CSS では描けない形の輪郭。fill は塗る面と縁、line は面の上に重ねる線（円柱の手前の縁など）。
 * 四角・角丸・楕円・カプセル・付箋は CSS で描くので null。
 * WHY 大きさから道を作る: viewBox を伸ばして合わせると、円柱の縁や波の高さが、箱の縦横比でつぶれる。
 */
function shapeOutline(kind: ShapeKind, w: number, h: number): { fill: string; line?: string } | null {
  // 線の太さのぶん内側に描く。縁が箱の外にはみ出して切れないようにする
  const o = 1;
  const r = w - o;
  const b = h - o;
  switch (kind) {
    case "diamond":
      return { fill: `M${w / 2} ${o} L${r} ${h / 2} L${w / 2} ${b} L${o} ${h / 2} Z` };
    case "hexagon": {
      const i = Math.min(w * 0.18, h / 2);
      return { fill: `M${i} ${o} H${w - i} L${r} ${h / 2} L${w - i} ${b} H${i} L${o} ${h / 2} Z` };
    }
    case "parallelogram": {
      const s = Math.min(w * 0.18, h * 0.6);
      return { fill: `M${s} ${o} H${r} L${w - s} ${b} H${o} Z` };
    }
    case "cylinder": {
      const ry = Math.min(12, h / 5);
      const rx = w / 2 - o;
      return {
        fill: `M${o} ${ry + o} A${rx} ${ry} 0 0 1 ${r} ${ry + o} V${b - ry} A${rx} ${ry} 0 0 1 ${o} ${b - ry} Z`,
        line: `M${o} ${ry + o} A${rx} ${ry} 0 0 0 ${r} ${ry + o}`,
      };
    }
    case "queue": {
      const rx = Math.min(12, w / 5);
      const ry = h / 2 - o;
      return {
        fill: `M${rx + o} ${o} H${r - rx} A${rx} ${ry} 0 0 1 ${r - rx} ${b} H${rx + o} A${rx} ${ry} 0 0 1 ${rx + o} ${o} Z`,
        line: `M${r - rx} ${o} A${rx} ${ry} 0 0 0 ${r - rx} ${b}`,
      };
    }
    case "document": {
      const a = Math.min(10, h / 6);
      return { fill: `M${o} ${o} H${r} V${b - a} Q${w * 0.75} ${b - 3 * a} ${w / 2} ${b - a} T${o} ${b - a} Z` };
    }
    case "cloud": {
      const p = (x: number, y: number): string => `${o + x * (w - 2 * o)} ${o + y * (h - 2 * o)}`;
      return {
        fill: `M${p(0.25, 0.95)} C${p(0.06, 0.95)} ${p(-0.02, 0.64)} ${p(0.15, 0.52)} C${p(0.08, 0.26)} ${p(0.32, 0.1)} ${p(0.45, 0.24)} C${p(0.55, 0.0)} ${p(0.86, 0.06)} ${p(0.83, 0.36)} C${p(1.02, 0.4)} ${p(1.02, 0.78)} ${p(0.84, 0.82)} C${p(0.86, 0.95)} ${p(0.76, 0.97)} ${p(0.7, 0.95)} Z`,
      };
    }
    default:
      return null;
  }
}

/** 文字が図形からはみ出すときは、収まるまで小さくする。エージェントは描いた結果を測れないため */
function fitText(n: HTMLElement, body: HTMLElement, txt: HTMLElement, base: number): void {
  const cs = getComputedStyle(n);
  const avail = n.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  let px = base;
  txt.style.fontSize = `${px}px`;
  while (px > 9 && body.offsetHeight > avail) {
    px -= 1;
    txt.style.fontSize = `${px}px`;
  }
}

function imageSrc(el: El): string {
  if (el.svg !== undefined) return svgSrc(el.svg);
  const src = el.src ?? "";
  return src.startsWith("data:") ? src : `/api/asset?${boardQuery}&src=${encodeURIComponent(src)}&${tokenQuery}`;
}

function renderEl(el: El): void {
  if (el.type === "arrow" || el.type === "stroke") return;
  let n = nodes.get(el.id);
  if (!n) {
    n = document.createElement("div");
    n.dataset.id = el.id;
    elsLayer.append(n);
    nodes.set(el.id, n);
  }
  const cls = ["el", el.type, `c-${el.color ?? defaultColor(el)}`];
  if (el.type === "shape") {
    cls.push(`s-${el.shape ?? "note"}`);
    if (el.align) cls.push(`al-${el.align}`);
    if (el.border) cls.push("bordered", `b-${el.border}`);
    if (el.hollow) cls.push("hollow");
    if (el.dashed) cls.push("dashed");
  }
  if (el.type === "text") cls.push(`sz-${el.size ?? "m"}`, ...(el.w === undefined ? [] : ["wrap"]), ...(el.align ? [`al-${el.align}`] : []));
  if (selection.has(el.id)) cls.push("sel");
  if (flashing.has(el.id)) cls.push("flash");
  if (lit.has(el.id)) cls.push("lit");
  if (focusId === el.id) cls.push("focused");
  if (el.locked) cls.push("locked");
  // 論点があるセクションでは、論点が見出しになり、題名は小さい分類の札になる
  if (el.type === "container" && el.question) cls.push("asking");
  // 透明な枠。枠線・背景・題名の札を出さない。マウスを乗せたとき（hover）と選んだときだけ、点線の輪郭を出す
  if (el.type === "container" && el.frame === "none") cls.push("frameless", ...(hoverFrame === el.id ? ["hover"] : []));
  n.className = cls.join(" ");
  n.style.left = `${el.x ?? 0}px`;
  n.style.top = `${el.y ?? 0}px`;
  // 表は幅を書かなくても、見積もり（sizeOf）と同じ幅で描く。幅が無いと、空の表が潰れて見えなくなる
  // まとめの帯も、幅を書かなければ既定の幅で描く（幅が無いと、行の文字の長さで帯の幅が変わる）
  const width = el.type === "table" ? (el.w ?? tableCols(el) * TABLE_COL) : el.type === "summary" ? (el.w ?? SUMMARY_W) : el.w;
  n.style.width = width === undefined ? "" : `${width}px`;
  n.style.height = el.h === undefined || el.type === "text" || el.type === "table" ? "" : `${el.h}px`;
  // 人が直している最中の欄は、ほかからの更新で描き直さない（入力中の文字が消えるため）
  if (editing?.id === el.id) return;
  // コメントは、返事が届くたびに描き直す。書いている途中なら、入力欄へフォーカスを戻す（書きかけの文は draft に持っている）
  const typing = document.activeElement instanceof HTMLTextAreaElement && n.contains(document.activeElement);
  n.replaceChildren();
  if (typing) {
    queueMicrotask(() => {
      const input = n.querySelector(".cinput");
      if (input instanceof HTMLTextAreaElement) input.focus();
    });
  }
  switch (el.type) {
    case "shape": {
      const outline = shapeOutline(el.shape ?? "note", el.w ?? 0, el.h ?? 0);
      if (outline) {
        // CSS の四角と角丸では描けない形は、要素の大きさに合わせた SVG の道で描く
        n.classList.add("drawn");
        const shp = svg("svg", { class: "shp", viewBox: `0 0 ${el.w ?? 0} ${el.h ?? 0}` });
        shp.append(svg("path", { class: "fill", d: outline.fill }));
        if (outline.line) shp.append(svg("path", { class: "line", d: outline.line }));
        n.append(shp);
      }
      const body = div("body");
      // 札の段（並ぶ順は metaParts。CSS が、期限と発言者を右端に寄せる）、見出し、本文の順に積む
      const parts = metaParts(el);
      if (parts.length > 0) {
        const meta = div("meta");
        // WHY 書き出しの画面では期限切れの色を付けない: 書き出しは、同じボードなら同じバイト列になる。日付で変わると、前後の比較に使えない
        const overdue = !exporting && isOverdue(el, localDay(new Date()));
        for (const p of parts) {
          const part = div(p.kind === "status" ? `st st-${p.status}` : p.kind === "due" && overdue ? "due overdue" : p.kind, p.text);
          // 発言者の札の下限の幅に使う（board.css の .shape .who）
          if (p.kind === "who") part.style.setProperty("--who-w", `${textWidth(p.text, 1)}em`);
          meta.append(part);
        }
        body.append(meta);
      }
      if (el.title) body.append(div("ntitle", el.title));
      const txt = div("txt");
      fillRich(txt, el.text ?? "");
      body.append(txt);
      n.append(body);
      // 見出しがあるときの本文は、補足として小さく出す
      fitText(n, body, txt, el.size ? FONT[el.size] : el.title ? NOTE_SUB_FONT : 15);
      break;
    }
    case "container":
      // 透明な枠は、題名の札の代わりに、縁を掴むための見えない帯を置く（輪郭が出ている間だけ掴める。board.css）
      if (el.frame === "none") {
        for (const side of ["t", "r", "b", "l"]) n.append(div(`fedge ${side}`));
        break;
      }
      n.append(div("ttl", el.title ?? ""));
      if (el.question || el.answer) {
        const head = div("shead");
        if (el.question) head.append(div("sq", el.question));
        if (el.answer) {
          const answer = div("sa");
          answer.append(div("salabel", "結論"), div("satext", el.answer));
          head.append(answer);
        }
        n.append(head);
      }
      break;
    case "text":
      {
        const txt = div("txt");
        fillRich(txt, el.text ?? "");
        n.append(txt);
      }
      break;
    case "table": {
      const table = document.createElement("table");
      const cols = tableCols(el);
      const addRow = (cells: string[], r: number, tag: "th" | "td"): void => {
        const tr = document.createElement("tr");
        for (let c = 0; c < cols; c++) {
          const cell = document.createElement(tag);
          cell.dataset.r = String(r);
          cell.dataset.c = String(c);
          fillRich(cell, cells[c] ?? "");
          tr.append(cell);
        }
        table.append(tr);
      };
      if (el.head) addRow(el.head, -1, "th");
      for (const [r, row] of (el.rows ?? []).entries()) addRow(row, r, "td");
      n.append(table);
      break;
    }
    case "comment":
      renderComment(el, n);
      break;
    case "gantt":
      renderGantt(el, n);
      break;
    case "summary":
      renderSummary(el, n);
      break;
    case "image": {
      const img = document.createElement("img");
      img.draggable = false;
      img.src = imageSrc(el);
      if (el.crop) {
        // 箱いっぱいに広げてから、見せたい場所を中心に拡大する。はみ出したぶんは箱で切る
        n.classList.add("cropped");
        const at = `${el.crop.x * 100}% ${el.crop.y * 100}%`;
        img.style.objectPosition = at;
        img.style.transformOrigin = at;
        img.style.transform = `scale(${el.crop.zoom})`;
      }
      n.append(img);
      if (el.href) {
        const a = document.createElement("a");
        a.className = "ilink";
        a.title = el.href;
        setLink(a, el.href);
        a.textContent = isBoardRef(el.href) ? "→" : "↗";
        n.append(a);
      }
      break;
    }
  }
}

// ---- まとめの帯 ----

/** 帯が集める元の行。帯を描くたびに集め直さないように、要素が変わったとき（syncSummaries）に作り直す */
let summaryRows: Row[] = [];

/**
 * まとめの帯の行を、今の付箋に合わせて描き直す。
 * 帯の高さ（h）は、サーバーが操作のたびに書くので、ここでは変えない
 */
function syncSummaries(): void {
  const all = [...els.values()];
  if (!all.some((e) => e.type === "summary")) return;
  summaryRows = collect(all);
  for (const el of all) if (el.type === "summary") renderEl(el);
}

/** 帯の中身。題名と、集めた付箋の行。行は、押すと元の付箋へ移る（行の中身は、元の付箋で直す） */
function renderSummary(el: El, n: HTMLElement): void {
  const rows = itemsOf(summaryRows, el);
  const filter = filterOf(el);
  // 状態で集める帯は、題名の札をその状態の色にする。状態で集めない帯は、行ごとに状態の札を出す（帯の題名が状態を表さないため）
  const head = div("shead");
  head.append(div(`stitle st-${filter?.status ?? "any"}`, el.title?.trim() || (filter ? filterTitle(filter) : "")), div("scount", `${rows.length} 件`));
  n.append(head);
  if (rows.length === 0) n.append(div("srow none", "無し"));
  const today = localDay(new Date());
  for (const { item, status } of rows) {
    const row = div("srow");
    row.dataset.target = item.id;
    row.title = item.label;
    if (filter && filter.status === undefined && status !== undefined) row.append(div(`sst st-${status}`, STATUS_LABEL[status]));
    row.append(div("slabel", item.label));
    if (item.section?.title !== undefined) row.append(div("ssection", item.section.title));
    const source = els.get(item.id);
    const due = source ? dueLabel(source) : null;
    // 書き出しの画面では、期限切れの色を付けない（付箋の札と同じ決まり）
    // 持ち越しの日付。状態の札は行に出さないので、ここに出す
    if (item.carriedFrom !== undefined) row.append(div("scarried", `${shortDay(item.carriedFrom)}から`));
    if (source && due) row.append(div(!exporting && isOverdue(source, today) ? "sdue overdue" : "sdue", due));
    if (item.who !== undefined) row.append(div("swho", item.who));
    n.append(row);
  }
}

/** 要素が画面の真ん中に来るように移り、その要素を選ぶ。倍率は変えない */
function jumpTo(id: string): void {
  const el = els.get(id);
  const b = el ? rectOf(el) : null;
  if (!b) return;
  view.x = stage.clientWidth / 2 - (b.x + b.w / 2) * view.k;
  view.y = stage.clientHeight / 2 - (b.y + b.h / 2) * view.k;
  applyView();
  select([id]);
  flash([id]);
}

// ---- ガントチャート ----

function renderGantt(el: El, n: HTMLElement): void {
  const L = ganttLayout(el);
  n.style.width = `${L.w}px`;
  n.style.height = `${L.h}px`;
  const xOf = (day: number): number => L.chartX + (day - L.first) * L.pxPerDay;
  const put = (node: HTMLElement, x: number, y: number, w?: number, h?: number): HTMLElement => {
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    if (w !== undefined) node.style.width = `${w}px`;
    if (h !== undefined) node.style.height = `${h}px`;
    n.append(node);
    return node;
  };
  if (el.title) put(div("gtitle", el.title), GANTT_PAD, GANTT_PAD);
  const rowsH = L.marksY - L.rowsY;
  for (const g of L.groups) {
    const w = (g.to - g.from + 1) * L.pxPerDay;
    // 年や月の見出しが列に入りきらないとき（12 月だけの年など）は、切らずに左へはみ出させる
    const fits = textWidth(g.label, 10) + 8 <= w;
    put(div(fits ? "ggroup" : "ggroup narrow", g.label), xOf(g.from), L.rowsY - GANTT_SCALE_H, w, GANTT_GROUP_H);
  }
  for (const t of L.ticks) {
    const w = (t.to - t.from + 1) * L.pxPerDay;
    // 目盛りが細いときは「月」を省いて、番号だけにする
    put(div("gtick", w < 34 ? t.label.replace("月", "") : t.label), xOf(t.from), L.rowsY - GANTT_SCALE_H + GANTT_GROUP_H, w, GANTT_SCALE_H - GANTT_GROUP_H);
    put(div("gline"), xOf(t.from), L.rowsY, 0, rowsH);
  }
  put(div("gline"), xOf(L.last + 1), L.rowsY, 0, rowsH);
  for (const g of L.groupRows) put(div("ggrp", g.label), GANTT_PAD, g.y, L.w - GANTT_PAD * 2, GANTT_GROUP_ROW_H);
  for (const [i, b] of (el.bars ?? []).entries()) {
    const y = L.barY[i] ?? L.rowsY;
    // 札（tag）のある行は、行全体に薄い色を付ける。相手の予定の中で、自分たちが担う行を一目で分かるようにする
    put(div(b.tag ? "grow tagged" : "grow"), GANTT_PAD, y, L.w - GANTT_PAD * 2, GANTT_ROW_H);
    const name = put(div("gname"), GANTT_PAD, y, L.labelW - 8, GANTT_ROW_H);
    name.dataset.bar = String(i);
    name.title = b.name;
    name.append(div("gn", b.name));
    if (b.tag) name.append(div("gtag", b.tag));
    // 1 行に、期間の数だけ帯を置く
    for (const [j, seg] of segmentsOf(b).entries()) {
      const s = parseDay(seg.start, false);
      const e = parseDay(seg.end, true);
      if (s === null || e === null) continue;
      // 表示する範囲の外にはみ出す帯は、範囲の端で切る
      const from = Math.max(s, L.first);
      const to = Math.min(e, L.last);
      if (from > to) continue;
      const bar = put(div(`gbar c-${b.color ?? "blue"} st-${seg.status ?? "doing"}`), xOf(from), y + 6, (to - from + 1) * L.pxPerDay, GANTT_ROW_H - 12);
      bar.dataset.bar = String(i);
      bar.dataset.seg = String(j);
      for (const edge of ["start", "end"]) {
        const grip = div(`gedge ${edge}`);
        grip.dataset.edge = edge;
        bar.append(grip);
      }
    }
  }
  // 印の置き場所（名前を左右どちらに出すか、何段めか）は、配置の側で決めてある
  for (const m of L.markSpots) {
    // 日付の線は、印のある段まで伸ばす。下の段へずらした名前が、どの日付のものか分かるように
    // 「今日」も、マイルストーンと同じ段に、色を変えて置く（目盛りの上に置くと、年や月の見出しに重なる）
    put(div(m.today ? "gtoday" : "gmline"), m.x, L.rowsY, 0, rowsH + m.row * GANTT_MARK_H + 8);
    const kind = m.today ? "gmark today" : "gmark";
    put(div(m.left ? `${kind} left` : kind, m.name), m.x, L.marksY + m.row * GANTT_MARK_H, undefined, GANTT_MARK_H);
  }
}

// ---- コメント ----

function renderComment(el: El, n: HTMLElement): void {
  const thread = el.thread ?? [];
  const open = openComment === el.id;
  n.classList.toggle("area", el.w !== undefined && el.h !== undefined);
  n.classList.toggle("resolved", el.resolved === true);
  n.classList.toggle("unread", unread.has(el.id));
  n.classList.toggle("open", open);
  n.append(div("carea"));
  const pin = div("cpin", el.resolved ? "✓" : String(thread.length));
  pin.title = thread[0]?.text ?? "";
  n.append(pin);
  if (!open || exporting) return;

  // 欄の位置と拡大率は board.css の .cpanel、面と文字はここの utility
  const panel = div("cpanel w-80 rounded-card bg-card p-3 text-caption text-card-foreground shadow-lg select-text");
  // WHY overscroll-contain: 端まで来たスクロールを、外（ボード）へ渡さない
  const msgs = div("flex max-h-72 flex-col gap-2 overflow-y-auto overscroll-contain not-empty:mb-3");
  for (const m of thread) {
    const msg = div(`rounded-field p-2 ${m.by === "human" ? "bg-muted" : "bg-selected"}`);
    msg.append(div("mb-1 font-bold text-muted-foreground", `${m.by === "human" ? "あなた" : "Claude"} ${m.at.slice(11, 16)}`), div("wrap-anywhere whitespace-pre-wrap", m.text));
    msgs.append(msg);
  }
  // いちばん新しいやりとりが人のものなら、Claude はまだ答えていない。届けられたかどうかで、出す状態を分ける。
  // WHY データから決める: 画面を開き直しても、返事を待っているコメントが分かるようにする
  const sending = sendingId === el.id;
  if (!sending && !el.resolved && thread.at(-1)?.by === "human") {
    msgs.append(el.unsent ? div("px-1 font-semibold text-destructive", "まだ Claude に送れていません") : div("cstate wait px-1 font-semibold text-muted-foreground", "Claude の返事待ち"));
  }
  const input = document.createElement("textarea");
  // cinput は、欄を探すための名前（見た目は utility）
  input.className = "cinput block w-full resize-y overscroll-contain rounded-field border border-input bg-card p-2 outline-none focus-visible:border-ring";
  input.rows = 2;
  input.placeholder = "Claude に聞く";
  input.value = draft;
  input.addEventListener("input", () => (draft = input.value));
  const send = (): void => {
    const text = input.value.trim();
    // 送っている最中は、もう 1 回送らない（二重に届くのを防ぐ）
    if (sending || (text === "" && !el.unsent)) return;
    draft = "";
    input.value = "";
    void sendComment(el.id, text);
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) {
      ev.preventDefault();
      send();
    }
  });
  const row = div("mt-2 flex justify-between");
  // 届け先が無くて送れなかったやりとりが残っているときは、本文なしでも送り直せる
  const sendButton = button(sending ? "送信中…" : sentId === el.id ? "送りました" : el.unsent ? "送り直す" : "送る", false, send, "⌘Enter");
  sendButton.disabled = sending;
  // 欄は白い面なので、帯のボタン（chrome-button）ではなく、主の操作と控えめな操作の見た目にする
  sendButton.className = "cursor-pointer rounded-field bg-primary px-3 py-2 font-bold text-primary-foreground hover:bg-primary-hover focus-visible:focus-ring disabled:cursor-default disabled:disabled-dim";
  const resolveButton = button(el.resolved ? "未解決に戻す" : "解決", false, () => {
    void setOps([{ id: el.id, patch: { resolved: el.resolved ? null : true } }]);
    if (!el.resolved) closeComment();
  });
  resolveButton.className = "cursor-pointer rounded-field px-3 py-2 text-muted-foreground hover:bg-muted focus-visible:focus-ring";
  row.append(sendButton, resolveButton);
  panel.append(msgs, input, row);
  n.append(panel);
  msgs.scrollTop = msgs.scrollHeight;
}

/** 送っている最中のコメントと、送り終えた直後のコメント。ボタンの文字を変えるのに使う */
let sendingId: string | null = null;
let sentId: string | null = null;

function redrawComment(id: string): void {
  const el = els.get(id);
  if (el) renderEl(el);
}

async function sendComment(id: string, text: string): Promise<void> {
  // 本文がサーバーに残らなかったときは、書いた文を入力欄へ戻す。消えたままにしない
  const restore = (): void => {
    if (openComment === id && draft === "") draft = text;
  };
  sendingId = id;
  redrawComment(id);
  try {
    await inflight;
    const r = await api("/api/comment/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: boardPath, id, text, client: clientId }) });
    if (r.ok) {
      sentId = id;
      setTimeout(() => {
        if (sentId !== id) return;
        sentId = null;
        redrawComment(id);
      }, 2000);
      return;
    }
    const j: unknown = await r.json();
    toast(isRecord(j) && typeof j.error === "string" ? j.error : "送れなかった");
    // 409（届け先が無い）のときは、本文はコメントに積まれて残っている。サーバーの中の失敗では、積まれたか分からない
    if (r.status >= 500) restore();
  } catch (e) {
    toast(`サーバーに届かない: ${String(e)}`);
    restore();
  } finally {
    sendingId = null;
    redrawComment(id);
  }
}

function openCommentPanel(id: string): void {
  const prev = openComment;
  if (prev && prev !== id) closeComment();
  openComment = id;
  draft = "";
  unread.delete(id);
  const el = els.get(id);
  if (el) renderEl(el);
  const input = nodes.get(id)?.querySelector(".cinput");
  if (input instanceof HTMLTextAreaElement) input.focus();
}

function closeComment(): void {
  const id = openComment;
  if (!id) return;
  openComment = null;
  const el = els.get(id);
  if (!el) return;
  // 何も書かずに閉じたコメントは、置かなかったものとして消す
  if ((el.thread ?? []).length === 0) void commit([{ op: "rm", id }], null);
  else renderEl(el);
}

function anchor(end: End | undefined): RouteEnd | null {
  if (end === undefined) return null;
  if (typeof end !== "string") return { point: end, box: null, shape: "" };
  const el = els.get(end);
  const b = el ? rectOf(el) : null;
  if (!el || !b) return null;
  return { point: [b.x + b.w / 2, b.y + b.h / 2], box: b, shape: el.type === "shape" ? (el.shape ?? "note") : "rect" };
}

/** 要素の縁の上で、点 toward へ向かう線が出る点 */
function edgeToward(a: RouteEnd, toward: Point): Point {
  return routeArrow(a, { point: toward, box: null, shape: "" }, {}, [])[0] ?? a.point;
}

function arrowPoints(el: El): Point[] | null {
  // 端の要素の四角は、画面で測ったもの（rectOf）を使う。サーバーの検査は、同じ関数に見積もりを渡す
  return arrowPath(el, rectOf, (id) => els.get(id), () => [...els.values()].filter(isSolid));
}

function markAt(mark: EndMark, tip: Point, from: Point): SVGElement | null {
  switch (mark) {
    case "none":
      return null;
    case "dot":
      return svg("circle", { class: "head", cx: tip[0], cy: tip[1], r: 4.5 });
    case "arrow": {
      const len = Math.hypot(tip[0] - from[0], tip[1] - from[1]) || 1;
      const ux = (tip[0] - from[0]) / len;
      const uy = (tip[1] - from[1]) / len;
      const bx = tip[0] - ux * 11;
      const by = tip[1] - uy * 11;
      return svg("polygon", { class: "head", points: `${tip[0]},${tip[1]} ${bx - uy * 5},${by + ux * 5} ${bx + uy * 5},${by - ux * 5}` });
    }
  }
}

/** 端の形。端ごとの指定（startHead・endHead）が無ければ、heads（矢じりを付ける端）から決める */
function endMarks(el: El): { start: EndMark; end: EndMark } {
  const heads = el.heads ?? "end";
  return {
    start: el.startHead ?? (heads === "start" || heads === "both" ? "arrow" : "none"),
    end: el.endHead ?? (heads === "end" || heads === "both" ? "arrow" : "none"),
  };
}

function pathOf(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${p[1]}`).join(" ");
}

/** 折れ線の角を丸めた道 */
function roundedPath(points: Point[]): string {
  const first = points[0];
  if (!first) return "";
  let d = `M${first[0]} ${first[1]}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const p = points[i];
    const next = points[i + 1];
    if (!prev || !p) continue;
    if (!next) {
      d += ` L${p[0]} ${p[1]}`;
      continue;
    }
    const inLen = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const outLen = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const r = Math.min(8, inLen / 2, outLen / 2);
    if (r < 1) {
      d += ` L${p[0]} ${p[1]}`;
      continue;
    }
    const a: Point = [p[0] - ((p[0] - prev[0]) / inLen) * r, p[1] - ((p[1] - prev[1]) / inLen) * r];
    const b: Point = [p[0] + ((next[0] - p[0]) / outLen) * r, p[1] + ((next[1] - p[1]) / outLen) * r];
    d += ` L${a[0]} ${a[1]} Q${p[0]} ${p[1]} ${b[0]} ${b[1]}`;
  }
  return d;
}

function renderLines(): void {
  lines.replaceChildren();
  for (const el of els.values()) {
    if (el.type !== "arrow" && el.type !== "stroke") continue;
    const cls = [`c-${el.color ?? "ink"}`];
    if (selection.has(el.id)) cls.push("sel");
    if (flashing.has(el.id)) cls.push("flash");
    if (el.dashed) cls.push("dashed");
    const g = svg("g", { class: cls.join(" "), "data-id": el.id });
    if (el.type === "stroke") {
      const d = pathOf(el.points ?? []);
      const vis = svg("path", { class: "vis", d });
      vis.style.strokeWidth = String(el.width ?? 3);
      g.append(vis, svg("path", { class: "hit", d }));
    } else {
      const points = arrowPoints(el);
      const first = points?.[0];
      const second = points?.[1];
      const last = points?.at(-1);
      const beforeLast = points?.at(-2);
      if (!points || !first || !second || !last || !beforeLast) continue;
      const d = roundedPath(points);
      g.append(svg("path", { class: "vis", d }), svg("path", { class: "hit", d }));
      const marks = endMarks(el);
      const endMark = markAt(marks.end, last, beforeLast);
      const startMark = markAt(marks.start, first, second);
      if (endMark) g.append(endMark);
      if (startMark) g.append(startMark);
      const spot = el.label ? labelSpot(points) : null;
      if (spot) {
        // 横向きの線は、短いと文字が線を覆って向きが読めなくなるので、線の上に浮かせる
        const label = svg("text", { x: spot.x, y: spot.y - (spot.flat ? LABEL_LIFT : 0) });
        label.textContent = el.label ?? "";
        g.append(label);
      }
    }
    lines.append(g);
  }
  if (preview) lines.append(preview);
}

function positionHandle(): void {
  const only = selection.size === 1 ? els.get([...selection][0] ?? "") : undefined;
  // 1 点を指すコメント（ピン）には大きさが無いので、ハンドルを出さない
  const sizable = only && !isLocked(only) && only.type !== "arrow" && only.type !== "stroke" && (only.type !== "comment" || only.w !== undefined);
  const b = only && sizable ? rectOf(only) : null;
  handle.hidden = !b || exporting;
  if (b) {
    handle.style.left = `${b.x + b.w}px`;
    handle.style.top = `${b.y + b.h}px`;
  }
}

/** いま話している議題のセクションの id。サーバーが持つ一時の表示で、全部の画面で同じになる */
let focusId: string | null = null;

/**
 * 注目を、サーバーから届いた値に合わせる。注目が別のセクションへ移ったら、そのセクションへ画面を寄せる。
 * 画面を寄せたかを返す。
 * WHY やめたときは動かさない: 人が次に見たい場所は分からない。見ていた場所のままにする。
 */
function setFocus(raw: unknown): boolean {
  // 書き出しの画面では、注目を効かせない（議事録の画像が薄くならず、全体が写るように）
  const next = typeof raw === "string" && !exporting ? raw : null;
  // WHY 操作の最中は寄せない: ドラッグやパンは、押した時点の位置と倍率を基準に動かしている。途中で変えると、手元の動きがずれる
  if (next !== focusId) focusToFit = gesture ? null : next;
  focusId = next;
  return fitFocus();
}

/** 注目が移ってから、まだ画面を寄せていないセクションの id */
let focusToFit: string | null = null;

/**
 * 注目が移ったセクションへ画面を寄せる。寄せたかを返す。
 * WHY セクションが無ければ待つ: 注目の知らせは、要素の知らせと別に届く。セクションが届く前に注目が届くことがある
 */
function fitFocus(): boolean {
  const section = focusToFit === null ? undefined : els.get(focusToFit);
  if (!section) return false;
  focusToFit = null;
  const box = gesture ? null : rectOf(section);
  if (box) fitTo(box);
  return box !== null;
}

/** 注目を移す、やめる（id が null）。サーバーが、開いている全部の画面へ知らせる */
function sendFocus(id: string | null): void {
  void api("/api/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: boardPath, id }) });
}

/** 薄くしない要素に印（lit）を、注目しているセクションに枠の印（focused）を付け、注目の札を出す */
function applyFocus(): void {
  const kept = keptOnFocus([...els.values()], focusId);
  const section = kept === null || focusId === null ? undefined : els.get(focusId);
  lit.clear();
  for (const id of kept ?? []) lit.add(id);
  world.classList.toggle("focusing", section !== undefined);
  for (const [id, n] of nodes) {
    n.classList.toggle("lit", lit.has(id));
    n.classList.toggle("focused", id === section?.id);
  }
  // WHY 札を出す: 薄くなっている理由が、注目したセクションが画面の外にあると分からない
  focusChip.hidden = section === undefined;
  if (section) focusName.textContent = `注目: ${focusLabel(section)}`;
}

function refresh(): void {
  syncSummaries();
  fitFocus();
  applyFocus();
  renderLines();
  positionHandle();
  renderBar();
  renderResolvedToggle();
}

/** 解決済みのコメントを、いま見せているか。既定では隠す。この画面だけの切り替えで、ボードには残さない */
let showResolved = false;

/** 画面に出していない要素。範囲選択や全選択で、見えないものを選んで消さないようにする */
function isHidden(el: El): boolean {
  return el.type === "comment" && el.resolved === true && !showResolved;
}

/** 固定した要素。人は、固定を外すまで動かせず、直せず、消せない */
function isLocked(el: El | undefined): boolean {
  return el?.locked === true;
}

/** 解決済みのコメントがあるときだけ、表示を切り替えるボタンを出す */
function renderResolvedToggle(): void {
  let count = 0;
  for (const el of els.values()) if (el.type === "comment" && el.resolved) count += 1;
  // 解決済みが無くなったら、表示の切り替えも元に戻す
  if (count === 0) showResolved = false;
  resolvedButton.hidden = count === 0 || exporting;
  resolvedButton.textContent = `解決済み ${count}`;
  resolvedButton.setAttribute("aria-pressed", String(showResolved));
  document.body.classList.toggle("show-resolved", showResolved);
}

function toast(message: string): void {
  // WHY 時間で消さない: 失敗の知らせは、見逃すと画面のどこにも残らない。閉じるまで出しておく
  const close = document.createElement("button");
  close.textContent = "閉じる";
  close.className = "flex-none cursor-pointer rounded-field px-2 py-1 font-bold hover:bg-destructive-hover";
  close.addEventListener("click", () => (toastNode.hidden = true));
  toastNode.replaceChildren(div("min-w-0 wrap-anywhere", message), close);
  toastNode.hidden = false;
}

// ---- データ ----

function parseEls(raw: unknown): El[] {
  const out: El[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const r = parseEl(item);
    if (r.ok) out.push(r.value);
  }
  return out;
}

function upsert(el: El): void {
  const local = els.get(el.id);
  const held = (gesture?.kind === "move" && gesture.orig.has(el.id)) || (gesture?.kind === "resize" && gesture.orig.id === el.id);
  // ドラッグや大きさの変更の最中に、サーバーが動かした（押し下げた、まとめの帯が伸びた）要素は、「元に戻す」が書く場所（origin）を、届いた値に替える。
  // WHY: 操作を始めた時点の値を書くと、サーバーが動かしたぶんが打ち消され、後で行が減って上がるときに、始めより上へ行く。
  // 手元の位置（ドラッグの量）は、origin からの差なので、ドラッグしている要素も、サーバーが動かしたぶん一緒に動く
  if (gesture?.kind === "move" && gesture.orig.has(el.id)) gesture.orig.set(el.id, el);
  if (gesture?.kind === "resize" && gesture.orig.id === el.id) gesture.orig = el;
  // ガントの帯を動かしている最中は、ほかからの更新が届いても、手元の行を保つ
  const dragging = gesture?.kind === "gantt" && gesture.id === el.id && local;
  els.set(el.id, dragging ? { ...el, bars: local.bars } : held && local ? withGeometry(el, local) : el);
  renderEl(els.get(el.id) ?? el);
}

function drop(id: string): void {
  els.delete(id);
  nodes.get(id)?.remove();
  nodes.delete(id);
  selection.delete(id);
}

function flash(ids: string[]): void {
  for (const id of ids) {
    flashing.add(id);
    nodes.get(id)?.classList.add("flash");
  }
  setTimeout(() => {
    for (const id of ids) {
      flashing.delete(id);
      nodes.get(id)?.classList.remove("flash");
    }
    renderLines();
  }, 1800);
}

function setTitle(next: string): void {
  title = next;
  if (document.activeElement !== titleNode) titleNode.textContent = next;
  document.title = next === "" ? "xwb" : `${next} · xwb`;
}

function renderClaims(raw: unknown): void {
  claimsLayer.replaceChildren();
  if (!Array.isArray(raw)) return;
  for (const c of raw) {
    if (!isRecord(c)) continue;
    const { x, y, w, h, label } = c;
    if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") continue;
    const claim: Claim = { id: String(c.id), x, y, w, h, label: typeof label === "string" ? label : "" };
    const d = div("claim");
    d.style.left = `${claim.x}px`;
    d.style.top = `${claim.y}px`;
    d.style.width = `${claim.w}px`;
    d.style.height = `${claim.h}px`;
    if (claim.label !== "") {
      const s = document.createElement("span");
      s.textContent = claim.label;
      d.append(s);
    }
    claimsLayer.append(d);
  }
}

function loadSnapshot(raw: unknown): void {
  if (!isRecord(raw)) return;
  const next = parseEls(raw.elements);
  const keep = new Set(next.map((e) => e.id));
  for (const id of [...els.keys()]) if (!keep.has(id)) drop(id);
  for (const el of next) upsert(el);
  applyOrder(next.map((e) => e.id));
  setTitle(typeof raw.title === "string" ? raw.title : "");
  renderClaims(raw.claims);
  const moved = setFocus(raw.focus);
  refresh();
  if (!fitted) {
    fitted = true;
    // 開いたときに注目があれば、全体ではなく、注目のセクションを見せる
    if (!moved) fit();
  }
}

async function resync(): Promise<void> {
  const r = await api(`/api/board?${boardQuery}`);
  if (r.ok) loadSnapshot(await r.json());
}

/**
 * 重なり順を、サーバーの並び（背面から前面）に合わせる。
 * 要素の並び（els）と、画面の部品の並びを入れ直す。線は els の順に描くので、次の描き直しで合う。
 */
function applyOrder(order: unknown): void {
  if (!Array.isArray(order)) return;
  const sorted: [string, El][] = [];
  for (const id of order) {
    const el = typeof id === "string" ? els.get(id) : undefined;
    if (el) sorted.push([el.id, el]);
  }
  // 並びに無い要素（届く順が前後したもの）は、前面に残す
  const listed = new Set(sorted.map(([id]) => id));
  for (const [id, el] of els) if (!listed.has(id)) sorted.push([id, el]);
  els.clear();
  for (const [id, el] of sorted) {
    els.set(id, el);
    const n = nodes.get(id);
    if (n) elsLayer.append(n);
  }
}

interface OpsResult {
  added: El[];
  updated: El[];
  removed: El[];
}

/** 「元に戻す」に積む操作の作り方。積まない操作には、null を渡す */
interface Undoable {
  /** ドラッグや大きさの変更で、手元の要素を先に書き換えていたときの、書き換える前の要素 */
  origin?: ReadonlyMap<string, El>;
  /** 要素のほかに戻すもの（題名）の操作 */
  also?: unknown[];
}

let inflight: Promise<unknown> = Promise.resolve();

/**
 * 書き込みを 1 つずつ順に送る。
 * WHY: 「Claude に送る」は、直前の編集がサーバーに届いてから一覧を作らないと、その編集を取りこぼす。
 */
function commit(ops: unknown[], undoable: Undoable | null): Promise<OpsResult | null> {
  const p = inflight.then(() => commitNow(ops, undoable));
  inflight = p.catch(() => null);
  return p;
}

async function commitNow(ops: unknown[], undoable: Undoable | null): Promise<OpsResult | null> {
  if (ops.length === 0) return null;
  let j: unknown;
  let okStatus = false;
  // WHY 送る直前の写しを使う: 同じ変更が SSE でも届き、返事より先に els へ入ることがある
  const before = new Map(els);
  try {
    const r = await api("/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: boardPath, client: clientId, ops }) });
    okStatus = r.ok;
    j = await r.json();
  } catch (e) {
    j = { error: `サーバーに届かない: ${String(e)}` };
  }
  if (!okStatus || !isRecord(j)) {
    toast(isRecord(j) && typeof j.error === "string" ? j.error : "書き込めなかった");
    await resync();
    return null;
  }
  const result: OpsResult = { added: parseEls(j.added), updated: parseEls(j.updated), removed: parseEls(j.removed) };
  for (const el of result.removed) drop(el.id);
  for (const el of [...result.added, ...result.updated]) upsert(el);
  applyOrder(j.order);
  if (undoable) {
    // 元に戻す操作は、返事から作る。押し下げや並べ直しのようにサーバーが足した変更も、一緒に戻る（shared/restore.ts）
    const back = restoreOp(before, ops, { ...result, order: j.order }, undoable.origin);
    const entry = [...(undoable.also ?? []), ...(back ? [back] : [])];
    if (entry.length > 0) pushUndo(entry);
  }
  refresh();
  return result;
}

function pushUndo(ops: unknown[]): void {
  undoStack.push(ops);
  undoFailed = false;
  if (undoStack.length > 100) undoStack.shift();
  undoButton.disabled = false;
}

/** 直前の「元に戻す」が失敗して、その中身を残してあるか */
let undoFailed = false;

let undoing: Promise<void> = Promise.resolve();

/**
 * 「元に戻す」を 1 つずつ順に送る。
 * WHY: 前の「元に戻す」の返事を待たずに次を始めると、同じ操作をもう 1 回送り、その下の操作を送らずに捨てる（キーを押し続けると起きる）
 */
function undo(): Promise<void> {
  undoing = undoing.then(undoOne);
  return undoing;
}

async function undoOne(): Promise<void> {
  const ops = undoStack.at(-1);
  if (!ops) return;
  // WHY 失敗しても 1 回は残す: 失敗の後は、サーバーの今の中身を読み直す（resync）。
  // 読み直した後なら、消えた要素を除いて通ることがある。2 回続けて失敗した中身は、残すと次の「元に戻す」をふさぐので捨てる
  const done = (await commit(ops, null)) !== null;
  if (done || undoFailed) undoStack.splice(undoStack.lastIndexOf(ops), 1);
  if (!done && undoFailed) toast("元に戻せなかった操作を捨てた");
  undoFailed = !done && !undoFailed;
  undoButton.disabled = undoStack.length === 0;
}

interface Change {
  id: string;
  patch: Record<string, unknown>;
}

/** 項目の変更を送る */
function setOps(changes: Change[]): Promise<OpsResult | null> {
  return commit(changes.flatMap((c) => (els.has(c.id) ? [{ op: "set", id: c.id, patch: c.patch }] : [])), {});
}

async function addEl(el: Record<string, unknown>): Promise<El | null> {
  const r = await commit([{ op: "add", el }], {});
  return r?.added[0] ?? null;
}

async function removeEls(all: string[]): Promise<void> {
  // 固定した要素は消さない。うっかり消すのを防ぐための固定なので、ほかの要素と一緒に選んでいても残す
  const ids = all.filter((id) => !isLocked(els.get(id)));
  if (ids.length === 0) {
    if (all.length > 0) toast("固定した要素は消せない。先に固定を外す");
    return;
  }
  await commit(ids.map((id) => ({ op: "rm", id })), {});
}

// ---- 選択と、選択した要素への操作 ----

function select(ids: Iterable<string>): void {
  const before = [...selection];
  selection.clear();
  for (const id of ids) selection.add(id);
  for (const id of new Set([...before, ...selection])) nodes.get(id)?.classList.toggle("sel", selection.has(id));
  refresh();
}

function selected(): El[] {
  const out: El[] = [];
  for (const id of selection) {
    const el = els.get(id);
    if (el) out.push(el);
  }
  return out;
}

/** 操作の帯のボタン。効いている切り替えは aria-pressed で示す（見た目は app.css の chrome-button） */
function button(label: string, on: boolean, run: () => void, title?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = "chrome-button";
  if (on) b.setAttribute("aria-pressed", "true");
  if (title) b.title = title;
  b.addEventListener("click", run);
  return b;
}

const SHAPE_LABEL: Record<ShapeKind, string> = {
  note: "付箋",
  rect: "四角",
  round: "角丸",
  pill: "カプセル",
  ellipse: "楕円",
  diamond: "ひし形",
  hexagon: "六角形",
  parallelogram: "平行四辺形",
  cylinder: "円柱",
  document: "文書",
  queue: "キュー",
  cloud: "雲",
};
const SIZE_LABEL: Record<(typeof SIZES)[number], string> = { s: "小", m: "本文", l: "大", xl: "題名", huge: "特大" };
const ALIGN_LABEL: Record<(typeof ALIGNS)[number], string> = { left: "左寄せ", center: "中央", right: "右寄せ" };

const COLOR_LABEL: Record<(typeof COLORS)[number], string> = { yellow: "黄", orange: "オレンジ", red: "赤", pink: "ピンク", purple: "紫", blue: "青", teal: "青緑", green: "緑", gray: "灰", white: "白", ink: "墨" };

/** 一覧から 1 つ選ぶ部品。選んだ要素の値がそろっていないときは、値の代わりに、何を選ぶ部品か（title）を出す */
function picker<T extends string>(title: string, options: readonly T[], labels: Record<T, string>, current: T | null, onPick: (value: string) => void): HTMLSelectElement {
  const pick = document.createElement("select");
  pick.className = "chrome-select";
  pick.title = title;
  for (const o of options) pick.append(new Option(labels[o], o, false, o === current));
  if (current === null) {
    // 一覧には出さない、見出しだけの項目。空欄のままだと、何の選択かが分からない
    const heading = new Option(title, "", true, true);
    heading.disabled = true;
    heading.hidden = true;
    pick.prepend(heading);
  }
  pick.addEventListener("change", () => onPick(pick.value));
  return pick;
}

/** 選んだ要素の値が全部同じなら、その値。違うものが混ざっていれば null */
function shared<T>(values: T[]): T | null {
  const first = values[0];
  return first !== undefined && values.every((v) => v === first) ? first : null;
}
/** セクションの中身の並べ方。0 は、並べない（自由に置く） */
const COLS_OPTIONS = Array.from({ length: MAX_COLS + 1 }, (_, i) => String(i));
const COLS_LABEL: Record<string, string> = Object.fromEntries(COLS_OPTIONS.map((o) => [o, o === "0" ? "自由に置く" : `${o} 列`]));
/** 付箋の状態の選択。none は、札を出さない */
const STATUS_OPTIONS = ["none", ...NOTE_STATUS] as const;
const STATUS_OPTION_LABEL: Record<(typeof STATUS_OPTIONS)[number], string> = { none: "状態なし", ...STATUS_LABEL };
const HEADS_LABEL: Record<(typeof HEADS)[number], string> = { end: "→", start: "←", both: "↔", none: "―" };

function renderBar(): void {
  const sel = selected();
  bar.replaceChildren();
  // ボタンは、まとまりごとに 1 つの入れ物へ入れる。バーが折り返すときに、まとまりの間で折り返すようにする
  let group = div("flex items-center gap-1");
  const add = (...nodes: Node[]): void => {
    if (!group.isConnected) bar.append(group);
    group.append(...nodes);
  };
  const sep = (): void => {
    if (group.childElementCount > 0) group = div("flex items-center gap-1");
  };
  // 文字を編集している間は、選んだ要素のバーの代わりに、装飾のバーを出す
  if (editing?.rich && !exporting) {
    bar.hidden = false;
    add(button("B", false, () => applyMarkup("bold"), "太字（⌘B）"), button("I", false, () => applyMarkup("italic"), "斜体（⌘I）"), button("S", false, () => applyMarkup("strike"), "取り消し線（⌘⇧X）"));
    sep();
    for (const c of MARK_COLORS) {
      const b = button("", false, () => applyMarkup(c), c === "yellow" ? "蛍光ペン（⌘⇧H）" : `蛍光ペン（${COLOR_LABEL[c]}）`);
      b.className = `chrome-swatch hl-swatch hl-${c}`;
      add(b);
    }
    return;
  }
  bar.hidden = sel.length === 0 || exporting;
  if (sel.length === 0) return;
  // 固定した要素を選んでいる間は、固定を外すボタンだけを出す（色や形も、固定を外すまで変えられない）
  if (sel.some(isLocked)) {
    add(button("固定を外す", true, () => void setOps(sel.filter(isLocked).map((e) => ({ id: e.id, patch: { locked: null } })))));
    return;
  }
  const patchAll = (types: readonly string[], patch: Record<string, unknown>): void => {
    void setOps(sel.filter((e) => types.includes(e.type)).map((e) => ({ id: e.id, patch })));
  };
  const has = (type: string): boolean => sel.some((e) => e.type === type);
  const colored = ["shape", "container", "text", "arrow", "stroke"];
  if (sel.some((e) => colored.includes(e.type))) {
    for (const c of COLORS) {
      const b = button("", false, () => patchAll(colored, { color: c }), COLOR_LABEL[c]);
      b.className = `chrome-swatch c-${c}`;
      add(b);
    }
  }
  const first = sel[0];
  if (has("shape")) {
    sep();
    const shapes = sel.filter((e) => e.type === "shape");
    const all = (test: (e: El) => boolean): boolean => shapes.every(test);
    // 形は数が多いので、ボタンを並べずに一覧から選ぶ
    add(
      picker("形", SHAPES, SHAPE_LABEL, shared(shapes.map((e) => e.shape ?? "note")), (v) => patchAll(["shape"], { shape: v })),
      // 状態を外すときは、持ち越しの日付も消す（日付だけが残ると、持ち越しの札が出続ける）。日付と一緒に書けない状態（決定、優先）を選んだときも消す
      picker("状態", STATUS_OPTIONS, STATUS_OPTION_LABEL, shared(shapes.map((e) => statusBadge(e)?.status ?? "none")), (v) => patchAll(["shape"], v === "none" ? { status: null, carriedFrom: null } : CARRIABLE.some((s) => s === v) ? { status: v } : { status: v, carriedFrom: null })),
      button("塗りなし", all((e) => e.hollow === true), () => patchAll(["shape"], { hollow: all((e) => e.hollow === true) ? null : true })),
      button("点線", all((e) => e.dashed === true), () => patchAll(["shape"], { dashed: all((e) => e.dashed === true) ? null : true })),
    );
    // 見出しの無い付箋には、ダブルクリックで直す先が無いので、ここから足す
    if (sel.length === 1 && first?.type === "shape") add(button("見出し", false, () => editNoteTitle(first), "見出しを書く（空にすると消える）"), button("期限", false, () => editNoteDue(first), "宿題の期限を書く（空にすると消える）"));
  }
  if (has("text") || has("shape")) {
    // 文字の大きさと寄せ。文字（text）と図形の両方に効く
    sep();
    const texty = sel.filter((e) => e.type === "text" || e.type === "shape");
    // 書いていないときの既定。大きさは、文字が本文、図形は少し小さい 15px（一覧に無いので、選ばれていない状態で出す）
    const size = shared(texty.map((e) => e.size ?? (e.type === "text" ? "m" : null)));
    const align = shared(texty.map((e) => e.align ?? (e.type === "text" || (e.shape ?? "note") === "note" ? "left" : "center")));
    add(
      picker("文字の大きさ", SIZES, SIZE_LABEL, size, (v) => patchAll(["text", "shape"], { size: v })),
      picker("文字の寄せ", ALIGNS, ALIGN_LABEL, align, (v) => patchAll(["text", "shape"], { align: v })),
    );
  }
  if (has("arrow")) {
    sep();
    add(button("点線", sel.every((e) => e.type !== "arrow" || e.dashed === true), () => patchAll(["arrow"], { dashed: !sel.every((e) => e.type !== "arrow" || e.dashed === true) })));
    const elbow = sel.every((e) => e.type !== "arrow" || e.route === "elbow");
    // 折れ線をやめるときは、折れ目の位置も消す（まっすぐな線には意味が無い）
    add(button("折れ線", elbow, () => patchAll(["arrow"], elbow ? { route: null, bends: null } : { route: "elbow" })));
    // 端ごとの形（startHead・endHead）が書かれていたら消して、ここで選んだ向きに合わせる
    for (const h of HEADS) add(button(HEADS_LABEL[h], sel.length === 1 && (first?.heads ?? "end") === h, () => patchAll(["arrow"], { heads: h, startHead: null, endHead: null })));
  }
  if (has("container")) {
    // 中身の並べ方。列の数を選ぶと、中身を詰めて並べ、セクションの高さを中身に合わせる
    sep();
    const now = shared(sel.filter((e) => e.type === "container" && e.frame !== "none").map((e) => String(e.cols ?? 0)));
    if (sel.length === 1 && first?.type === "container") {
      const on = focusId === first.id;
      add(button("注目", on, () => sendFocus(on ? null : first.id), "このセクションを残して、ほかを薄くする"));
    }
    // 透明な枠には、論点・結論と、列の並べ方を書けない（model.ts の parseEl が断る）
    const framed = sel.filter((e) => e.type === "container" && e.frame !== "none");
    if (sel.length === 1 && first?.type === "container" && first.frame !== "none") add(button("論点", false, () => editSectionField(first, "question"), "論点を書く"), button("結論", false, () => editSectionField(first, "answer"), "結論を書く"));
    if (framed.length > 0) add(picker("中身の並べ方", COLS_OPTIONS, COLS_LABEL, COLS_OPTIONS.find((o) => o === now) ?? null, (v) => void setOps(framed.map((e) => ({ id: e.id, patch: { cols: v === "0" ? null : Number(v) } })))));
  }
  if (sel.length === 1 && first?.type === "gantt") {
    sep();
    const unit = first.unit ?? "month";
    const bars = first.bars ?? [];
    const UNIT_LABEL: Record<(typeof GANTT_UNITS)[number], string> = { day: "日", week: "週", month: "月" };
    const pick = picker("目盛りの単位", GANTT_UNITS, UNIT_LABEL, unit, (v) => void setOps([{ id: first.id, patch: { unit: v } }]));
    // 足す行は、表示している範囲の最初の目盛りに置く。人がそこから帯を動かして合わせる
    const tick = ganttLayout(first).ticks[0];
    const added: GanttBar | null = tick ? { name: "新しい行", start: formatDay(tick.from, unit === "month"), end: formatDay(tick.to, unit === "month") } : null;
    add(
      pick,
      button("行＋", false, () => added && void setOps([{ id: first.id, patch: { bars: [...bars, added] } }])),
      button("行−", false, () => bars.length > 1 && void setOps([{ id: first.id, patch: { bars: bars.slice(0, -1) } }])),
    );
  }
  if (sel.length === 1 && first?.type === "table") {
    sep();
    const cols = tableCols(first);
    const rows = first.rows ?? [];
    const blank = (n: number): string[] => Array.from({ length: n }, () => "");
    const pad = (r: string[]): string[] => [...r, ...blank(Math.max(0, cols - r.length))];
    const table = (patch: Record<string, unknown>): void => void setOps([{ id: first.id, patch }]);
    add(
      button("行＋", false, () => table({ rows: [...rows, blank(cols)] })),
      button("行−", false, () => rows.length > 1 && table({ rows: rows.slice(0, -1) })),
      button("列＋", false, () => table({ rows: rows.map((r) => [...pad(r), ""]), ...(first.head ? { head: [...pad(first.head), ""] } : {}) })),
      button("列−", false, () => cols > 1 && table({ rows: rows.map((r) => pad(r).slice(0, -1)), ...(first.head ? { head: pad(first.head).slice(0, -1) } : {}) })),
    );
  }
  sep();
  add(button("前面", false, () => reorder("front"), "前面へ（]）"), button("背面", false, () => reorder("back"), "背面へ（[）"));
  sep();
  add(button("固定", false, () => void setOps(sel.map((e) => ({ id: e.id, patch: { locked: true } }))), "動かせず、消せないようにする"));
  sep();
  add(button("削除", false, () => void removeEls([...selection])));
}

/** セクションの論点か結論を、人が直す。空にすると消す */
function editSectionField(el: El, key: "question" | "answer"): void {
  const v = prompt(key === "question" ? "セクションの論点" : "セクションの結論", el[key] ?? "");
  if (v !== null) void setOps([{ id: el.id, patch: { [key]: v === "" ? null : v } }]);
}

/** 付箋の見出しを、人が足すか直す。空にすると消す */
function editNoteTitle(el: El): void {
  const v = prompt("付箋の見出し", el.title ?? "");
  if (v !== null) void setOps([{ id: el.id, patch: { title: v === "" ? null : v } }]);
}

/** 付箋の期限を、人が足すか直す。空にすると消す。日付でない入力は、サーバーが断った理由が知らせに出る */
function editNoteDue(el: El): void {
  // WHY 期限が無ければ今日を入れておく: 年から打たずに、日を直すだけで済む
  const v = prompt("期限（YYYY-MM-DD。空にすると消える）", el.due ?? localDay(new Date()));
  if (v !== null) void setOps([{ id: el.id, patch: { due: v.trim() === "" ? null : v.trim() } }]);
}

/** 選んだ要素を、前面か背面へ動かす */
function reorder(to: "front" | "back"): void {
  // 背面へ送るときは逆の順に送る。選んだ要素どうしの前後を保つため
  const ids = to === "front" ? [...selection] : [...selection].reverse();
  void commit(ids.map((id) => ({ op: "order", id, to })), null);
}

// ---- 文字の編集 ----

function startEdit(id: string, target: EventTarget | null): void {
  const el = els.get(id);
  if (!el) return;
  if (el.type === "arrow") {
    const v = prompt("矢印のラベル", el.label ?? "");
    if (v !== null) void setOps([{ id, patch: { label: v === "" ? null : v } }]);
    return;
  }
  // 透明な枠には、直す文字が無い
  if (el.type === "container" && el.frame === "none") return;
  if (el.type === "container" && target instanceof Element && target.closest(".sq, .sa")) {
    editSectionField(el, target.closest(".sq") ? "question" : "answer");
    return;
  }
  if (el.type === "summary") {
    // 帯で直せるのは題名だけ。行の中身は、元の付箋で直す
    const v = prompt("まとめの帯の題名（空にすると、状態の名前に戻る）", el.title ?? "");
    if (v !== null) void setOps([{ id, patch: { title: v === "" ? null : v } }]);
    return;
  }
  if (el.type === "gantt") {
    // 行の名前の上なら行の名前を、それ以外なら題名を直す
    const row = target instanceof Element ? target.closest("[data-bar]") : null;
    const index = row instanceof HTMLElement ? Number(row.dataset.bar) : -1;
    const bar = el.bars?.[index];
    if (bar) {
      const v = prompt("行の名前", bar.name);
      if (v !== null && v !== "") void setOps([{ id, patch: { bars: (el.bars ?? []).map((b, i) => (i === index ? { ...b, name: v } : b)) } }]);
    } else {
      const v = prompt("ガントチャートの題名", el.title ?? "");
      if (v !== null) void setOps([{ id, patch: { title: v === "" ? null : v } }]);
    }
    return;
  }
  const n = nodes.get(id);
  if (!n) return;
  let field: Element | null = null;
  let single = false;
  // 装飾の記号が効かない欄（セクションの題名、付箋の見出し）
  let plain = el.type === "container";
  // 直す前の、書かれたままの文字。画面には装飾した結果が出ているので、欄にはこれを入れ直す
  let raw: string;
  let save: (value: string) => Record<string, unknown>;
  switch (el.type) {
    case "shape":
    case "text": {
      // 付箋の見出しの上で始めたら、見出しを直す。空にすると、見出しを消す
      const heading = target instanceof Element ? target.closest(".ntitle") : null;
      if (heading) {
        field = heading;
        single = true;
        plain = true;
        raw = el.title ?? "";
        save = (t) => ({ title: t === "" ? null : t });
        break;
      }
      field = n.querySelector(".txt");
      raw = el.text ?? "";
      save = (text) => ({ text });
      break;
    }
    case "container":
      field = n.querySelector(".ttl");
      single = true;
      raw = el.title ?? "";
      save = (t) => ({ title: t });
      break;
    case "table": {
      field = (target instanceof Element ? target.closest("td, th") : null) ?? n.querySelector("td, th");
      single = true;
      const cell = field instanceof HTMLElement ? field : null;
      const r = Number(cell?.dataset.r ?? 0);
      const c = Number(cell?.dataset.c ?? 0);
      const cols = tableCols(el);
      raw = (r < 0 ? el.head : el.rows?.[r])?.[c] ?? "";
      const fill = (row: string[], value: string): string[] => Array.from({ length: cols }, (_, i) => (i === c ? value : (row[i] ?? "")));
      save = (value) => (r < 0 ? { head: fill(el.head ?? [], value) } : { rows: (el.rows ?? []).map((row, i) => (i === r ? fill(row, value) : row)) });
      break;
    }
    default:
      return;
  }
  if (!(field instanceof HTMLElement)) return;
  field.textContent = raw;
  editing = { id, field, before: raw, single, rich: !plain, save };
  renderBar();
  field.contentEditable = "plaintext-only";
  field.focus();
  const range = document.createRange();
  range.selectNodeContents(field);
  const s = getSelection();
  s?.removeAllRanges();
  s?.addRange(range);
  field.addEventListener("blur", finishEdit, { once: true });
}

function finishEdit(): void {
  const e = editing;
  if (!e) return;
  editing = null;
  // WHY 末尾の改行を 1 つ落とす: plaintext-only の欄は、行末で Enter を押すと改行を 2 つ入れる（Chrome で確認）
  const value = (e.field.textContent ?? "").replace(/\n$/, "");
  e.field.removeAttribute("contenteditable");
  e.field.blur();
  getSelection()?.removeAllRanges();
  const el = els.get(e.id);
  if (!el) return;
  if (el.type === "text" && value.trim() === "") void removeEls([e.id]);
  else if (value !== e.before) void setOps([{ id: e.id, patch: e.save(value) }]);
  else renderEl(el);
  // 編集中の装飾のバーを、選んだ要素のバーへ戻す
  renderBar();
}

/** 編集中の欄で、選んだ範囲に装飾の記号を付けるか外す。書き込むのは、記号つきの文字のまま */
function applyMarkup(kind: MarkupKind): void {
  const e = editing;
  const sel = getSelection();
  if (!e?.rich || !sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!e.field.contains(range.startContainer) || !e.field.contains(range.endContainer)) return;
  // 選んだ範囲が、欄の文字の何文字めから何文字めかを数える
  const lead = document.createRange();
  lead.selectNodeContents(e.field);
  lead.setEnd(range.startContainer, range.startOffset);
  const start = lead.toString().length;
  const next = toggleMarkup(e.field.textContent ?? "", start, start + range.toString().length, kind);
  // 欄の中身を 1 つの文字の並びに入れ直してから、記号を除いた中身を選び直す
  e.field.textContent = next.text;
  const node = e.field.firstChild;
  if (!node) return;
  const picked = document.createRange();
  picked.setStart(node, next.start);
  picked.setEnd(node, next.end);
  sel.removeAllRanges();
  sel.addRange(picked);
}

// ---- ポインターの操作 ----

function setTool(next: Tool): void {
  tool = next;
  for (const b of document.querySelectorAll("#tools button")) b.setAttribute("aria-pressed", String(b.getAttribute("data-tool") === next));
  stage.classList.toggle("tool-add", next !== "select");
}

/** マウスが上にある透明な枠の id。いちばん内側（面積がいちばん小さい）もの */
let hoverFrame: string | null = null;
/**
 * マウスの位置から、輪郭を出す透明な枠を決めて、印（hover）を付け替える。
 * WHY 位置で決める: 透明な枠は、中の空いた所で範囲選択を始められるように、マウスを受けない（pointer-events: none）。:hover が効かない
 */
function trackFrameHover(p: Point): void {
  let best: { id: string; area: number } | null = null;
  for (const el of els.values()) {
    if (el.type !== "container" || el.frame !== "none") continue;
    const b = boxOf(el);
    if (!b || p[0] < b.x || p[0] > b.x + b.w || p[1] < b.y || p[1] > b.y + b.h) continue;
    if (!best || b.w * b.h < best.area) best = { id: el.id, area: b.w * b.h };
  }
  const next = best?.id ?? null;
  if (next === hoverFrame) return;
  for (const id of [hoverFrame, next]) if (id !== null) nodes.get(id)?.classList.toggle("hover", id === next);
  hoverFrame = next;
}

function hitId(target: EventTarget | null): string | null {
  return target instanceof Element ? (target.closest("[data-id]")?.getAttribute("data-id") ?? null) : null;
}

function positionPatch(el: El): Record<string, unknown> {
  switch (el.type) {
    case "stroke":
      return { points: el.points };
    case "arrow":
      return { from: el.from, to: el.to };
    default:
      return { x: el.x, y: el.y };
  }
}

/** 動かす対象。選んだ要素と、選んだセクションの中身 */
function movingSet(): Map<string, El> {
  const out = new Map<string, El>();
  for (const el of selected()) {
    if (isLocked(el)) continue;
    if (el.type === "arrow" && typeof el.from === "string" && typeof el.to === "string") continue;
    out.set(el.id, el);
    // セクションと一緒に動く中身のうち、固定したものはその場に残す
    if (el.type === "container") for (const m of membersOf(els.values(), el)) if (!isLocked(m)) out.set(m.id, m);
  }
  return out;
}

function showMarquee(sx: number, sy: number, ev: PointerEvent): void {
  const r = stage.getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  marquee.hidden = false;
  marquee.style.left = `${Math.min(sx, x)}px`;
  marquee.style.top = `${Math.min(sy, y)}px`;
  marquee.style.width = `${Math.abs(x - sx)}px`;
  marquee.style.height = `${Math.abs(y - sy)}px`;
}

const round = (v: number): number => Math.round(v);

async function placeAt(p: Point, target: EventTarget | null): Promise<void> {
  const [x, y] = [round(p[0]), round(p[1])];
  let raw: Record<string, unknown>;
  switch (tool) {
    case "note":
      raw = { type: "shape", shape: "note", color: "yellow", x: x - 110, y: y - 55, w: 220, h: 110, text: "" };
      break;
    case "shape":
      raw = { type: "shape", shape: "rect", color: "white", x: x - 80, y: y - 40, w: 160, h: 80, text: "" };
      break;
    case "text":
      raw = { type: "text", x, y: y - 12, text: "" };
      break;
    case "table":
      raw = { type: "table", x, y, head: ["", ""], rows: [["", ""], ["", ""]] };
      break;
    default:
      return;
  }
  setTool("select");
  const el = await addEl(raw);
  if (!el) return;
  select([el.id]);
  startEdit(el.id, target);
}

stage.addEventListener("pointerdown", (ev) => {
  if (exporting) return;
  if (editing && ev.target instanceof Node && editing.field.contains(ev.target)) return;
  // コメントのやりとりの中は、ふつうの入力欄とボタンとして働かせる
  if (ev.target instanceof Element && ev.target.closest(".cpanel")) return;
  finishEdit();
  const pinId = ev.target instanceof Element && ev.target.closest(".cpin") ? hitId(ev.target) : null;
  if (openComment && openComment !== pinId) closeComment();
  const p = toWorld(ev);
  const r = stage.getBoundingClientRect();
  const sx = ev.clientX - r.left;
  const sy = ev.clientY - r.top;
  if (ev.button === 1 || (ev.button === 0 && spaceDown)) {
    gesture = { kind: "pan", sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };
    stage.classList.add("panning");
  } else if (ev.button !== 0) {
    return;
  } else if (tool === "select") {
    const id = hitId(ev.target);
    if (ev.target instanceof Element && ev.target.closest(".handle")) {
      const el = selected()[0];
      const b = el ? rectOf(el) : null;
      if (el && b) gesture = { kind: "resize", start: p, orig: el, w: b.w, h: b.h };
    } else if (id) {
      // 固定した要素は、選ぶことだけできる（固定を外すため）。動かす、直す、ガントの帯を動かす操作は始めない
      // まとめの帯の行。動かさずに離したら、元の付箋へ移る
      const rowNode = ev.target instanceof Element ? ev.target.closest(".srow[data-target]") : null;
      const jump = rowNode instanceof HTMLElement ? (rowNode.dataset.target ?? null) : null;
      if (isLocked(els.get(id))) {
        // 固定した帯でも、行から元の付箋へは移れる（読むための操作なので）
        if (jump) {
          jumpTo(jump);
          return;
        }
        select(ev.shiftKey ? [...selection, id] : [id]);
        // コメントの印だけは、固定していても開ける（読むための操作なので）
        if (pinId && openComment === pinId) closeComment();
        else if (pinId) openCommentPanel(pinId);
        return;
      }
      const now = performance.now();
      // WHY 場所も見る: 大きな要素（ガントの帯など）の別の場所を続けてつかんだときに、ダブルクリックと取り違えない
      const near = Math.hypot(ev.clientX - lastDown.x, ev.clientY - lastDown.y) < 6;
      const double = lastDown.id === id && now - lastDown.at < 400 && near;
      lastDown = { id, at: now, x: ev.clientX, y: ev.clientY };
      if (double) {
        select([id]);
        startEdit(id, ev.target);
        ev.preventDefault();
        return;
      }
      // ガントの帯の上で押したら、要素を動かすのではなく、その行の日付を動かす
      const barNode = ev.target instanceof Element ? ev.target.closest(".gbar") : null;
      const hitEl = els.get(id);
      if (barNode instanceof HTMLElement && hitEl?.type === "gantt") {
        const grip = ev.target instanceof Element ? ev.target.closest("[data-edge]") : null;
        const edge = grip instanceof HTMLElement ? grip.dataset.edge : undefined;
        select([id]);
        gesture = { kind: "gantt", id, index: Number(barNode.dataset.bar ?? 0), seg: Number(barNode.dataset.seg ?? 0), edge: edge === "start" || edge === "end" ? edge : "move", startX: p[0], orig: hitEl };
        stage.setPointerCapture(ev.pointerId);
        return;
      }
      if (ev.shiftKey) select(selection.has(id) ? [...selection].filter((x) => x !== id) : [...selection, id]);
      else if (!selection.has(id)) select([id]);
      const link = ev.target instanceof Element ? ev.target.closest("a[href]") : null;
      gesture = { kind: "move", start: p, orig: movingSet(), moved: false, pinId, link: link instanceof HTMLAnchorElement ? link : null, jump };
    } else {
      if (!ev.shiftKey) select([]);
      gesture = { kind: "marquee", start: p, sx, sy, purpose: "select", onId: null };
    }
  } else if (tool === "container") {
    gesture = { kind: "marquee", start: p, sx, sy, purpose: "container", onId: null };
  } else if (tool === "comment") {
    const under = hitId(ev.target);
    const onEl = under ? els.get(under) : undefined;
    // 押した場所に要素があれば、その要素を指すピンにする（線とコメントは指せない）
    const onId = onEl && onEl.type !== "arrow" && onEl.type !== "stroke" && onEl.type !== "comment" ? onEl.id : null;
    gesture = { kind: "marquee", start: p, sx, sy, purpose: "comment", onId };
  } else if (tool === "arrow") {
    gesture = { kind: "arrow", from: hitId(ev.target) ?? [round(p[0]), round(p[1])], start: p };
    preview = svg("path", { class: "preview", d: "" });
  } else if (tool === "pen") {
    gesture = { kind: "pen", points: [p] };
    preview = svg("path", { class: "preview", d: "" });
  } else {
    void placeAt(p, ev.target);
    ev.preventDefault();
    return;
  }
  if (gesture) stage.setPointerCapture(ev.pointerId);
});

stage.addEventListener("pointermove", (ev) => {
  const g = gesture;
  if (!g) {
    if (!exporting) trackFrameHover(toWorld(ev));
    return;
  }
  const p = toWorld(ev);
  switch (g.kind) {
    case "pan":
      view.x = g.vx + ev.clientX - g.sx;
      view.y = g.vy + ev.clientY - g.sy;
      applyView();
      break;
    case "move": {
      const dx = round(p[0] - g.start[0]);
      const dy = round(p[1] - g.start[1]);
      if (!g.moved && Math.hypot(dx, dy) * view.k < 3) return;
      g.moved = true;
      for (const orig of g.orig.values()) {
        const next = shifted(orig, dx, dy);
        els.set(next.id, next);
        renderEl(next);
      }
      renderLines();
      positionHandle();
      break;
    }
    case "resize": {
      // まとめの帯は、幅の下限で止める（それより狭い幅は、サーバーが断る）
      const w = Math.max(g.orig.type === "summary" ? SUMMARY_MIN_W : 40, round(g.w + p[0] - g.start[0]));
      const h = Math.max(30, round(g.h + p[1] - g.start[1]));
      const local = els.get(g.orig.id) ?? g.orig;
      const next: El = widthOnly(g.orig) ? { ...local, w } : { ...local, w, h };
      els.set(next.id, next);
      renderEl(next);
      renderLines();
      positionHandle();
      break;
    }
    case "marquee":
      showMarquee(g.sx, g.sy, ev);
      break;
    case "gantt": {
      const bar = g.orig.bars?.[g.index];
      const seg = bar ? segmentsOf(bar)[g.seg] : undefined;
      if (!bar || !seg) return;
      const days = Math.round((p[0] - g.startX) / ganttLayout(g.orig).pxPerDay);
      const period = dragBar(seg, g.orig.unit ?? "month", g.edge, days);
      // つかんだ帯だけを動かす。期間の並び（segments）で書かれた行は、その 1 つだけを書き換える
      const moved: GanttBar = bar.segments ? { ...bar, segments: bar.segments.map((s, j) => (j === g.seg ? { ...s, ...period } : s)) } : { ...bar, ...period };
      const next: El = { ...(els.get(g.id) ?? g.orig), bars: (g.orig.bars ?? []).map((b, i) => (i === g.index ? moved : b)) };
      els.set(next.id, next);
      renderEl(next);
      break;
    }
    case "arrow": {
      const a = anchor(g.from);
      preview?.setAttribute("d", pathOf([a ? edgeToward(a, p) : g.start, p]));
      break;
    }
    case "pen": {
      const last = g.points[g.points.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) * view.k < 2) return;
      g.points.push(p);
      preview?.setAttribute("d", pathOf(g.points));
      break;
    }
  }
  if (preview && !preview.isConnected) lines.append(preview);
});

function endGesture(ev: PointerEvent): void {
  const g = gesture;
  if (!g) return;
  gesture = null;
  preview?.remove();
  preview = null;
  marquee.hidden = true;
  stage.classList.remove("panning");
  const p = toWorld(ev);
  switch (g.kind) {
    case "pan":
      break;
    case "move": {
      if (!g.moved) {
        // コメントの印を、動かさずに離した。やりとりを開く（開いていれば閉じる）
        // WHY ここで開く: 押している間はポインターを stage が受け取るので、リンクそのもののクリックは起きない
        if (g.link) void openLink(g.link);
        if (g.jump) jumpTo(g.jump);
        if (g.pinId && openComment === g.pinId) closeComment();
        else if (g.pinId) openCommentPanel(g.pinId);
        break;
      }
      const ops: unknown[] = [];
      for (const orig of g.orig.values()) {
        const now = els.get(orig.id);
        if (now) ops.push({ op: "set", id: orig.id, patch: positionPatch(now) });
      }
      void commit(ops, { origin: g.orig });
      break;
    }
    case "gantt": {
      const now = els.get(g.id);
      if (!now || JSON.stringify(now.bars) === JSON.stringify(g.orig.bars)) break;
      void commit([{ op: "set", id: g.id, patch: { bars: now.bars } }], { origin: new Map([[g.id, g.orig]]) });
      break;
    }
    case "resize": {
      const now = els.get(g.orig.id);
      if (!now) break;
      const patch: Record<string, unknown> = widthOnly(g.orig) ? { w: now.w } : { w: now.w, h: now.h };
      void commit([{ op: "set", id: now.id, patch }], { origin: new Map([[now.id, g.orig]]) });
      break;
    }
    case "marquee": {
      const x = Math.min(g.start[0], p[0]);
      const y = Math.min(g.start[1], p[1]);
      const w = Math.abs(p[0] - g.start[0]);
      const h = Math.abs(p[1] - g.start[1]);
      if (g.purpose === "comment") {
        setTool("select");
        // 枠を描いたら範囲のコメント、押しただけなら 1 点のピン
        const area = w * view.k > 20 && h * view.k > 20;
        const raw = area ? { type: "comment", x: round(x), y: round(y), w: round(w), h: round(h) } : { type: "comment", x: round(p[0]), y: round(p[1]), ...(g.onId ? { on: g.onId } : {}) };
        void addEl(raw).then((el) => el && openCommentPanel(el.id));
        break;
      }
      if (g.purpose === "container") {
        setTool("select");
        const big = w > 60 && h > 60;
        void addEl({ type: "container", x: round(big ? x : p[0]), y: round(big ? y : p[1]), ...(big ? { w: round(w), h: round(h) } : {}), title: "" }).then((el) => {
          if (!el) return;
          select([el.id]);
          startEdit(el.id, null);
        });
        break;
      }
      if (w * view.k < 3 && h * view.k < 3) break;
      const hit: string[] = ev.shiftKey ? [...selection] : [];
      for (const el of els.values()) {
        const b = rectOf(el) ?? (el.type === "arrow" ? arrowBox(el) : null);
        // 範囲で選ぶときは、隠れた要素と固定した要素を含めない（まとめて動かす・消す対象にしないため）
        if (!b || isHidden(el) || isLocked(el)) continue;
        const inside = b.x >= x && b.y >= y && b.x + b.w <= x + w && b.y + b.h <= y + h;
        const touch = b.x < x + w && x < b.x + b.w && b.y < y + h && y < b.y + b.h;
        // セクションは、全体を囲んだときだけ選ぶ。中の付箋を範囲で選ぶたびにセクションまで選ばれないようにする
        if (el.type === "container" || el.type === "arrow" ? inside : touch) hit.push(el.id);
      }
      select(hit);
      break;
    }
    case "arrow": {
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const to: End = hitId(under) ?? [round(p[0]), round(p[1])];
      const far = Math.hypot(p[0] - g.start[0], p[1] - g.start[1]) * view.k > 8;
      const toEl = typeof to === "string" ? els.get(to) : undefined;
      const lineEnd = toEl?.type === "arrow" || toEl?.type === "stroke";
      if (!far || to === g.from || lineEnd) break;
      setTool("select");
      void addEl({ type: "arrow", from: g.from, to }).then((el) => el && select([el.id]));
      break;
    }
    case "pen": {
      if (g.points.length < 2) break;
      void addEl({ type: "stroke", points: g.points.map((q): Point => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]) });
      break;
    }
  }
}

function arrowBox(el: El): Box | null {
  const points = arrowPoints(el);
  if (!points || points.length === 0) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

stage.addEventListener("pointerup", endGesture);
stage.addEventListener("pointercancel", endGesture);

stage.addEventListener(
  "wheel",
  (ev) => {
    // コメントのやりとりの欄の上では、欄の中をスクロールさせる。ボードは動かさない。
    // 欄が端まで来ても、ボードには渡さない（CSS の overscroll-behavior と合わせて止める）
    if (ev.target instanceof Element && ev.target.closest(".cpanel")) {
      // WHY ピンチだけは止める: 止めないと、ブラウザがページ全体を拡大する
      if (ev.ctrlKey || ev.metaKey) ev.preventDefault();
      return;
    }
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      const r = stage.getBoundingClientRect();
      zoomAt(ev.clientX - r.left, ev.clientY - r.top, view.k * Math.exp(-ev.deltaY * 0.01));
    } else {
      view.x -= ev.deltaX;
      view.y -= ev.deltaY;
      applyView();
    }
  },
  { passive: false },
);

document.addEventListener("keydown", (ev) => {
  if (ev.isComposing) return;
  // メモの欄に打っている間は、ツールの切り替えや削除のキーを効かせない
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLSelectElement) {
    if (ev.key === "Escape") ev.target.blur();
    return;
  }
  if (editing) {
    const mod = ev.metaKey || ev.ctrlKey;
    const key = ev.key.toLowerCase();
    const kind: MarkupKind | null = !mod || !editing.rich ? null : key === "b" && !ev.shiftKey ? "bold" : key === "i" && !ev.shiftKey ? "italic" : key === "h" && ev.shiftKey ? "yellow" : key === "x" && ev.shiftKey ? "strike" : null;
    if (kind) {
      ev.preventDefault();
      applyMarkup(kind);
    } else if (ev.key === "Escape" || (ev.key === "Enter" && (mod || (editing.single && !ev.shiftKey)))) {
      ev.preventDefault();
      finishEdit();
    }
    return;
  }
  if (document.activeElement === titleNode) {
    if (ev.key === "Enter" || ev.key === "Escape") {
      ev.preventDefault();
      titleNode.blur();
    }
    return;
  }
  if (ev.key === " ") {
    spaceDown = true;
    ev.preventDefault();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "z") {
    ev.preventDefault();
    void undo();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "a") {
    ev.preventDefault();
    select([...els.values()].filter((el) => !isHidden(el) && !isLocked(el)).map((el) => el.id));
  } else if ((ev.key === "]" || ev.key === "[") && selection.size > 0) {
    reorder(ev.key === "]" ? "front" : "back");
  } else if (ev.key === "Backspace" || ev.key === "Delete") {
    if (selection.size > 0) void removeEls([...selection]);
  } else if (ev.key === "Escape") {
    setTool("select");
    select([]);
  } else if (!ev.metaKey && !ev.ctrlKey && !ev.altKey) {
    const next = TOOL_KEYS[ev.key];
    if (next) setTool(next);
  }
});

document.addEventListener("keyup", (ev) => {
  if (ev.key === " ") spaceDown = false;
});

// ---- 操作の部品 ----

for (const b of document.querySelectorAll("#tools button")) {
  const name = b.getAttribute("data-tool");
  const t = TOOLS.find((x) => x === name);
  if (t) b.addEventListener("click", () => setTool(t));
}

const center = (): [number, number] => [stage.clientWidth / 2, stage.clientHeight / 2];
$("zoomin", HTMLButtonElement).addEventListener("click", () => zoomAt(...center(), view.k * 1.25));
$("zoomout", HTMLButtonElement).addEventListener("click", () => zoomAt(...center(), view.k / 1.25));
$("fit", HTMLButtonElement).addEventListener("click", fit);
undoButton.addEventListener("click", () => void undo());
$("unfocus", HTMLButtonElement).addEventListener("click", () => sendFocus(null));
// WHY mousedown を止める: 編集中に装飾のバーのボタンを押しても、編集中の欄からフォーカスを外さない
// （外れると、その時点で編集が確定して、選んでいた範囲も失われる）
bar.addEventListener("mousedown", (ev) => {
  if (editing) ev.preventDefault();
});
resolvedButton.addEventListener("click", () => {
  showResolved = !showResolved;
  // 隠す側へ切り替えたら、開いていた解決済みのコメントも閉じる
  const open = openComment ? els.get(openComment) : undefined;
  if (!showResolved && open?.resolved) closeComment();
  refresh();
});
undoButton.disabled = true;

pngButton.addEventListener("click", async () => {
  pngButton.disabled = true;
  try {
    // WHY fetch で受ける: <a download> で直接開くと、サーバーの失敗をこの画面で知らせられない
    const r = await api(`/api/shot?${boardQuery}`);
    if (!r.ok) {
      const j: unknown = await r.json();
      toast(isRecord(j) && typeof j.error === "string" ? j.error : "PNG を書き出せなかった");
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = `${(boardPath.split("/").pop() ?? "board").replace(/\.board\.json$/, "")}.board.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  } finally {
    pngButton.disabled = false;
  }
});

titleNode.addEventListener("dblclick", () => {
  titleNode.contentEditable = "plaintext-only";
  titleNode.focus();
});
titleNode.addEventListener("blur", () => {
  titleNode.removeAttribute("contenteditable");
  const next = (titleNode.textContent ?? "").trim();
  if (next !== title) void commit([{ op: "title", title: next }], { also: [{ op: "title", title }] }).then(() => setTitle(next));
});

// ---- 起動 ----

async function boot(): Promise<void> {
  setTool("select");
  applyView();
  if (boardPath === "") {
    toast("URL に board が無い。xwb open <ボードのファイル> で開く");
    return;
  }
  if (exporting) {
    document.body.classList.add("export");
    document.body.classList.toggle("with-comments", showComments);
    const r = await api(`/api/board?${boardQuery}`);
    loadSnapshot(await r.json());
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
    for (const el of els.values()) renderEl(el);
    renderLines();
    fit();
    return;
  }
  if (token === "") {
    toast("この URL にはトークンが無い。xwb open <ボードのファイル> で開き直す");
    return;
  }
  const es = new EventSource(`/api/events?${boardQuery}&client=${clientId}&${tokenQuery}`);
  // つながっている間は緑、切れている間は赤（index.html の初めの色）
  const showConnected = (on: boolean): void => {
    conn.classList.toggle("bg-success", on);
    conn.classList.toggle("bg-destructive", !on);
  };
  es.addEventListener("open", () => showConnected(true));
  es.addEventListener("error", () => showConnected(false));
  es.addEventListener("snapshot", (ev) => loadSnapshot(JSON.parse(ev.data)));
  es.addEventListener("claims", (ev) => renderClaims(JSON.parse(ev.data)));
  es.addEventListener("focus", (ev) => {
    const msg: unknown = JSON.parse(ev.data);
    setFocus(isRecord(msg) ? msg.id : null);
    refresh();
  });
  es.addEventListener("ops", (ev) => {
    const msg: unknown = JSON.parse(ev.data);
    if (!isRecord(msg)) return;
    const upserts = parseEls(msg.upserts);
    if (Array.isArray(msg.removed)) for (const id of msg.removed) if (typeof id === "string") drop(id);
    // Claude の返事が届いたコメントは、開くまで印を目立たせる
    if (msg.client !== clientId) {
      for (const el of upserts) if (el.type === "comment" && el.id !== openComment && el.thread?.at(-1)?.by === "claude") unread.add(el.id);
    }
    for (const el of upserts) upsert(el);
    if (typeof msg.title === "string") setTitle(msg.title);
    applyOrder(msg.order);
    // 自分の操作は光らせない。光るのは、エージェントやほかの画面が書いたものだけ
    if (msg.client !== clientId) flash(upserts.map((e) => e.id));
    refresh();
  });
  window.addEventListener("resize", applyView);
}

void boot();
