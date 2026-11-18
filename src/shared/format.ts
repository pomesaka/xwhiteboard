// 並べ直し（format）。セクションとまとめの帯を、詰めて置き直す。1 回かぎりの操作で、ボードに構造は足さない。
// 置き場所の計算は、ここの planFormat の 1 か所にある。ボードを書き換えずに、動かした後の要素を返す。
// 操作（applyOps の format）も、CLI の --dry-run も、同じ結果を使う。
import { OUTER_GAP, boxOf, isSolid, ridersOf, shifted, type Box, type El, type Point, type Res } from "./model.ts";
import { facing } from "./route.ts";

/** 下の段の列の数。書かなかったときの数と、上限 */
export const FORMAT_COLS = 2;
export const FORMAT_MAX_COLS = 6;

export interface FormatPlan {
  /** 動いた要素の、動かした後の形。ボードの要素の並びの順 */
  moved: El[];
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** 枠どうしが少しでも重なる。接するだけなら重ならない */
const hit = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** 間が OUTER_GAP より狭い */
const near = (a: Box, b: Box): boolean => hit({ x: a.x - OUTER_GAP, y: a.y - OUTER_GAP, w: a.w + OUTER_GAP * 2, h: a.h + OUTER_GAP * 2 }, b);
const contains = (outer: Box, inner: Box): boolean => outer.x <= inner.x && outer.y <= inner.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/**
 * box を、x を変えずに、y から下へ見て、障害物（obstacles）との間が OUTER_GAP 以上空く、いちばん上の高さを返す。
 * 重なる障害物があれば、その下の端から OUTER_GAP 空けた高さへ飛ぶ。その障害物の下の端までは、どの高さでも重なるので、飛んだ先が、いちばん上になる
 */
function clearY(boxes: readonly Box[], y: number, obstacles: readonly Box[]): number {
  for (;;) {
    const blocker = obstacles.find((o) => boxes.some((b) => near({ ...b, y }, o)));
    if (!blocker) return y;
    y = blocker.y + blocker.h + OUTER_GAP;
  }
}

interface Target {
  el: El;
  box: Box;
}

/**
 * 操作（{"op":"format","cols":2}）を読んで、並べ直した結果を返す。知らない項目と、範囲の外の cols は断る。
 */
export function formatOp(els: readonly El[], op: Record<string, unknown>): Res<FormatPlan> {
  const unknown = Object.keys(op).find((k) => k !== "op" && k !== "cols");
  if (unknown !== undefined) return fail(`format に ${unknown} は無い。書けるのは cols（列の数）だけ`);
  const cols = op.cols === undefined ? FORMAT_COLS : op.cols;
  if (typeof cols !== "number" || !Number.isInteger(cols) || cols < 1 || cols > FORMAT_MAX_COLS) return fail(`format の cols は 1〜${FORMAT_MAX_COLS} の整数: ${JSON.stringify(op.cols)}`);
  return planFormat(els, cols);
}

/**
 * セクションとまとめの帯を、詰めて置き直した結果を返す。els は書き換えない。
 *
 * 並べるのは、いちばん外側のセクション（ほかのセクションの枠に収まっていないもの）と、どのセクションにも入っていない、まとめの帯。
 * - 上の段: 固定したセクションと、まとめの帯。今の左からの順（同じなら上から）で、上の端をそろえて横に並べる
 * - 下の段: 残りのセクション。今の上からの順（同じなら左から）で、cols 列に、上から詰める。列の幅は、いちばん広いセクションの幅
 * 起点は、並べる要素の、今の全体の左上。間は、どこも OUTER_GAP。
 * セクションは、枠の中に中心がある要素（ridersOf。set でセクションを動かすときと同じ）と一緒に動かす。
 *
 * セクションに入っていない、場所をふさぐ要素（付箋、文字、表、画像、ガント）は、動かさない障害物として、その下へよけて置く。
 * WHY よける: 動かしたセクションの枠に外の要素の中心が入ると、次からそのセクションの中身に数えられる（中身は座標で決まる）。
 * 列で並べるセクションなら列に並び、もう一度かけたときに結果が変わる。
 *
 * WHY 下の段を置く順を、上から、同じ高さなら左からに保つ（cursors の決め方）:
 * 並べ終わった配置にもう一度かけても、同じ結果にするため。次にかけるときの順は、置いた場所（上から、左から）で決まる。
 * 置いた順と、置いた場所の順が同じなら、2 回めは、同じ順に、同じ計算をする。
 * 障害物が無ければ、いちばん低い列に置くだけで、この順になる。障害物をよけると、後のセクションが、前のセクションより上か、同じ高さの左に入りうるので、
 * 置いたセクションより左の列は、そのセクションをよけて置けた高さから、右の列は、そのセクションを置いた高さから下だけを使う。
 * WHY 最初のセクションを左の端の列に置く: 左の端の列が空くと、全体の左上（起点）が右へずれて、2 回めの列の場所が変わる。
 */
export function planFormat(els: readonly El[], cols: number): Res<FormatPlan> {
  // まとめの帯の高さは、操作のたびに applyOps が要素の h に書く（settleSummaries）。format は、その前の並べ直しの後に呼ばれるので、h のままで測れる
  const sized = els;
  const boxes = new Map(sized.flatMap((el): [string, Box][] => {
    const b = boxOf(el);
    return b ? [[el.id, b]] : [];
  }));
  const withBox = (el: El): Target[] => {
    const box = boxes.get(el.id);
    return box ? [{ el, box }] : [];
  };
  const sections = sized.filter((el) => el.type === "container").flatMap(withBox);
  // 枠が重なるセクションは、片方がもう片方に収まっている入れ子だけを扱う。
  // WHY: 中身は、中心が枠の中にあるかで決まる。枠がかかり合うと、どちらの中身として動かすかを決められない
  const nested = (inner: Box, outer: Box): boolean => contains(outer, inner) && !contains(inner, outer);
  for (const [i, a] of sections.entries()) {
    const b = sections.slice(i + 1).find((o) => hit(a.box, o.box) && !nested(a.box, o.box) && !nested(o.box, a.box));
    if (b) return fail(`セクション ${a.el.id} と ${b.el.id} の枠が重なっている。どちらの中身かを決められないので、並べ直せない。片方を、重ならない場所へ動かしてから（x・y を set。cols の無いセクションは枠だけが動くので、中身の x・y も同じだけ set する）、もう一度 format をかける`);
  }
  const outer = sections.filter((s) => !sections.some((o) => o.el.id !== s.el.id && nested(s.box, o.box)));
  // セクションと一緒に動く要素。枠の辺の上に中心があって、2 つのセクションに入る要素は、先のセクションと動かす
  const rides = new Map<string, string[]>();
  const claimed = new Set<string>();
  for (const s of outer) {
    const ids = ridersOf(sized, s.el).flatMap((r) => (claimed.has(r.id) ? [] : [r.id]));
    for (const id of ids) claimed.add(id);
    rides.set(s.el.id, ids);
  }
  const bands = sized.filter((el) => el.type === "summary" && !claimed.has(el.id)).flatMap(withBox);
  const top = [...outer.filter((s) => s.el.locked === true), ...bands].sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y);
  const bottom = outer.filter((s) => s.el.locked !== true).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const targets = [...top, ...bottom];
  if (targets.length === 0) return { ok: true, value: { moved: [] } };
  const ox = Math.min(...targets.map((t) => t.box.x));
  const oy = Math.min(...targets.map((t) => t.box.y));
  const obstacles = sized.filter((el) => isSolid(el) && !claimed.has(el.id)).flatMap((el) => boxes.get(el.id) ?? []);

