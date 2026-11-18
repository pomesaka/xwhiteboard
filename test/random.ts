// 乱数で、ボードと操作を作る。テスト（fuzz.test.ts）だけが使う。種が同じなら、同じ並びになる。
import { applyOps, boxOf, emptyDoc, isRecord, isSolid, membersOf, PAD, sectionTop, type Box, type Doc, type El, type Point } from "../src/shared/model.ts";
import { planFormat } from "../src/shared/format.ts";
import { withSummaryHeights } from "../src/shared/summary.ts";
import { add, drag, resize, rm, setOps, type Gesture, type Op } from "./screen.ts";

export type Rng = () => number;

/** 種から決まる乱数（mulberry32） */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: Rng, xs: readonly T[]): T {
  const v = xs[Math.floor(r() * xs.length)];
  if (v === undefined) throw new Error("空の並びからは選べない");
  return v;
}
const int = (r: Rng, lo: number, hi: number, step = 1): number => lo + Math.floor((r() * (hi - lo)) / step) * step;

/** 場所をふさぐ要素の中身（付箋、文字、表、画像） */
function solid(r: Rng): Op {
  const k = r();
  if (k < 0.6) return { type: "shape", text: "付箋", ...(r() < 0.5 ? { h: pick(r, [40, 60, 110, 200, 300]) } : {}), ...(r() < 0.3 ? { w: pick(r, [90, 220, 400]) } : {}) };
  if (k < 0.75) return { type: "text", text: pick(r, ["x", "長い文字の行を書く。折り返すかもしれない長さにする", "a\nb\nc"]) };
  if (k < 0.9) return { type: "table", rows: Array.from({ length: int(r, 1, 5) }, (_, i) => [String(i), "x"]) };
  return { type: "image", src: "x.png", w: pick(r, [100, 400]), h: pick(r, [100, 300]) };
}

function must(doc: Doc, ops: Op[]): Doc {
  const res = applyOps(doc, ops);
  if (!res.ok) throw new Error(res.error);
  return res.value.doc;
}

/**
 * ボードを作る。セクションを、重ならない格子（最大 3×3）に置き、7 割に cols を書く。
 * 半分のボードは、セクションの間を詰めて置く（押し下げが起きやすい）。外の要素、コメント、線、矢印も混ぜる。
 */
export function board(r: Rng): Doc {
  let doc = emptyDoc("t");
  const tight = r() < 0.5;
  const gx = int(r, 1, 4);
  const gy = int(r, 1, 4);
  let n = 0;
  const secs: string[] = [];
  for (let cx = 0; cx < gx; cx++) {
    let y = 0;
    for (let cy = 0; cy < gy; cy++) {
      if (r() < 0.15) {
        y += 400;
        continue;
      }
      const id = `s${cx}${cy}`;
      const cols = r() < 0.7 ? { cols: int(r, 1, 5) } : {};
      const ops: Op[] = [{ op: "add", el: { id, type: "container", x: cx * 800, y, w: pick(r, [504, 400, 740]), ...(r() < 0.3 ? { question: "来期の採用は何人か" } : {}), ...cols } }];
      secs.push(id);
      const m = int(r, 0, 7);
      for (let i = 0; i < m; i++) ops.push({ op: "add", in: id, el: { id: `m${n++}`, ...solid(r) } });
      doc = must(doc, ops);
      const s = doc.elements.find((e) => e.id === id);
      y = (s?.y ?? 0) + (s?.h ?? 0) + (tight ? 60 : pick(r, [60, 100, 240]));
    }
  }
  const pos = (): { x: number; y: number } => {
    const s = secs.length > 0 && r() < 0.6 ? doc.elements.find((e) => e.id === pick(r, secs)) : undefined;
    if (s) return { x: (s.x ?? 0) + int(r, -60, (s.w ?? 0) + 60, 10), y: (s.y ?? 0) + (s.h ?? 0) + int(r, 0, 200, 10) };
    return { x: int(r, 0, 2400, 10), y: int(r, 0, 1800, 10) };
  };
  const extras = int(r, 0, 6);
  for (let i = 0; i < extras; i++) {
    const q = r();
    const p = pos();
    const solids = doc.elements.filter(isSolid);
    let op: Op | null = null;
    if (q < 0.4) op = { op: "add", el: { id: `f${n++}`, ...solid(r), ...p } };
    else if (q < 0.6 && solids.length > 0) {
      const on = pick(r, solids);
      op = { op: "add", el: { id: `k${n++}`, type: "comment", x: (on.x ?? 0) + 5, y: (on.y ?? 0) + 5, on: on.id } };
    } else if (q < 0.7) op = { op: "add", el: { id: `k${n++}`, type: "comment", ...p, w: 80, h: 60 } };
    else if (q < 0.8) op = { op: "add", el: { id: `l${n++}`, type: "stroke", points: [[p.x, p.y], [p.x + 40, p.y + 30]] } };
    else if (q < 0.9) op = { op: "add", el: { id: `r${n++}`, type: "arrow", from: [p.x, p.y], to: [p.x + 80, p.y + 50] } };
    else if (solids.length > 1) op = { op: "add", el: { id: `r${n++}`, type: "arrow", from: pick(r, solids).id, to: pick(r, solids).id } };
    const res = op ? applyOps(doc, [op]) : null;
    if (res?.ok) doc = res.value.doc;
  }
  return doc;
}

