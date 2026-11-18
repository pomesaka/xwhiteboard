// 画面（src/client/main.ts）が送る操作の形を組み立てて、applyOps と restoreOp にかける。
// テストだけが使う。画面の commitNow・setOps・addEl・removeEls・movingSet・endGesture と同じ形にしてある。
import { applyOps, membersOf, shifted, type Applied, type Doc, type El } from "../src/shared/model.ts";
import { restoreOp } from "../src/shared/restore.ts";

export type Op = Record<string, unknown>;

export interface Gesture {
  kind: string;
  ops: Op[];
  /** ドラッグや大きさの変更で、手元の要素を先に書き換えていたときの、書き換える前の要素（commit に渡す origin） */
  origin: Map<string, El>;
  /** 送る直前の、手元の要素（書き換えた後） */
  local: El[];
}

const positionPatch = (el: El): Op => (el.type === "stroke" ? { points: el.points } : el.type === "arrow" ? { from: el.from, to: el.to } : { x: el.x, y: el.y });
const widthOnly = (el: El): boolean => el.type === "text" || el.type === "table" || el.type === "gantt";
const find = (doc: Doc, id: string): El | undefined => doc.elements.find((e) => e.id === id);

/** ドラッグ。選んだ要素（選んだ順）と、選んだセクションの中身を、dx・dy だけ動かした絶対座標の set を送る */
export function drag(doc: Doc, selection: readonly string[], dx: number, dy: number): Gesture {
  const origin = new Map<string, El>();
  for (const id of selection) {
    const el = find(doc, id);
    if (!el || el.locked) continue;
    if (el.type === "arrow" && typeof el.from === "string" && typeof el.to === "string") continue;
    origin.set(el.id, el);
    if (el.type === "container") for (const m of membersOf(doc.elements, el)) if (!m.locked) origin.set(m.id, m);
  }
  const local = [...origin.values()].map((el) => shifted(el, dx, dy));
  return { kind: "drag", ops: local.map((el) => ({ op: "set", id: el.id, patch: positionPatch(el) })), origin, local };
}

/** 大きさの変更。文字・表・ガントは、幅だけを送る */
export function resize(doc: Doc, id: string, w: number, h: number): Gesture | null {
  const el = find(doc, id);
  if (!el || el.locked) return null;
  const patch = widthOnly(el) ? { w } : { w, h };
  return { kind: "resize", ops: [{ op: "set", id, patch }], origin: new Map([[id, el]]), local: [{ ...el, ...patch }] };
}

/** 項目の変更（文字、列の数、論点） */
export function setOps(doc: Doc, changes: readonly { id: string; patch: Op }[], kind = "set"): Gesture {
  return { kind, ops: changes.flatMap((c) => (find(doc, c.id) ? [{ op: "set", id: c.id, patch: c.patch }] : [])), origin: new Map(), local: [] };
}

/** 消す。固定した要素は消さない */
export function rm(doc: Doc, ids: readonly string[]): Gesture {
  return { kind: "rm", ops: ids.filter((id) => find(doc, id)?.locked !== true).map((id) => ({ op: "rm", id })), origin: new Map(), local: [] };
}

export function add(el: Op): Gesture {
  return { kind: `add:${String(el.type)}`, ops: [{ op: "add", el }], origin: new Map(), local: [] };
}

export interface Sent {
  applied: Applied;
  /** 「元に戻す」に積む操作 */
  undo: Op[];
}

/** 操作を送って、「元に戻す」に積む操作を作る。断られたら null */
export function send(doc: Doc, g: Gesture): Sent | null {
  const before = new Map(doc.elements.map((e): [string, El] => [e.id, e]));
  for (const el of g.local) before.set(el.id, el);
  const res = applyOps(doc, g.ops, { by: "human", at: "" });
  if (!res.ok) return null;
  const back = restoreOp(before, g.ops, res.value, g.origin);
  return { applied: res.value, undo: back ? [back] : [] };
}

/** 「元に戻す」を送った後のボード */
export function undone(doc: Doc, undo: readonly Op[]): Doc {
  if (undo.length === 0) return doc;
  const res = applyOps(doc, undo, { by: "human", at: "" });
  if (!res.ok) throw new Error(res.error);
  return res.value.doc;
}
