// 矢印の通り道を決める。画面（描く）とテストが同じ決まりを使えるよう、描画から切り離してある。
import type { Box, El, End, Point } from "./model.ts";

export const SIDES = ["top", "right", "bottom", "left"] as const;
export type Side = (typeof SIDES)[number];

/** 矢印の端。要素に付いているなら box がある。point は、要素の中心か、どこにも付かない点 */
export interface RouteEnd {
  box: Box | null;
  point: Point;
  shape: string;
}

export interface RouteOptions {
  route?: "straight" | "elbow";
  fromSide?: Side;
  toSide?: Side;
  bends?: number[];
}

/** 要素の縁と線の間の隙間 */
const EDGE_GAP = 5;
/** 折れ線が要素から出て、最初に曲がるまでの長さ */
const STUB = 18;

const DIR: Record<Side, Point> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const isHorizontal = (side: Side): boolean => side === "left" || side === "right";

/** 辺の真ん中から、隙間のぶんだけ外に出た点。どこにも付かない端は、その点そのもの */
function sidePoint(end: RouteEnd, side: Side): Point {
  if (!end.box) return end.point;
  const { x, y, w, h } = end.box;
  const d = DIR[side];
  return [x + w / 2 + d[0] * (w / 2 + EDGE_GAP), y + h / 2 + d[1] * (h / 2 + EDGE_GAP)];
}

/** 要素の中心から相手へ引いた線が、要素の縁と交わる点 */
function edgePoint(end: RouteEnd, toward: Point): Point {
  if (!end.box) return end.point;
  const c = end.point;
  const dx = toward[0] - c[0];
  const dy = toward[1] - c[1];
  if (dx === 0 && dy === 0) return c;
  const hw = end.box.w / 2 + EDGE_GAP;
  const hh = end.box.h / 2 + EDGE_GAP;
  let t: number;
  switch (end.shape) {
    case "ellipse":
      t = 1 / Math.hypot(dx / hw, dy / hh);
      break;
    case "diamond":
      t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
      break;
    default:
      t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  }
  t = Math.min(t, 1);
  return [c[0] + dx * t, c[1] + dy * t];
}

/** 相手のいる向きの辺 */
function facing(from: Point, to: Point): Side {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** 同じ点と、一直線に並んだ途中の点を除く */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    if (b && b[0] === p[0] && b[1] === p[1]) continue;
    if (a && b && ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1]))) out.pop();
    out.push(p);
  }
  return out;
}

function segmentHits(a: Point, b: Point, box: Box): boolean {
  const pad = 4;
  const x1 = Math.min(a[0], b[0]);
  const x2 = Math.max(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]);
  const y2 = Math.max(a[1], b[1]);
  return x1 < box.x + box.w + pad && x2 > box.x - pad && y1 < box.y + box.h + pad && y2 > box.y - pad;
}

function cost(points: Point[], obstacles: Box[]): number {
  let hits = 0;
  let length = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    length += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    for (const box of obstacles) if (segmentHits(a, b, box)) hits += 1;
  }
  // 箱を突き抜けない道を最優先し、同じなら短くて曲がりの少ない道を選ぶ
  return hits * 100000 + length + (points.length - 2) * 30;
}

/**
 * ほかの箱をよけて、直角に折れる道を選ぶ。
 * 出る辺と入る辺の組み合わせごとに、曲がりが 1〜2 回の道をいくつか作り、突き抜ける箱がいちばん少ないものを取る。
 * WHY 総当たり: 会議の図は箱が数十個までで、経路探索を持つほどの大きさではない。
 */
function autoElbow(a: RouteEnd, b: RouteEnd, opts: RouteOptions, obstacles: Box[]): Point[] {
  const fromSides = opts.fromSide ? [opts.fromSide] : a.box ? SIDES : [facing(a.point, b.point)];
  const toSides = opts.toSide ? [opts.toSide] : b.box ? SIDES : [facing(b.point, a.point)];
  // 両端の箱も障害物に入れる。出てすぐ自分の箱へ戻る道や、相手の箱を横切って裏から入る道を選ばないため
  const all = [...obstacles, ...(a.box ? [a.box] : []), ...(b.box ? [b.box] : [])];
  let best: Point[] = [a.point, b.point];
  let bestCost = Infinity;
  for (const fs of fromSides) {
    for (const ts of toSides) {
      const s = sidePoint(a, fs);
      const e = sidePoint(b, ts);
      const s2: Point = a.box ? [s[0] + DIR[fs][0] * STUB, s[1] + DIR[fs][1] * STUB] : s;
      const e2: Point = b.box ? [e[0] + DIR[ts][0] * STUB, e[1] + DIR[ts][1] * STUB] : e;
      const mx = (s2[0] + e2[0]) / 2;
      const my = (s2[1] + e2[1]) / 2;
      const middles: Point[][] = [
        [[e2[0], s2[1]]],
        [[s2[0], e2[1]]],
        [
          [mx, s2[1]],
          [mx, e2[1]],
        ],
        [
          [s2[0], my],
          [e2[0], my],
        ],
      ];
      // 途中の箱が大きくて上の道では回りきれないときのために、箱の外側をぐるりと通る道も候補にする
      for (const box of obstacles) {
        for (const y of [box.y - STUB, box.y + box.h + STUB]) middles.push([[s2[0], y], [e2[0], y]]);
        for (const x of [box.x - STUB, box.x + box.w + STUB]) middles.push([[x, s2[1]], [x, e2[1]]]);
      }
      for (const mid of middles) {
        const points = simplify([s, s2, ...mid, e2, e]);
        const c = cost(points, all);
        if (c < bestCost) {
          best = points;
          bestCost = c;
        }
      }
    }
  }
  return best;
}

