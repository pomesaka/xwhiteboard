// 注目（いま話している議題のセクション）の間の、画面の見せ方の判定。
// 画面（src/client/main.ts）だけが使う。テストで確かめられるように、DOM を使わない関数にしてある。
import { membersOf, type El } from "./model.ts";

/**
 * 注目している間、薄くしない要素の id。注目していなければ null（id のセクションが無いときも）。
 * 薄くしないのは、注目したセクションとその中身、固定した要素、固定したセクションの中身、それらを指すコメント（on）。
 * WHY 固定を薄くしない: 会議中ずっと見たいまとめの帯（決定事項、ToDo、未決）は、固定したセクションに置く。議題が移るたびに薄くなると読めない。
 * 固定に「薄くしない」の意味を兼ねさせるのは仮の決めで、pomesaka に確かめている途中。条件を変えるときは、ここだけを直す。
 */
export function keptOnFocus(els: readonly El[], focusId: string | null): Set<string> | null {
  const section = focusId === null ? undefined : els.find((e) => e.id === focusId);
  if (section?.type !== "container") return null;
  const kept = new Set<string>();
  const keepWithMembers = (c: El): void => {
    kept.add(c.id);
    for (const m of membersOf(els, c)) kept.add(m.id);
  };
  keepWithMembers(section);
  for (const el of els) {
    if (el.locked !== true) continue;
    if (el.type === "container") keepWithMembers(el);
    else kept.add(el.id);
  }
  // WHY コメントは指す先に合わせる: ピンのコメントは、指す要素のそば（枠の外のこともある）に置かれる。話している付箋のコメントだけが薄くなると読めない。
  // 先に集めた要素だけを見る（コメントを指すコメントは、たどらない）
  const targets = new Set(kept);
  for (const el of els) if (el.type === "comment" && el.on !== undefined && targets.has(el.on)) kept.add(el.id);
  return kept;
}

/** 注目の札に出す、セクションの名前。題名、無ければ論点、それも無ければ id */
export function focusLabel(section: El): string {
  return [section.title, section.question].map((s) => s?.trim() ?? "").find((s) => s !== "") ?? section.id;
}
