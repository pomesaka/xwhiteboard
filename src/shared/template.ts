// 型（2×2 の matrix、左右の立場を並べる versus、論点を分ける tree）を、ふつうの要素を足す操作の並びに展開する。
// WHY 専用の要素にしない: 展開した後は、セクション・付箋・文字・矢印なので、人がいつもの操作で直せて、見た目の検査もそのまま効く。
// エージェントは中身を渡すだけで、座標と大きさはここで決める。
import { COLORS, DEFAULT_SIZE, GAP, PAD, TITLE_H, colWidth, isRecord, type Point, type Res } from "./model.ts";

export const TEMPLATES = ["matrix", "versus", "tree"] as const;

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * 付箋の既定の大きさ。枠の中の付箋の高さと、木の箱の幅に使う。
 * WHY 関数で読む: model.ts とは互いに import していて、このファイルが先に評価される。
 * 定数に取ると、DEFAULT_SIZE がまだ初期化されていない時点で読むことになる。
 */
const noteSize = (): { w: number; h: number } => DEFAULT_SIZE.shape;
/** 枠の幅。w（型の全体の幅）を書かなかったとき */
const CELL_W = 400;
/** 枠は、これより狭くしない。枠が 200 のとき、中の付箋の幅は 152（全角 8 文字で折り返す）。これより狭い付箋は、文字が入らない */
const MIN_CELL_W = 200;
/** versus の、左右の枠の間（「vs」を置く幅） */
const VS_W = 80;
/** 2×2 の、縦の軸の名前を置く幅 */
const SIDE_W = 150;
const HEAD_H = 34;
const TITLE_ROW = 64;
/** 木の箱の高さと、段の間。箱の幅は、付箋の既定の幅 */
const NODE_H = 72;
const NODE_GAP_X = 70;
const MAX_TREE_NODES = 40;

/** 付箋に渡せる項目。場所と大きさは、型が決める */
const NOTE_KEYS = ["text", "title", "who", "status", "carriedFrom", "tag", "color"];

type Ops = Record<string, unknown>[];

interface Cell {
  title: string;
  color?: string;
  items: Record<string, unknown>[];
}

/** 付箋 1 枚ぶんの中身。文字だけなら本文、オブジェクトなら付箋の欄 */
function parseItem(raw: unknown, where: string): Res<Record<string, unknown>> {
  if (typeof raw === "string") return { ok: true, value: { text: raw } };
  if (!isRecord(raw)) return fail(`${where} は、文字か、付箋の欄（title・text・who・status・carriedFrom・tag・color）のオブジェクト`);
  for (const k of Object.keys(raw)) if (!NOTE_KEYS.includes(k)) return fail(`${where} に ${k} は書けない。場所と大きさは型が決める。書ける項目: ${NOTE_KEYS.join(", ")}`);
  if (raw.text === undefined && raw.title === undefined) return fail(`${where} には text か title が要る`);
  return { ok: true, value: raw };
}

function parseCell(raw: unknown, where: string): Res<Cell> {
  if (!isRecord(raw)) return fail(`${where} は { title, items }`);
  for (const k of Object.keys(raw)) if (!["title", "color", "items"].includes(k)) return fail(`${where} に ${k} は無い。書ける項目: title, color, items`);
  if (typeof raw.title !== "string" || raw.title === "") return fail(`${where} には title（その枠の名前）が要る`);
  if (raw.color !== undefined && !COLORS.some((c) => c === raw.color)) return fail(`${where} の color は ${COLORS.join(" | ")} のどれか`);
  const list = raw.items ?? [];
  if (!Array.isArray(list)) return fail(`${where} の items は配列`);
  const items: Record<string, unknown>[] = [];
  for (const [i, it] of list.entries()) {
    const r = parseItem(it, `${where}.items[${i}]`);
    if (!r.ok) return r;
    items.push(r.value);
  }
  return { ok: true, value: { title: raw.title, ...(typeof raw.color === "string" ? { color: raw.color } : {}), items } };
}