  /** 並べる要素の id ごとの、置く場所（左上） */
  const spots = new Map<string, Point>();
  // 上の段。障害物があれば、段ごと下へ飛ばす（上の端をそろえたままにする）
  let x = ox;
  const row = top.map((t): Box => {
    const at = { ...t.box, x };
    x += t.box.w + OUTER_GAP;
    return at;
  });
  const topY = clearY(row, oy, obstacles);
  for (const [i, t] of top.entries()) spots.set(t.el.id, [row[i]?.x ?? ox, topY]);

  // 下の段
  const colW = Math.max(0, ...bottom.map((s) => s.box.w));
  const cursors: number[] = Array.from({ length: cols }, () => (top.length > 0 ? topY + Math.max(...top.map((t) => t.box.h)) + OUTER_GAP : oy));
  const colX = (c: number): number => ox + c * (colW + OUTER_GAP);
  for (const [k, s] of bottom.entries()) {
    const offers = cursors.map((y, c) => clearY([{ ...s.box, x: colX(c) }], y, obstacles));
    const y = k === 0 ? (offers[0] ?? oy) : Math.min(...offers);
    const c = offers.indexOf(y);
    spots.set(s.el.id, [colX(c), y]);
    for (const [i, offer] of offers.entries()) cursors[i] = i < c ? offer : i === c ? y + s.box.h + OUTER_GAP : Math.max(cursors[i] ?? y, y);
  }