/** 画面の操作を 1 つ作る（ドラッグ、大きさの変更、消す、足す、列の数、文字）。作れなければ null */
export function gesture(r: Rng, doc: Doc, n: number): Gesture | null {
  const els = doc.elements;
  if (els.length === 0) return null;
  const secs = els.filter((e) => e.type === "container");
  const k = r();
  const target = (): { x: number; y: number } => {
    const s = secs.length > 0 && r() < 0.8 ? pick(r, secs) : null;
    if (s) return { x: (s.x ?? 0) + int(r, -80, (s.w ?? 0) + 80), y: (s.y ?? 0) + int(r, -80, (s.h ?? 0) + 160) };
    return { x: int(r, 0, 2400), y: int(r, 0, 1800) };
  };
  const some = (): string[] => [...new Set(Array.from({ length: r() < 0.6 ? 1 : int(r, 2, 4) }, () => pick(r, els).id))];
  if (k < 0.45) {
    // 1〜3 個を選んで、先頭の要素の左上を、狙った場所へ動かす
    const sel = some();
    const first = els.find((e) => e.id === sel[0]);
    const b = first ? boxOf(first) : null;
    if (!b) return null;
    const t = r() < 0.2 ? { x: b.x + int(r, -40, 40), y: b.y + int(r, -40, 40) } : target();
    const g = drag(doc, sel, t.x - b.x, t.y - b.y);
    return g.ops.length > 0 ? g : null;
  }
  if (k < 0.55) {
    const sized = els.filter((e) => e.type !== "arrow" && e.type !== "stroke" && !(e.type === "comment" && e.w === undefined));
    if (sized.length === 0) return null;
    const el = pick(r, sized);
    return resize(doc, el.id, Math.max(40, (el.w ?? 200) + int(r, -200, 300)), Math.max(30, (el.h ?? 100) + int(r, -150, 400)));
  }
  if (k < 0.67) return rm(doc, some());
  if (k < 0.79) {
    const p = target();
    const q = r();
    if (q < 0.4) return add({ id: `g${n}`, type: "shape", shape: "note", color: "yellow", x: p.x - 110, y: p.y - 55, w: 220, h: 110, text: "" });
    if (q < 0.5) return add({ id: `g${n}`, type: "shape", shape: "rect", color: "white", x: p.x - 80, y: p.y - 40, w: 160, h: 80, text: "" });
    if (q < 0.6) return add({ id: `g${n}`, type: "text", x: p.x, y: p.y - 12, text: "" });
    if (q < 0.7) return add({ id: `g${n}`, type: "table", x: p.x, y: p.y, head: ["", ""], rows: [["", ""], ["", ""]] });
    if (q < 0.85) return add({ id: `g${n}`, type: "container", x: p.x, y: p.y, ...(r() < 0.5 ? { w: int(r, 100, 600), h: int(r, 80, 500) } : {}), title: "" });
    if (q < 0.95) return add({ id: `g${n}`, type: "comment", x: p.x, y: p.y });
    return add({ id: `g${n}`, type: "stroke", points: [[p.x, p.y], [p.x + 30, p.y + 50]] });
  }
  if (k < 0.87 && secs.length > 0) return setOps(doc, [{ id: pick(r, secs).id, patch: { cols: r() < 0.25 ? null : int(r, 1, 9) } }], "cols");
  const el = pick(r, els);
  if (el.type === "shape" || el.type === "text") return setOps(doc, [{ id: el.id, patch: { text: pick(r, ["短い", "長い文字の行を書く。折り返すかもしれない長さにする。もっと長くして行を増やす", "a\nb\nc\nd\ne\nf"]) } }], "text");
  if (el.type === "table") return setOps(doc, [{ id: el.id, patch: { rows: r() < 0.5 ? [...(el.rows ?? []), ["", ""]] : (el.rows ?? []).slice(0, -1) } }], "rows");
  if (el.type === "container") return setOps(doc, [{ id: el.id, patch: { [pick(r, ["question", "answer"])]: r() < 0.4 ? null : "決めることは何か。長い論点を書いて行を増やす" } }], "question");
  return null;
}