/** 付箋を 1 列に積んだ枠の高さ */
function cellHeight(count: number): number {
  return TITLE_H + Math.max(1, count) * (noteSize().h + GAP) - GAP + PAD;
}

/** 枠（セクション）と、その中の付箋。高さは、横に並ぶ枠とそろえるために外から渡す */
function cellOps(id: string, cell: Cell, x: number, y: number, w: number, h: number): Ops {
  const noteW = colWidth({ x, y, w, h }, 1);
  const noteH = noteSize().h;
  return [
    { op: "add", el: { id, type: "container", title: cell.title, x, y, w, h, ...(cell.color === undefined ? {} : { color: cell.color }) } },
    // WHY 白: 付箋の既定の黄色だと、枠の色と合わせて 1 つの図に色が増え、色が意味を持たなくなる。色は、書いたときだけ付ける
    ...cell.items.map((it, i) => ({ op: "add", el: { type: "shape", color: "white", ...it, id: `${id}-${i + 1}`, x: x + PAD, y: y + TITLE_H + i * (noteH + GAP), w: noteW, h: noteH } })),
  ];
}

function heading(id: string, text: string, x: number, y: number, w: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { op: "add", el: { id, type: "text", text, x, y, w, align: "center", ...extra } };
}

/**
 * 枠 1 つの幅。w（型の全体の幅）から、枠でない部分（fixed）を引いて 2 つに分ける。
 */
function cellWidth(w: unknown, fixed: number): Res<number> {
  if (w === undefined) return { ok: true, value: CELL_W };
  if (typeof w !== "number" || !Number.isFinite(w)) return fail("w は数値（型の全体の幅）");
  const cell = Math.floor((w - fixed) / 2);
  if (cell < MIN_CELL_W) return fail(`w が狭すぎて、枠の幅が ${cell} になる。w は ${fixed + MIN_CELL_W * 2} 以上にする（枠の幅が ${MIN_CELL_W} 以上になる）`);
  return { ok: true, value: cell };
}

function axis(raw: unknown, where: string): Res<{ label: string; low: string; high: string }> {
  if (!isRecord(raw) || typeof raw.label !== "string" || typeof raw.low !== "string" || typeof raw.high !== "string") return fail(`${where} は { label, low, high }（軸の名前と、両端の名前）`);
  return { ok: true, value: { label: raw.label, low: raw.low, high: raw.high } };
}

/**
 * 2×2。横の軸は左が low・右が high、縦の軸は下が low・上が high。
 * cells は、画面の見た目どおりに [[左上, 右上], [左下, 右下]]。
 */
