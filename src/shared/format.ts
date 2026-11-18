// 並べ直し（format）。セクションとまとめの帯を、詰めて置き直す。1 回かぎりの操作で、ボードに構造は足さない。
// やり方は 2 つ。揃える（既定。planAlign）は、今の列を保って、列の位置と縦の間を揃える。
// 組み直す（rebuild。planRebuild）は、今の列を使わず、上の段と cols 列の下の段に置き直す。
// どちらも、置く前に、中身より背の高い自由なセクションを、中身が入る高さまで縮める（fitSections）。
// 置き場所の計算は、ここの 2 つの関数にある。ボードを書き換えずに、動かした後の要素を返す。
// 操作（applyOps の format）も、CLI の --dry-run も、同じ結果を使う。
import { OUTER_GAP, PAD, boxOf, isSolid, ridersOf, shifted, type Box, type El, type Point, type Res } from "./model.ts";
import { facing } from "./route.ts";

/** 組み直すときの、下の段の列の数。書かなかったときの数と、上限 */
export const FORMAT_COLS = 2;
export const FORMAT_MAX_COLS = 6;
/**
 * 揃えるときに、列の先頭の見出しとみなす文字の、下の端と列の先頭の上端との間の上限。
 * WHY よけるときの間（OUTER_GAP）より狭い: 列の先頭が文字をよけると、文字の下 OUTER_GAP の所に来る。
 * その間が見出しの範囲に入ると、2 回めにその文字が見出しになって先頭と一緒に動き、もう一度かけると結果が変わる
 */
export const HEADING_GAP = 40;

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

/**
 * 一緒に動く四角の組（parts。y は組の上の端からの高さ）を、x を変えずに、y から下へ見て、障害物との間が OUTER_GAP 以上空く、いちばん上の高さを返す。
 * clearY と同じ考え方で、組のどれかに近い障害物があれば、その障害物の下の端から OUTER_GAP 空けた所へ、その部品が来る高さまで飛ぶ
 */
function clearParts(parts: readonly Box[], y: number, obstacles: readonly Box[]): number {
  for (;;) {
    let next: number | null = null;
    for (const p of parts) {
      const blocker = obstacles.find((o) => near({ ...p, y: y + p.y }, o));
      if (blocker) {
        next = blocker.y + blocker.h + OUTER_GAP - p.y;
        break;
      }
    }
    if (next === null) return y;
    y = next;
  }
}

interface Target {
  el: El;
  box: Box;
}

/**
 * 操作（{"op":"format"} か {"op":"format","rebuild":true,"cols":2}）を読んで、並べ直した結果を返す。
 * 知らない項目、真偽でない rebuild、範囲の外の cols、揃えるときの cols は断る。
 */
export function formatOp(els: readonly El[], op: Record<string, unknown>): Res<FormatPlan> {
  const unknown = Object.keys(op).find((k) => k !== "op" && k !== "rebuild" && k !== "cols");
  if (unknown !== undefined) return fail(`format に ${unknown} は無い。書けるのは rebuild（組み直す）と cols（組み直すときの列の数）だけ`);
  if (op.rebuild !== undefined && typeof op.rebuild !== "boolean") return fail(`format の rebuild は true か false: ${JSON.stringify(op.rebuild)}`);
  if (op.rebuild !== true) {
    // WHY 断る: 揃えるときは、列の数を今の配置から読む。書いた列の数が知らないうちに無視されないようにする
    if (op.cols !== undefined) return fail(`format の cols は、組み直すとき（"rebuild": true。CLI では --rebuild）だけ書ける。揃える（既定）は、今の列の数を変えない`);
    return planAlign(els);
  }
  const cols = op.cols === undefined ? FORMAT_COLS : op.cols;
  if (typeof cols !== "number" || !Number.isInteger(cols) || cols < 1 || cols > FORMAT_MAX_COLS) return fail(`format の cols は 1〜${FORMAT_MAX_COLS} の整数: ${JSON.stringify(op.cols)}`);
  return planRebuild(els, cols);
}