/**
 * エージェントが送る形の操作を 1 つ作る。n は、足す要素の id に使う番号。
 * 列で並べるセクションどうしを重ねる操作は作らない。WHY: cols はセクションを並べないので、重なった配置は扱わない。
 * セクションは、使っていない格子のマスにだけ足し、マスにだけ動かす。
 */
export function agentOp(r: Rng, doc: Doc, n: number): Op {
  const ids = doc.elements.map((e) => e.id);
  const sections = doc.elements.filter((e) => e.type === "container");
  const solids = doc.elements.filter(isSolid);
  const id = `n${n}`;
  const noop: Op = { op: "title", title: "t" };
  const pos = (): { x: number; y: number } => {
    const s = sections.length > 0 && r() < 0.7 ? pick(r, sections) : null;
    if (s) return { x: (s.x ?? 0) + int(r, -60, (s.w ?? 0) + 60, 20), y: (s.y ?? 0) + int(r, -60, (s.h ?? 0) + 200, 20) };
    return { x: int(r, 0, 1400, 20), y: int(r, 0, 1200, 20) };
  };
  const freeCell = (h = 380, self = ""): { x: number; y: number } | null => {
    const cells: { x: number; y: number }[] = [];
    for (let cx = 0; cx < 3; cx++) for (let cy = 0; cy < 8; cy++) cells.push({ x: cx * 800, y: cy * 380 });
    const free = cells.filter((c) => !sections.some((s) => s.id !== self && Math.abs((s.x ?? 0) - c.x) < 780 && (s.y ?? 0) + (s.h ?? 0) + 60 > c.y && (s.y ?? 0) < c.y + h + 60));
    return free.length > 0 ? pick(r, free) : null;
  };
  const k = r();
  if (k < 0.12 || sections.length === 0) {
    const cell = freeCell();
    if (!cell) return noop;
    return { op: "add", el: { id, type: "container", ...cell, w: pick(r, [504, 400]), ...(r() < 0.5 ? { h: pick(r, [160, 312]) } : {}), ...(r() < 0.7 ? { cols: int(r, 1, 4) } : {}) } };
  }
  if (k < 0.32) return { op: "add", in: pick(r, sections).id, el: { id, ...solid(r) } };
  if (k < 0.42) return { op: "add", el: { id, ...solid(r), ...pos() } };
  if (k < 0.45) return { op: "add", above: pick(r, ids), el: { id, ...solid(r) } };
  if (k < 0.48) return { op: "add", el: { id, ...solid(r) } };
  if (k < 0.52) return { op: "add", el: { id, type: "comment", ...pos(), ...(r() < 0.5 && solids.length > 0 ? { on: pick(r, solids).id } : { w: 60, h: 60 }) } };
  if (k < 0.55) {
    const p = pos();
    return { op: "add", el: { id, type: "stroke", points: [[p.x, p.y], [p.x + 40, p.y + 30]] } };
  }
  if (k < 0.57) {
    const p = pos();
    return { op: "add", el: { id, type: "arrow", from: [p.x, p.y], to: [p.x + 80, p.y + 50] } };
  }
  if (k < 0.72) {
    const t = pick(r, doc.elements);
    const q = r();
    if (t.type === "container") {
      if (q < 0.35) return { op: "set", id: t.id, patch: freeCell(t.h ?? 0, t.id) ?? { x: t.x } };
      if (q < 0.5) return { op: "set", id: t.id, patch: { h: pick(r, [100, 200, 400, 800]) } };
      if (q < 0.65) return { op: "set", id: t.id, patch: { w: pick(r, [300, 504, 704]) } };
      if (q < 0.8) return { op: "set", id: t.id, patch: { cols: r() < 0.3 ? null : int(r, 1, 4) } };
      return { op: "set", id: t.id, patch: { question: r() < 0.5 ? null : "来期の採用は何人か" } };
    }
    if (isSolid(t)) {
      if (q < 0.5) return { op: "set", id: t.id, patch: pos() };
      if (q < 0.6) return { op: "set", id: t.id, patch: { x: (t.x ?? 0) + int(r, -40, 40, 10) } };
      if (q < 0.8 && (t.type === "shape" || t.type === "image")) return { op: "set", id: t.id, patch: { h: pick(r, [40, 110, 200, 400]) } };
      if (q < 0.9 && t.type === "table") return { op: "set", id: t.id, patch: { rows: Array.from({ length: int(r, 1, 9) }, (_, i) => [String(i)]) } };
      return { op: "set", id: t.id, patch: { locked: true } };
    }
    return t.type === "comment" ? { op: "set", id: t.id, patch: pos() } : noop;
  }
  if (k < 0.84) return { op: "rm", id: pick(r, ids) };
  if (k < 0.9) return { op: "order", id: pick(r, ids), to: pick(r, ["front", "back"]) };
  if (k < 0.95) return { op: "compact", ...(r() < 0.5 ? { fit: true } : {}) };
  return noop;
}