  /** 要素の id ごとの、ずらす量 */
  const shifts = new Map<string, Point>();
  for (const t of targets) {
    const spot = spots.get(t.el.id);
    const d: Point = spot ? [spot[0] - t.box.x, spot[1] - t.box.y] : [0, 0];
    if (d[0] === 0 && d[1] === 0) continue;
    for (const id of [t.el.id, ...(rides.get(t.el.id) ?? [])]) shifts.set(id, d);
  }
  // 動かした要素を指しているコメントは、一緒に動かす
  for (const el of els) {
    const d = el.type === "comment" && el.on !== undefined && !shifts.has(el.id) ? shifts.get(el.on) : undefined;
    if (d) shifts.set(el.id, d);
  }
  // 両端が要素に付いた矢印は、端に付いていくので動かさない。折れ目（bends）は座標なので、両端が同じだけ動いたときに、同じだけずらす
  const endShift = (end: El["from"]): Point => (typeof end === "string" ? (shifts.get(end) ?? [0, 0]) : [0, 0]);
  const endPoint = (end: El["from"]): Point | null => {
    if (typeof end !== "string") return end ?? null;
    const b = boxes.get(end);
    return b ? [b.x + b.w / 2, b.y + b.h / 2] : null;
  };
  const moved = els.flatMap((el): El[] => {
    const own = shifts.get(el.id);
    const [a, b] = [endShift(el.from), endShift(el.to)];
    const d = own ?? (el.type === "arrow" && typeof el.from === "string" && typeof el.to === "string" && a[0] === b[0] && a[1] === b[1] ? a : null);
    if (!d || (d[0] === 0 && d[1] === 0)) return [];
    const next = own ? shifted(el, d[0], d[1]) : el;
    if (el.type !== "arrow" || el.bends === undefined || el.bends.length === 0) return own ? [next] : [];
    // 折れ目は、出る辺が左右なら x・y・x…、上下なら y・x・y…の順（route.ts の bentElbow と同じ読み方）
    const [from, to] = [endPoint(el.from), endPoint(el.to)];
    const side = el.fromSide ?? (from && to ? facing(from, to) : null);
    if (side === null) return own ? [next] : [];
    const startsX = side === "left" || side === "right";
    const bends = el.bends.map((v, i) => v + ((i % 2 === 0) === startsX ? d[0] : d[1]));
    // 折れ目が、動かない向きにだけ並んでいれば、何も変わらない
    if (!own && bends.every((v, i) => v === el.bends?.[i])) return [];
    return [{ ...next, bends }];
  });
  return { ok: true, value: { moved } };
}