/** 今の列を保って、列の位置と縦の間を揃えた結果を返す。先に fitSections で縮める。els は書き換えない。決まりは alignFitted にある */
export function planAlign(els: readonly El[]): Res<FormatPlan> {
  return withFit(els, alignFitted);
}

/** 今の列を使わずに組み直した結果を返す。先に fitSections で縮める。els は書き換えない。決まりは rebuildFitted にある */
export function planRebuild(els: readonly El[], cols: number): Res<FormatPlan> {
  return withFit(els, (fitted) => rebuildFitted(fitted, cols));
}

/** 縮めてから並べ、縮めただけの要素と、動いた要素を、ボードの要素の並びの順に返す */
function withFit(els: readonly El[], place: (fitted: readonly El[]) => Res<FormatPlan>): Res<FormatPlan> {
  const fitted = fitSections(els);
  const plan = place(fitted);
  if (!plan.ok) return plan;
  const moved = new Map(plan.value.moved.map((el) => [el.id, el]));
  return { ok: true, value: { moved: fitted.flatMap((el, i) => moved.get(el.id) ?? (el === els[i] ? [] : [el])) } };
}

/**
 * 中身より背の高い自由なセクション（cols を書かないもの）を、中身が入る高さ（中身のいちばん下の端 + PAD）まで縮めた要素を返す。
 * 変えない要素は、同じ物を返す（withFit が、縮めた要素を物の同一性で見分ける）。
 * - 中身の無いセクションは縮めない。人が場所を取っておいた枠のことがある
 * - 固定したセクションと、固定したセクションの枠に収まったセクションは縮めない（format は固定したものを中身ごと動かさない）
 * - 透明な枠（frame: "none"）の中のセクションは縮めない。透明な枠そのものは、ほかのセクションと同じに縮める
 * - 中身に数えるのは、枠の中の、場所をふさぐ要素（付箋、文字、表、画像、ガント）と、まとめの帯と、中のセクション（中身ごと）。中のセクションを先に縮める
 *   WHY 中のセクションも数える: 数えないと、外の枠が中のセクションを切って縮み、枠がかかり合って format が断る
 *   WHY 線、座標の矢印、コメントは数えない: 並べるときに障害物にしないので、動いた枠が外の線を取り込むことがある。
 *   取り込んだ線で高さが決まると、もう一度かけたときに縮み方が変わる。縮めた枠の下にはみ出した線と矢印は、中身でなくなり、セクションと一緒に動かない
 */
export function fitSections(els: readonly El[]): El[] {
  const out = [...els];
  const index = new Map(els.map((el, i) => [el.id, i]));
  const within = (a: Box, o: Box): boolean => o.x <= a.x && o.y <= a.y && a.x + a.w <= o.x + o.w && a.y + a.h <= o.y + o.h;
  const sections = els.flatMap((c) => {
    const b = c.type === "container" ? boxOf(c) : null;
    return b ? [{ c, b }] : [];
  });
  const lockedBoxes = sections.flatMap(({ c, b }) => (c.locked === true ? [b] : []));
  const frames = sections.filter(({ c }) => c.frame === "none");
  // 小さい順に縮める。中のセクションは外のセクションより小さい
  for (const { c, b } of [...sections].sort((p, q) => p.b.w * p.b.h - q.b.w * q.b.h)) {
    // 固定したセクション自身も、lockedBoxes の自分の枠に収まるので、ここで外れる
    // 透明な枠の中のセクションも縮めない。WHY: 透明な枠は、図の配置を守るためのもの。型の枠のように、横に並ぶ枠の高さをそろえてあることがある
    if (c.cols !== undefined || lockedBoxes.some((l) => within(b, l)) || frames.some((f) => f.c.id !== c.id && within(b, f.b))) continue;
    const i = index.get(c.id) ?? -1;
    const now = out[i];
    if (!now) continue;
    const bottoms = ridersOf(out, now).flatMap((m) => {
      const mb = isSolid(m) || m.type === "container" || m.type === "summary" ? boxOf(m) : null;
      // セクションは、枠に収まった中のセクションだけ。中心が枠の中にあっても、外のセクションは数えない
      return mb && (m.type !== "container" || within(mb, b)) ? [mb.y + mb.h] : [];
    });
    if (bottoms.length === 0) continue;
    const need = Math.max(...bottoms) + PAD - b.y;
    if (need < b.h) out[i] = { ...now, h: need };
  }
  return out;
}