const hit = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const colsSections = (doc: Doc): El[] => doc.elements.filter((e) => e.type === "container" && e.cols !== undefined);
const arranged = (doc: Doc, c: El): El[] => membersOf(doc.elements, c).filter(isSolid);

/** 重なっているセクションの組 */
export function overlaps(doc: Doc): Set<string> {
  const secs = doc.elements.flatMap((e): [string, Box][] => {
    const b = e.type === "container" ? boxOf(e) : null;
    return b ? [[e.id, b]] : [];
  });
  const out = new Set<string>();
  for (const [a, ab] of secs) for (const [b, bb] of secs) if (a < b && hit(ab, bb)) out.add(`${a}/${b}`);
  return out;
}

/** 操作のまとまり ops を base にかけた結果が、決まりを破っていたら、破った決まりの名前を返す。断られた操作は、何も返さない */
export function violations(base: Doc, ops: readonly Op[]): string[] {
  const res = applyOps(base, ops);
  if (!res.ok) return [];
  const { doc, added, updated, removed, order } = res.value;
  const out = new Set<string>();
  // 返る added・updated・removed・order が、前後の違いと合う
  const before = new Map(base.elements.map((e) => [e.id, JSON.stringify(e)]));
  const after = new Map(doc.elements.map((e) => [e.id, JSON.stringify(e)]));
  const [ad, up, gone] = [added, updated, removed].map((xs) => new Set(xs.map((e) => e.id)));
  for (const [id, j] of after) {
    if (!before.has(id) && !ad?.has(id)) out.add("足した要素が added に無い");
    if (before.has(id) && before.get(id) !== j && !up?.has(id)) out.add("変わった要素が updated に無い");
  }
  for (const id of before.keys()) if (!after.has(id) && !gone?.has(id)) out.add("消えた要素が removed に無い");
  for (const e of [...added, ...updated]) if (after.get(e.id) !== JSON.stringify(e)) out.add("added・updated の中身が、結果と違う");
  const common = (xs: readonly El[]): string => xs.flatMap((e) => (before.has(e.id) && after.has(e.id) ? [e.id] : [])).join(",");
  if (common(base.elements) !== common(doc.elements) && order === undefined) out.add("並びが変わったのに order が無い");
  if (order !== undefined && order.join(",") !== doc.elements.map((e) => e.id).join(",")) out.add("order が、結果の並びと違う");
  // 何もしない操作をかけても、変わらない
  const again = applyOps(doc, [{ op: "title", title: "x" }]);
  if (again.ok && (again.value.updated.length > 0 || again.value.order !== undefined)) out.add("何もしない操作で変わる");
  for (const c of colsSections(doc)) {
    const cb = boxOf(c);
    if (!cb) continue;
    const members = arranged(doc, c);
    const boxes = members.flatMap((m) => boxOf(m) ?? []);
    if (boxes.some((a, i) => boxes.some((b, j) => i < j && hit(a, b)))) out.add("中身が重なる");
    if (boxes.some((b) => b.y + b.h > cb.y + cb.h - PAD + 0.5 || b.y < cb.y + sectionTop(c) - 0.5 || b.x < cb.x + PAD - 0.5)) out.add("中身が枠から出る");
    if (members.length === 0 && cb.h !== sectionTop(c)) out.add("空なのに畳まれていない");
    const byPosition = [...members].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
    if (byPosition.some((m, i) => m.id !== members[i]?.id)) out.add("並ぶ順が、要素の並びと違う");
  }
  // 操作が触れていない外の要素が、操作が触れていない cols のセクションの中身になっていない
  // restore（元に戻す）は、中に書いた要素とセクションに触れる
  const inside = (o: Op): unknown[] => [o.id, ...[o.set, o.add].flatMap((xs) => (Array.isArray(xs) ? xs.map((x) => (isRecord(x) ? x.id : undefined)) : [])), ...(isRecord(o.members) ? Object.keys(o.members) : [])];
  const touched = new Set(ops.flatMap(inside));
  const home = (d: Doc): Map<string, string> => new Map(colsSections(d).flatMap((c) => arranged(d, c).map((m): [string, string] => [m.id, c.id])));
  const was = home(base);
  for (const [m, c] of home(doc)) {
    if (before.has(m) && !touched.has(m) && !touched.has(c) && was.get(m) !== c && base.elements.find((e) => e.id === c)?.cols !== undefined) out.add("外の要素を取り込む");
  }
  // 重なっていなかったセクションどうしが、重ならない
  const overlapped = overlaps(base);
  for (const pair of overlaps(doc)) if (!overlapped.has(pair) && pair.split("/").every((id) => before.has(id))) out.add("セクションが重なる");
  return [...out];
}