function matrix(op: Record<string, unknown>, id: string, [x0, y0]: Point): Res<Ops> {
  const xa = axis(op.xAxis, "xAxis");
  if (!xa.ok) return xa;
  const ya = axis(op.yAxis, "yAxis");
  if (!ya.ok) return ya;
  const rows = op.cells;
  if (!Array.isArray(rows) || rows.length !== 2 || !rows.every((r) => Array.isArray(r) && r.length === 2)) return fail("cells は [[左上, 右上], [左下, 右下]] の 2×2");
  const cells: Cell[][] = [];
  for (const [r, row] of rows.entries()) {
    const out: Cell[] = [];
    for (const [c, raw] of (Array.isArray(row) ? row : []).entries()) {
      const cell = parseCell(raw, `cells[${r}][${c}]`);
      if (!cell.ok) return cell;
      out.push(cell.value);
    }
    cells.push(out);
  }
  const cw = cellWidth(op.w, SIDE_W + GAP);
  if (!cw.ok) return cw;
  const cellW = cw.value;
  const ops: Ops = [];
  let y = y0;
  if (typeof op.title === "string" && op.title !== "") {
    ops.push(heading(`${id}-title`, op.title, x0, y, SIDE_W + cellW * 2 + GAP, { size: "l", align: "left" }));
    y += TITLE_ROW;
  }
  const left = x0 + SIDE_W;
  // 横の軸の名前と、両端の名前
  ops.push(heading(`${id}-x`, xa.value.label, left, y, cellW * 2 + GAP, { size: "s" }));
  y += HEAD_H - 8;
  ops.push(heading(`${id}-xl`, `**${xa.value.low}**`, left, y, cellW), heading(`${id}-xh`, `**${xa.value.high}**`, left + cellW + GAP, y, cellW));
  y += HEAD_H;
  const names = [
    ["tl", "tr"],
    ["bl", "br"],
  ];
  for (const [r, row] of cells.entries()) {
    const h = Math.max(...row.map((c) => cellHeight(c.items.length)));
    // 縦の軸は、上の段が high
    const side = r === 0 ? ya.value.high : ya.value.low;
    ops.push({ op: "add", el: { id: `${id}-y${r === 0 ? "h" : "l"}`, type: "text", text: `**${side}**`, x: x0, y: y + h / 2 - 12, w: SIDE_W - GAP, align: "right" } });
    if (r === 0) ops.push({ op: "add", el: { id: `${id}-y`, type: "text", text: ya.value.label, size: "s", x: x0, y: y - 4, w: SIDE_W - GAP, align: "right" } });
    for (const [c, cell] of row.entries()) ops.push(...cellOps(`${id}-${names[r]?.[c] ?? `${r}${c}`}`, cell, left + c * (cellW + GAP), y, cellW, h));
    y += h + GAP;
  }
  return { ok: true, value: ops };
}

/** 左右の立場と、それぞれの論点を並べる。真ん中に「vs」を置く */
function versus(op: Record<string, unknown>, id: string, [x0, y0]: Point): Res<Ops> {
  const left = parseCell(op.left, "left");
  if (!left.ok) return left;
  const right = parseCell(op.right, "right");
  if (!right.ok) return right;
  const cw = cellWidth(op.w, VS_W);
  if (!cw.ok) return cw;
  const cellW = cw.value;
  const ops: Ops = [];
  let y = y0;
  if (typeof op.title === "string" && op.title !== "") {
    ops.push(heading(`${id}-title`, op.title, x0, y, cellW * 2 + VS_W, { size: "l", align: "left" }));
    y += TITLE_ROW;
  }
  const h = Math.max(cellHeight(left.value.items.length), cellHeight(right.value.items.length));
  ops.push(...cellOps(`${id}-l`, { color: "blue", ...left.value }, x0, y, cellW, h));
  ops.push(heading(`${id}-vs`, "vs", x0 + cellW, y + h / 2 - 18, VS_W, { size: "l" }));
  ops.push(...cellOps(`${id}-r`, { color: "orange", ...right.value }, x0 + cellW + VS_W, y, cellW, h));
  return { ok: true, value: ops };
}

interface TreeNode {
  id: string;
  fields: Record<string, unknown>;
  children: TreeNode[];
  /** 葉の数。この節が縦に取る段の数 */
  leaves: number;
}

