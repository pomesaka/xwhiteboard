// 画面の「元に戻す」が送る操作の組み立て。
// 画面（src/client/main.ts）だけが使う。applyOps との往復をテストで確かめられるように、DOM を使わない関数にしてある。
import { isRecord, isSolid, membersOf, type El } from "./model.ts";

/** 要素の位置と大きさを決める項目 */
export const GEOMETRY = ["x", "y", "w", "h", "points", "from", "to"] as const;

/** local の位置と大きさを、remote に写す。ドラッグの最中に届いた更新で、手元の位置を保つのに使う */
export function withGeometry(remote: El, local: El): El {
  const out: El = { ...remote };
  for (const k of GEOMETRY) Object.assign(out, { [k]: local[k] });
  return out;
}

/** 操作を送った返事（applyOps の結果）のうち、「元に戻す」が読むもの */
export interface Reply {
  added: readonly El[];
  updated: readonly El[];
  removed: readonly El[];
  /** 重なり順が変わったときだけ付く */
  order?: unknown;
}

/**
 * 送った操作（ops）を元に戻す、restore の操作を作る。戻すものが無ければ null。
 * before は、送る直前の画面の要素（並びは重なり順）。reply は、サーバーの返事。
 * origin は、ドラッグや大きさの変更で、手元の要素を先に書き換えていたときの、書き換える前の要素。
 *
 * 足された要素は消し、消えた要素は足し直し、変わった要素は、変わった項目を変える前の値にする。
 * WHY 返事から作る: 送った項目だけから作ると、サーバーが足した変更（押し下げ、並べ直し、セクションの伸び、幅をそろえる）が戻らない。
 * 戻す項目は、位置と大きさ、それに、送った set に書いた項目だけ。
 * WHY 全部の項目を比べない: 手元の要素は、エージェントの変更が届く前の値のことがある。比べると、エージェントが直した文字まで戻す。
 * 要素の並びは、消えた要素があるか、重なり順が変わったときに付ける。消えた要素を足し直すと、いちばん前面に入るため。
 * members は、戻す要素に関わる、列で並べるセクションごとの、変える前の中身。
 * WHY: 積んだ後にエージェントがセクションを変えていると、戻した要素の位置からは、どのセクションの中身だったかを読めない。
 */
export function restoreOp(before: ReadonlyMap<string, El>, ops: readonly unknown[], reply: Reply, origin: ReadonlyMap<string, El> = new Map()): Record<string, unknown> | null {
  const written = new Map<string, Set<string>>();
  for (const op of ops) {
    if (!isRecord(op) || op.op !== "set" || typeof op.id !== "string" || !isRecord(op.patch)) continue;
    written.set(op.id, new Set([...(written.get(op.id) ?? []), ...Object.keys(op.patch)]));
  }
  const updated = new Map(reply.updated.map((e) => [e.id, e]));
  const set: { id: string; patch: Record<string, unknown> }[] = [];
  for (const id of new Set([...updated.keys(), ...origin.keys()])) {
    const was = origin.get(id) ?? before.get(id);
    const now = updated.get(id) ?? before.get(id);
    if (!was || !now) continue;
    const prev: Record<string, unknown> = { ...was };
    const next: Record<string, unknown> = { ...now };
    const patch: Record<string, unknown> = {};
    for (const k of new Set([...GEOMETRY, ...(written.get(id) ?? [])])) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) patch[k] = prev[k] ?? null;
    }
    if (Object.keys(patch).length > 0) set.push({ id, patch });
  }
  const rm = reply.added.map((e) => e.id);
  const add = [...reply.removed];
  const order = add.length > 0 || reply.order !== undefined ? [...before.keys()] : [];
  if ([set, rm, add, order].every((part) => part.length === 0)) return null;
  const touched = new Set([...set.map((item) => item.id), ...add.map((e) => e.id)]);
  const old = [...before.values()].map((e) => origin.get(e.id) ?? e);
  const members: Record<string, string[]> = {};
  for (const c of old) {
    if (c.type !== "container" || c.cols === undefined) continue;
    const ids = membersOf(old, c).flatMap((m) => (isSolid(m) ? [m.id] : []));
    if (touched.has(c.id) || ids.some((id) => touched.has(id))) members[c.id] = ids;
  }
  return {
    op: "restore",
    ...(rm.length > 0 ? { rm } : {}),
    ...(add.length > 0 ? { add } : {}),
    ...(set.length > 0 ? { set } : {}),
    ...(order.length > 0 ? { order } : {}),
    ...(Object.keys(members).length > 0 ? { members } : {}),
  };
}