// ---- 並べ直し（format）の乱数のボードと、決まり ----

/**
 * 互いに重ならずに置いたボード。格子のマス（1200×1700）に 1 つずつ、セクション（中身つき）、まとめの帯、外の付箋を置く。
 * 外の付箋は、どのセクションの枠からも離れている
 */
export function tidyBoard(r: Rng): Doc {
  let doc = emptyDoc("t");
  const shows = ["decided", "open", "todo", "carried", "priority"];
  // マスの幅は、いちばん広いセクション（900）より 200 以上広い。外の付箋は、どのセクションの枠からも 60 以上離れる
  const cells = Array.from({ length: 12 }, (_, i) => ({ x: (i % 4) * 1200 + int(r, 0, 100, 10), y: Math.floor(i / 4) * 1700 + int(r, 0, 100, 10) }));
  let n = 0;
  for (const cell of cells) {
    const k = r();
    if (k < 0.15) continue;
    if (k < 0.7) {
      const id = `s${n++}`;
      const w = int(r, 300, 900, 10);
      const arranged = r() < 0.5;
      const ops: Op[] = [{ op: "add", el: { id, type: "container", ...cell, w, ...(arranged ? { cols: int(r, 1, 4) } : { h: int(r, 52, 800, 10) }), ...(r() < 0.2 ? { locked: true } : {}) } }];
      doc = must(doc, ops);
      const box = boxOf(doc.elements.find((e) => e.id === id) ?? { id, type: "container" });
      const m = int(r, 0, 7);
      const inside: Op[] = [];
      for (let i = 0; i < m; i++) {
        const status = r() < 0.3 ? { status: pick(r, ["decided", "open", "todo"]) } : {};
        if (arranged) inside.push({ op: "add", in: id, el: { id: `m${n++}`, type: "shape", text: "付箋", ...status } });
        else if (box && box.h > 100) {
          const p = { x: box.x + int(r, 0, box.w - 60, 10), y: box.y + int(r, 52, box.h - 40, 10) };
          const q = r();
          if (q < 0.6) inside.push({ op: "add", el: { id: `m${n++}`, type: "shape", ...p, w: 60, h: 40, ...status } });
          else if (q < 0.75) inside.push({ op: "add", el: { id: `m${n++}`, type: "comment", ...p, w: 40, h: 30 } });
          else if (q < 0.9) inside.push({ op: "add", el: { id: `m${n++}`, type: "stroke", points: [[p.x, p.y], [p.x + 20, p.y + 20]] } });
          else inside.push({ op: "add", el: { id: `m${n++}`, type: "arrow", from: [p.x, p.y], to: [p.x + 30, p.y + 20] } });
        }
      }
      if (inside.length > 0) doc = must(doc, inside);
      continue;
    }
    if (k < 0.85) {
      const show = shows.shift();
      if (show) doc = must(doc, [{ op: "add", el: { id: `b${n++}`, type: "summary", show, ...cell, w: int(r, 240, 480, 10) } }]);
      continue;
    }
    doc = must(doc, [{ op: "add", el: { id: `f${n++}`, ...solid(r), ...cell } }]);
  }
  // 要素どうしを結ぶ矢印
  const solids = doc.elements.filter(isSolid);
  for (let i = 0; i < 3 && solids.length > 1; i++) {
    const res = applyOps(doc, [{ op: "add", el: { id: `r${n++}`, type: "arrow", from: pick(r, solids).id, to: pick(r, solids).id, ...(r() < 0.5 ? { route: "elbow", bends: [int(r, 0, 3000, 10)] } : {}) } }]);
    if (res.ok) doc = res.value.doc;
  }
  return doc;
}