/** 揃えるときも組み直すときも同じ、並べる対象と、一緒に動く要素と、障害物の候補 */
interface Prepared {
  sized: readonly El[];
  boxes: Map<string, Box>;
  /** 並べる対象。いちばん外側のセクションと、どのセクションにも入っていないまとめの帯 */
  outer: Target[];
  bands: Target[];
  /** セクションの id ごとの、一緒に動く要素の id */
  rides: Map<string, string[]>;
  /** どれかのセクションと一緒に動く要素の id */
  claimed: Set<string>;
  /** 動かさない障害物の候補。セクションに入っていない、場所をふさぐ要素と、固定したセクションと帯 */
  obstacles: Target[];
}

function prepare(els: readonly El[]): Res<Prepared> {
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
  // 固定した（locked）セクションと帯は、中身ごと動かさず、障害物にする。WHY: 固定は「動かせない」の意味。図や象限のように、位置に意味がある配置を守る
  const fixed = [...outer, ...bands].filter((t) => t.el.locked === true);
  const obstacles = [...sized.filter((el) => isSolid(el) && !claimed.has(el.id)).flatMap(withBox), ...fixed];
  const free = (t: Target): boolean => t.el.locked !== true;
  return { ok: true, value: { sized, boxes, outer: outer.filter(free), bands: bands.filter(free), rides, claimed, obstacles } };
}

/**
 * 今の列を保って、列の位置と縦の間を揃えた結果を返す。els は書き換えない。
 *
 * 並べるのは、いちばん外側のセクション。どのセクションにも入っていないまとめの帯は、動かさない障害物にする（下の WHY）。
 * 1. 列: 横の範囲が重なるものどうしを、同じ列にする（重なりのつながりで 1 つ）。接するだけならつながらない。列は、左の端の順に並べる
 * 2. 全部の列の上の端（見出しがあれば見出しの上の端、無ければ先頭の上の端）を、同じ高さにそろえる。
 *    まとめの帯があれば、帯全体のいちばん下の端から OUTER_GAP。無ければ、今の列の上の端のいちばん上
 * 3. いちばん左の列は、今の左の端のまま。次の列は、前の列でいちばん幅の広いものの右の端から OUTER_GAP 空ける。列の中は、列の左の端に揃える
 * 4. 列の中は、今の上の端の順（同じなら左の端の順）に、上から OUTER_GAP ずつ空けて詰める
 * 5. 場所をふさぐ外の要素（障害物）との間が OUTER_GAP より狭くなるなら、その下の端から OUTER_GAP 空けた所まで下げる。後のものも、その下から続ける。
 *    列の先頭の見出しも、先頭と一緒によける
 * 6. 列の先頭の真上で、間が HEADING_GAP 以内の外の文字（見出し）は、列の先頭と同じだけ動かし、障害物にしない
 *
 * WHY 見出しの横の範囲を、列全体でなく、列の先頭の範囲で見る: 先頭と同じだけ動かすので、動かした後も先頭の真上に残る。
 * 列全体の範囲で見ると、先頭より左にはみ出した見出しは、揃えた後の列（左の端が先頭の左の端になる）の範囲から外れる。
 * 2 回めは見出しでなく障害物に数えられ、列が下へよけて、もう一度かけると結果が変わる。
 */