/** 論点を分けた木。根を左に置き、子を右へ並べる。親は、子の並びの真ん中の高さに置く */
function tree(op: Record<string, unknown>, id: string, [x0, y0]: Point): Res<Ops> {
  let count = 0;
  const parse = (raw: unknown, where: string): Res<TreeNode> => {
    const kids = isRecord(raw) ? (raw.children ?? []) : [];
    if (!Array.isArray(kids)) return fail(`${where}.children は配列`);
    const fields = typeof raw === "string" ? raw : isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "children")) : raw;
    const item = parseItem(fields, where);
    if (!item.ok) return item;
    count += 1;
    if (count > MAX_TREE_NODES) return fail(`木の節は ${MAX_TREE_NODES} まで。分けて描く`);
    const nodeId = `${id}-${count}`;
    const children: TreeNode[] = [];
    for (const [i, k] of kids.entries()) {
      const child = parse(k, `${where}.children[${i}]`);
      if (!child.ok) return child;
      children.push(child.value);
    }
    return { ok: true, value: { id: nodeId, fields: item.value, children, leaves: Math.max(1, children.reduce((n, c) => n + c.leaves, 0)) } };
  };
  const root = parse(op.root, "root");
  if (!root.ok) return root;
  const ops: Ops = [];
  let y = y0;
  if (typeof op.title === "string" && op.title !== "") {
    ops.push({ op: "add", el: { id: `${id}-title`, type: "text", text: op.title, size: "l", x: x0, y } });
    y += TITLE_ROW;
  }
  const arrows: Ops = [];
  const nodeW = noteSize().w;
  const slot = NODE_H + GAP;
  const place = (node: TreeNode, depth: number, top: number): void => {
    // 文字の多い節は、箱を高くせず、検査（small-text）に任せる。段の高さをそろえるため
    const ny = top + (node.leaves * slot - GAP) / 2 - NODE_H / 2;
    ops.push({ op: "add", el: { type: "shape", shape: "round", color: depth === 0 ? "ink" : node.children.length > 0 ? "blue" : "white", ...node.fields, id: node.id, x: x0 + depth * (nodeW + NODE_GAP_X), y: ny, w: nodeW, h: NODE_H } });
    let at = top;
    for (const child of node.children) {
      place(child, depth + 1, at);
      arrows.push({ op: "add", el: { id: `${node.id}-${child.id.slice(id.length + 1)}`, type: "arrow", from: node.id, to: child.id, route: "elbow", fromSide: "right", toSide: "left", heads: "none" } });
      at += child.leaves * slot;
    }
  };
  place(root.value, 0, y);
  return { ok: true, value: [...ops, ...arrows] };
}

/**
 * 型の操作（{ op: "template", kind, id?, x?, y?, … }）を、要素を足す操作の並びにする。
 * origin は、x・y を書かなかったときの左上。prefix は、id を書かなかったときの id の頭。
 */
export function expandTemplate(op: Record<string, unknown>, origin: Point, prefix: string): Res<Ops> {
  const kind = TEMPLATES.find((k) => k === op.kind);
  if (!kind) return fail(`kind は ${TEMPLATES.join(" | ")} のどれか`);
  const id = op.id ?? prefix;
  // 子の id は、この id に「-tl-12」のような尾を付ける。全体が 40 文字に収まる長さにする
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,24}$/.test(id)) return fail("id は英数字と - _ で 24 文字まで");
  const hasX = typeof op.x === "number" && Number.isFinite(op.x);
  const hasY = typeof op.y === "number" && Number.isFinite(op.y);
  if ((op.x !== undefined || op.y !== undefined) && !(hasX && hasY)) return fail("x と y は、両方を数値で書くか、両方とも書かない");
  const at: Point = typeof op.x === "number" && typeof op.y === "number" ? [op.x, op.y] : origin;
  // WHY tree に w が無い: 木の幅は、段の数と箱の幅で決まる。箱を狭めると文字が入らず、段の間を詰めると線が読めない
  if (kind === "tree" && op.w !== undefined) return fail("tree に w は書けない。木の幅は、段の数（深さ）と箱の幅で決まる。狭くするなら、木を浅くするか、分けて描く");
  const allowed: Record<(typeof TEMPLATES)[number], string[]> = { matrix: ["title", "w", "xAxis", "yAxis", "cells"], versus: ["title", "w", "left", "right"], tree: ["title", "root"] };
  for (const k of Object.keys(op)) if (!["op", "kind", "id", "x", "y", ...allowed[kind]].includes(k)) return fail(`${kind} に ${k} は無い。書ける項目: id, x, y, ${allowed[kind].join(", ")}`);
  if (op.title !== undefined && typeof op.title !== "string") return fail("title は文字列");
  switch (kind) {
    case "matrix":
      return matrix(op, id, at);
    case "versus":
      return versus(op, id, at);
    case "tree":
      return tree(op, id, at);
  }
}