/** 座標を乱数で決めたボード。セクションの重なり、入れ子、枠にかかる要素がある。断られた要素は飛ばす */
export function messyBoard(r: Rng): Doc {
  let doc = emptyDoc("t");
  const count = int(r, 0, 14);
  for (let i = 0; i < count; i++) {
    const p = { x: int(r, -400, 2400, 10), y: int(r, -400, 2400, 10) };
    const q = r();
    let el: Op;
    if (q < 0.4) el = { id: `s${i}`, type: "container", ...p, w: int(r, 100, 900, 10), ...(r() < 0.3 ? { cols: int(r, 1, 4) } : { h: int(r, 52, 800, 10) }), ...(r() < 0.2 ? { locked: true } : {}) };
    else if (q < 0.5) el = { id: `b${i}`, type: "summary", show: pick(r, ["decided", "open", "todo"]), ...p };
    else if (q < 0.8) el = { id: `f${i}`, ...solid(r), ...p, ...(r() < 0.3 ? { status: "decided" } : {}) };
    else if (q < 0.9) el = { id: `k${i}`, type: "comment", ...p, w: 60, h: 60 };
    else el = { id: `l${i}`, type: "stroke", points: [[p.x, p.y], [p.x + 40, p.y + 30]] };
    if (el.type === "shape" && el.status === undefined) delete el.status;
    const res = applyOps(doc, [{ op: "add", el }]);
    if (res.ok) doc = res.value.doc;
  }
  return doc;
}

/**
 * base に format（cols）をかけた結果が、並べ直しの決まりを破っていたら、破った決まりの名前を返す。断られたら、何も返さない。
 * tidy は、重ならずに置いたボード（tidyBoard）か。中身とセクションへの入り方、重なり、左上の決まりは、そのボードでだけ見る
 */