function alignFitted(els: readonly El[]): Res<FormatPlan> {
  const prep = prepare(els);
  if (!prep.ok) return prep;
  const { sized, boxes, outer, bands, rides, claimed } = prep.value;
  // 並べるのはセクションだけ。固定したセクションと帯は、ここに入らない（prepare が障害物に回す）。列を読むときにも数えない。
  // WHY まとめの帯も動かさず、障害物にする: 帯はボードの上に横に並べる要素で、列の一部ではない。
  // 列に数えると、帯の幅や議題の列のずれ方しだいで、帯が議題の列につながり、縦に積まれる
  const targets = outer;
  if (targets.length === 0) return { ok: true, value: { moved: [] } };

  // 1. 列を読む。左の端の順に見て、それまでの列の右の端より左から始まるものは、同じ列（接するだけなら別の列）
  const columns: Target[][] = [];
  let right = -Infinity;
  for (const t of [...targets].sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y)) {
    const last = columns.at(-1);
    if (last && t.box.x < right) {
      last.push(t);
      right = Math.max(right, t.box.x + t.box.w);
    } else {
      columns.push([t]);
      right = t.box.x + t.box.w;
    }
  }
  for (const col of columns) col.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

  // 6. 見出し。どのセクションにも入っていない文字のうち、列の先頭の真上で、間が HEADING_GAP 以内のもの。列ごとに、いちばん下の 1 つ
  const texts = sized.filter((el) => el.type === "text" && !claimed.has(el.id)).flatMap((el): Target[] => {
    const box = boxes.get(el.id);
    return box ? [{ el, box }] : [];
  });
  /** 列の先頭の id ごとの、見出し */
  const headings = new Map<string, Target>();
  const taken = new Set<string>();
  for (const col of columns) {
    const head = col[0];
    if (!head) continue;
    const above = texts.filter((t) => {
      const cx = t.box.x + t.box.w / 2;
      const gap = head.box.y - (t.box.y + t.box.h);
      return !taken.has(t.el.id) && head.box.x <= cx && cx <= head.box.x + head.box.w && gap > 0 && gap <= HEADING_GAP;
    });
    const lowest = above.reduce<Target | undefined>((best, t) => (best && best.box.y + best.box.h >= t.box.y + t.box.h ? best : t), undefined);
    if (!lowest) continue;
    headings.set(head.el.id, lowest);
    taken.add(lowest.el.id);
  }
  const obstacles = [...prep.value.obstacles.flatMap((o) => (taken.has(o.el.id) ? [] : [o.box])), ...bands.map((b) => b.box)];

  // 2〜5. 置く
  // 列の上の端は、見出しがあれば見出しの上の端、無ければ先頭の上の端。lift は、列の上の端から先頭の上の端までの高さ
  const lift = (head: Target): number => {
    const heading = headings.get(head.el.id);
    return heading ? head.box.y - heading.box.y : 0;
  };
  // 全部の列の上の端を、同じ高さ top にそろえる。
  // WHY 帯があれば、帯全体のいちばん下の端から OUTER_GAP: 帯の下に横に並んだ列（軸のレーン）が、帯の高さの違いで階段にならないようにする。
  // 列ごとに真上の帯の下へよけると、帯の無い所の列だけ上がり、見出しの行がそろわない
  // WHY 帯が無ければ、列の上の端のいちばん上: もう一度かけたときに、同じ高さになる（先頭のいちばん上にすると、見出しのぶんずつ下がっていく）
  const allBands = [...bands, ...prep.value.obstacles.filter((o) => o.el.type === "summary")];
  const top = allBands.length > 0
    ? Math.max(...allBands.map((b) => b.box.y + b.box.h)) + OUTER_GAP
    : Math.min(...columns.flatMap((col) => (col[0] ? [col[0].box.y - lift(col[0])] : [])));
  const spots = new Map<string, Point>();
  let left = Math.min(...(columns[0] ?? []).map((t) => t.box.x));
  for (const col of columns) {
    let y = top;
    for (const [i, t] of col.entries()) {
      // y は、列の上の端。列の先頭に見出しがあれば、見出しも一緒によける（見出しは、先頭との今の間を保って動く）
      const heading = i === 0 ? headings.get(t.el.id) : undefined;
      const off = heading ? lift(t) : 0;
      const parts = [{ ...t.box, x: left, y: off }, ...(heading ? [{ ...heading.box, x: heading.box.x + (left - t.box.x), y: 0 }] : [])];
      y = clearParts(parts, y, obstacles);
      spots.set(t.el.id, [left, y + off]);
      y += off + t.box.h + OUTER_GAP;
    }
    left += Math.max(...col.map((t) => t.box.w)) + OUTER_GAP;
  }

  const shifts = targetShifts(targets, spots, rides);
  for (const [headId, heading] of headings) {
    const d = shifts.get(headId);
    if (d) shifts.set(heading.el.id, d);
  }
  return { ok: true, value: { moved: movedBy(els, boxes, shifts) } };
}