/** 折れ目の位置（bends）を、出る向きから順に、横・縦・横…と読んで道にする */
function bentElbow(a: RouteEnd, b: RouteEnd, opts: RouteOptions, bends: number[]): Point[] {
  const fs = opts.fromSide ?? facing(a.point, b.point);
  const start = sidePoint(a, fs);
  const points: Point[] = [start];
  let cur = start;
  let horizontal = isHorizontal(fs);
  for (const v of bends) {
    cur = horizontal ? [v, cur[1]] : [cur[0], v];
    points.push(cur);
    horizontal = !horizontal;
  }
  // 残りは「次の向きへ進んで、もう一方の向きで入る」。入る辺を書いていなければ、その入り方に合う辺を選ぶ。
  // 次が横なら最後は縦なので上下の辺、次が縦なら最後は横なので左右の辺
  const center = b.point;
  const ts = opts.toSide ?? (horizontal ? (cur[1] <= center[1] ? "top" : "bottom") : cur[0] <= center[0] ? "left" : "right");
  const end = sidePoint(b, ts);
  if (isHorizontal(ts) === horizontal) {
    // 書かれた辺に、次の向きのままでは垂直に入れない。辺の外で 1 回余分に曲がって、正面から入る
    const out: Point = [end[0] + DIR[ts][0] * STUB, end[1] + DIR[ts][1] * STUB];
    points.push(horizontal ? [out[0], cur[1]] : [cur[0], out[1]], out);
  } else if (cur[0] !== end[0] && cur[1] !== end[1]) {
    points.push(horizontal ? [end[0], cur[1]] : [cur[0], end[1]]);
  }
  points.push(end);
  return simplify(points);
}

/** ラベルを置く場所。いちばん長い区間の真ん中。flat は、その区間が横向きか */
export function labelSpot(points: Point[]): { x: number; y: number; flat: boolean } | null {
  let best: { x: number; y: number; flat: boolean; len: number } | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!best || len > best.len) best = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, flat: Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]), len };
  }
  return best;
}

/** 横向きの区間に付くラベルは、線にかからないよう、この高さだけ上に浮かせる */
export const LABEL_LIFT = 11;
/** 矢印のラベルの文字の大きさ。画面の CSS（#lines text）と同じ値 */
export const LABEL_FONT = 12;

/**
 * 要素としての矢印の通り道。端の要素の四角は、呼ぶ側が渡す（画面は描いた結果、サーバーは見積もり）。
 * 端の要素が無ければ null。
 */
export function arrowPath(
  el: El,
  boxOf: (target: El) => Box | null,
  byId: (id: string) => El | undefined,
  solids: () => El[],
): Point[] | null {
  const endOf = (end: End | undefined): RouteEnd | null => {
    if (end === undefined) return null;
    if (typeof end !== "string") return { point: end, box: null, shape: "" };
    const target = byId(end);
    const box = target ? boxOf(target) : null;
    if (!target || !box) return null;
    return { point: [box.x + box.w / 2, box.y + box.h / 2], box, shape: target.type === "shape" ? (target.shape ?? "note") : "rect" };
  };
  const a = endOf(el.from);
  const b = endOf(el.to);
  if (!a || !b) return null;
  // よける箱は、折れ線のときだけ要る。両端の要素は除く
  const obstacles: Box[] = [];
  if (el.route === "elbow") {
    for (const s of solids()) {
      if (s.id === el.from || s.id === el.to) continue;
      const box = boxOf(s);
      if (box) obstacles.push(box);
    }
  }
  return routeArrow(a, b, el, obstacles);
}

/** 矢印の通り道。始点から終点までの点の並び */
export function routeArrow(a: RouteEnd, b: RouteEnd, opts: RouteOptions, obstacles: Box[]): Point[] {
  if (opts.route === "elbow") return opts.bends && opts.bends.length > 0 ? bentElbow(a, b, opts, opts.bends) : autoElbow(a, b, opts, obstacles);
  // まっすぐな線。辺を指定した端は辺の真ん中、指定しない端は相手へ向かう線と縁の交点
  const fixedA = opts.fromSide ? sidePoint(a, opts.fromSide) : null;
  const fixedB = opts.toSide ? sidePoint(b, opts.toSide) : null;
  return [fixedA ?? edgePoint(a, fixedB ?? b.point), fixedB ?? edgePoint(b, fixedA ?? a.point)];
}