export function formatViolations(base: Doc, cols: number, tidy: boolean): string[] {
  const op = { op: "format", cols };
  const res = applyOps(base, [op]);
  if (!res.ok) return [];
  const doc = res.value.doc;
  const out = new Set<string>(violations(base, [op]));
  const before = new Map(base.elements.map((e) => [e.id, e]));
  const after = new Map(doc.elements.map((e) => [e.id, e]));
  // P1 もう一度かけても変わらない
  const again = applyOps(doc, [op]);
  if (!again.ok) out.add("2 回めが断られる");
  else if (again.value.updated.length > 0) out.add("もう一度かけると変わる");
  // P7 返す一覧が、実際に変わった要素と同じ。試すだけの計算（planFormat）とも同じ
  const changed = doc.elements.filter((e) => JSON.stringify(e) !== JSON.stringify(before.get(e.id))).map((e) => e.id).sort();
  if (res.value.updated.map((e) => e.id).sort().join(",") !== changed.join(",")) out.add("返す一覧が、動いた要素と違う");
  const plan = planFormat(base.elements, cols);
  if (!plan.ok || JSON.stringify(plan.value.moved) !== JSON.stringify(res.value.updated)) out.add("試した結果と、動いた要素が違う");
  // P6 セクションに入っていない、場所をふさぐ要素は動かない
  const sized = withSummaryHeights(base.elements);
  const sections = sized.filter((e) => e.type === "container");
  const inSome = new Set(sections.flatMap((c) => membersOf(sized, c).map((m) => m.id)));
  for (const el of base.elements) if (isSolid(el) && !inSome.has(el.id) && JSON.stringify(el) !== JSON.stringify(after.get(el.id))) out.add("セクションに入っていない要素が動く");
  if (!tidy) return [...out];
  // P2 要素の集まり、並び、セクションごとの中身が同じ
  if (base.elements.map((e) => e.id).join(",") !== doc.elements.map((e) => e.id).join(",")) out.add("要素か並びが変わる");
  const sizedAfter = withSummaryHeights(doc.elements);
  const content = (els: El[], id: string): string => {
    const c = els.find((e) => e.id === id);
    return c ? membersOf(els, c).map((m) => m.id).sort().join(",") : "";
  };
  for (const c of sections) if (content(sized, c.id) !== content(sizedAfter, c.id)) out.add("セクションの中身が変わる");
  // P3 中身は、セクションと同じだけ動く
  for (const c of sections) {
    const c2 = sizedAfter.find((e) => e.id === c.id);
    const [b1, b2] = [boxOf(c), c2 ? boxOf(c2) : null];
    if (!b1 || !b2) continue;
    if (b1.w !== b2.w || b1.h !== b2.h) out.add("セクションの大きさが変わる");
    for (const m of membersOf(sized, c)) {
      const m2 = after.get(m.id);
      const [p1, p2] = [boxOf(m), m2 ? boxOf(m2) : null];
      if (p1 && p2 && (p1.x - b1.x !== p2.x - b2.x || p1.y - b1.y !== p2.y - b2.y)) out.add("中身が、セクションと違う量だけ動く");
    }
  }
  // P4 並べた要素（セクションと帯）どうしと、外の要素との間が 60 以上空く
  const placedBoxes = sizedAfter.flatMap((e) => (e.type === "container" || e.type === "summary" ? (boxOf(e) ?? []) : []));
  const obstacleBoxes = sizedAfter.flatMap((e) => (isSolid(e) && !inSome.has(e.id) ? (boxOf(e) ?? []) : []));
  const apart = (a: Box, b: Box): boolean => a.x + a.w + 60 <= b.x + 0.5 || b.x + b.w + 60 <= a.x + 0.5 || a.y + a.h + 60 <= b.y + 0.5 || b.y + b.h + 60 <= a.y + 0.5;
  if (placedBoxes.some((a, i) => placedBoxes.some((b, j) => i < j && !apart(a, b)))) out.add("並べた要素どうしが近すぎる");
  if (placedBoxes.some((a) => obstacleBoxes.some((b) => !apart(a, b)))) out.add("並べた要素が、外の要素に近すぎる");
  // P5 並べる要素の全体の左上が変わらない。
  // 起点の場所が外の要素でふさがっているときだけ、x を保ったまま、その要素の下の端から 60 空けた高さへ下がる（よける決まりが先）
  const corner = (els: El[]): Point | null => {
    const bs = els.flatMap((e) => (e.type === "container" || e.type === "summary" ? (boxOf(e) ?? []) : []));
    return bs.length === 0 ? null : [Math.min(...bs.map((b) => b.x)), Math.min(...bs.map((b) => b.y))];
  };
  const [c1, c2] = [corner(sized), corner(sizedAfter)];
  const dodged = c1 && c2 && c1[0] === c2[0] && c2[1] > c1[1] && obstacleBoxes.some((b) => b.y + b.h + 60 === c2[1]);
  if (JSON.stringify(c1) !== JSON.stringify(c2) && !dodged) out.add("全体の左上が変わる");
  return [...out];
}
