// 画面の「元に戻す」が送る、逆の操作の組み立て。
// 画面（src/client/main.ts）だけが使う。applyOps との往復をテストで確かめられるように、DOM を使わない関数にしてある。
import { isRecord, type El } from "./model.ts";

/** 要素の位置と大きさを決める項目 */
export const GEOMETRY = ["x", "y", "w", "h", "points", "from", "to"] as const;
/** そのうち、位置を決める項目 */
const POSITION: readonly string[] = ["x", "y", "points", "from", "to"];

/** local の位置と大きさを、remote に写す。ドラッグの最中に届いた更新で、手元の位置を保つのに使う */
export function withGeometry(remote: El, local: El): El {
  const out: El = { ...remote };
  for (const k of GEOMETRY) Object.assign(out, { [k]: local[k] });
  return out;
}

/**
 * サーバーの返事で変わった要素（updated）の位置と大きさを、変える前の値（before）へ戻す操作を作る。
 * WHY: 逆の操作を、送った項目だけから作ると、サーバーが足した変更（押し下げ、セクションの伸び、幅をそろえる）が戻らない。
 * 位置の項目は、値が変わっていなくても書く。
 * WHY: 戻す操作の中で、列で並べるセクションを set で動かすと、サーバーが中身を一緒に動かす。
 * 押し下げと詰め直しが打ち消し合って位置が変わらなかった中身は、書かなければ、そのぶんずれる。
 * 送る側が逆の操作（inverse）の set に書いた項目は、ここでは作らない。
 * ドラッグでは、before が動かした後の値で、元の値は inverse にあるため。
 */
export function restoreOps(before: ReadonlyMap<string, El>, updated: readonly El[], inverse: readonly unknown[]): unknown[] {
  const covered = new Map<string, Set<string>>();
  for (const op of inverse) {
    if (!isRecord(op) || op.op !== "set" || typeof op.id !== "string" || !isRecord(op.patch)) continue;
    covered.set(op.id, new Set([...(covered.get(op.id) ?? []), ...Object.keys(op.patch)]));
  }
  const out: unknown[] = [];
  for (const next of updated) {
    const prev = before.get(next.id);
    if (!prev) continue;
    const patch: Record<string, unknown> = {};
    for (const k of GEOMETRY) {
      if (covered.get(next.id)?.has(k)) continue;
      const moved = JSON.stringify(prev[k]) !== JSON.stringify(next[k]);
      if (moved || (POSITION.includes(k) && prev[k] !== undefined)) patch[k] = prev[k] ?? null;
    }
    if (Object.keys(patch).length > 0) out.push({ op: "set", id: next.id, patch });
  }
  return out;
}

/**
 * 逆の操作から、もう無い要素への set と rm を除く。has は、その id の要素が今あるか。
 * WHY: 操作のまとまりは、1 つでも失敗すると全部が取りやめになる。
 * 逆の操作を積んだ後に、エージェントやほかの画面が要素を消していると、その要素の位置を戻す set のせいで、
 * 戻せるはずの残りまで戻らない。
 */
export function dropMissing(ops: readonly unknown[], has: (id: string) => boolean): unknown[] {
  return ops.filter((op) => !(isRecord(op) && (op.op === "set" || op.op === "rm") && typeof op.id === "string" && !has(op.id)));
}