/**
 * セクションとまとめの帯を、今の列を使わずに、組み直した結果を返す。els は書き換えない。
 *
 * 並べるのは、いちばん外側のセクション（ほかのセクションの枠に収まっていないもの）と、どのセクションにも入っていない、まとめの帯。
 * - 上の段: まとめの帯。今の左からの順（同じなら上から）で、上の端をそろえて横に並べる
 * - 下の段: セクション。今の上からの順（同じなら左から）で、cols 列に、上から詰める。列の幅は、いちばん広いセクションの幅
 * 起点は、並べる要素の、今の全体の左上。間は、どこも OUTER_GAP。
 * セクションは、枠の中に中心がある要素（ridersOf。set でセクションを動かすときと同じ）と一緒に動かす。
 *
 * セクションに入っていない、場所をふさぐ要素（付箋、文字、表、画像、ガント）と、固定したセクションと帯は、動かさない障害物として、その下へよけて置く。
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
function rebuildFitted(els: readonly El[], cols: number): Res<FormatPlan> {
  const prep = prepare(els);
  if (!prep.ok) return prep;
  const { boxes, outer, bands, rides } = prep.value;
  const top = [...bands].sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y);
  const bottom = [...outer].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const targets = [...top, ...bottom];
  if (targets.length === 0) return { ok: true, value: { moved: [] } };
  const ox = Math.min(...targets.map((t) => t.box.x));
  const oy = Math.min(...targets.map((t) => t.box.y));
  const obstacles = prep.value.obstacles.map((o) => o.box);

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

  return { ok: true, value: { moved: movedBy(els, boxes, targetShifts(targets, spots, rides)) } };
}

/** 並べる要素と、一緒に動く要素の、id ごとのずらす量。動かないものは入れない */
function targetShifts(targets: readonly Target[], spots: ReadonlyMap<string, Point>, rides: ReadonlyMap<string, string[]>): Map<string, Point> {
  const shifts = new Map<string, Point>();
  for (const t of targets) {
    const spot = spots.get(t.el.id);
    const d: Point = spot ? [spot[0] - t.box.x, spot[1] - t.box.y] : [0, 0];
    if (d[0] === 0 && d[1] === 0) continue;
    for (const id of [t.el.id, ...(rides.get(t.el.id) ?? [])]) shifts.set(id, d);
  }
  return shifts;
}

/** id ごとのずらす量を当てた後の、変わった要素。動かした要素を指すコメントと、矢印の折れ目も、ここで一緒に動かす */
function movedBy(els: readonly El[], boxes: ReadonlyMap<string, Box>, shifts: Map<string, Point>): El[] {
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
  return els.flatMap((el): El[] => {
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
}
