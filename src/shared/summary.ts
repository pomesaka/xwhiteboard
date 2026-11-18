// まとめの帯（summary）。付箋の状態から、決定事項・宿題・未決などの一覧を集める。
// 集める決まりは、ここの 1 か所にある。画面の描画、帯の高さ、xwb summary、xwb ls、検査が、ここを通る。
import { boxOf, membersOf, statusBadge, summaryHeight, type El, type NoteStatus } from "./model.ts";
import { parseRich } from "./rich.ts";

/** 帯の 1 行。1 枚の付箋 */
export interface SummaryItem {
  /** 付箋の id */
  id: string;
  /** 行に出す文字。見出し、無ければ本文の最初の行、それも無ければ id */
  label: string;
  who?: string;
  due?: string;
  carriedFrom?: string;
  /** 付箋が入っているセクション。題名は、セクションの題名、無ければ論点。どちらも無ければ省く */
  section?: { id: string; title?: string };
}

export type Summary = Record<NoteStatus, SummaryItem[]>;

const filled = (s: string | undefined): string | undefined => (s !== undefined && s.trim() !== "" ? s.trim() : undefined);

/** 行に出す文字。本文は、空でない最初の行から、装飾の記号と箇条書きの印を除いたもの（リンクは表示の文字） */
function labelOf(el: El): string {
  const lines = parseRich(el.text ?? "").flatMap((b) => b.lines.map((line) => line.map((i) => i.text).join("")));
  return filled(el.title) ?? lines.map(filled).find((l) => l !== undefined) ?? el.id;
}

/**
 * 付箋ごとの、入っているセクション。中身の決まりは membersOf と同じ（中心が枠の中）。
 * 2 つ以上の枠に入る付箋は、面積がいちばん小さい枠のセクション
 */
function sectionsOf(els: readonly El[]): Map<string, El> {
  const area = (c: El): number => {
    const b = boxOf(c);
    return b ? b.w * b.h : Infinity;
  };
  const out = new Map<string, El>();
  for (const c of els) {
    if (c.type !== "container") continue;
    for (const m of membersOf(els, c)) {
      const now = out.get(m.id);
      if (!now || area(c) < area(now)) out.set(m.id, c);
    }
  }
  return out;
}

/**
 * ボードの付箋を、状態ごとに集める。
 * 集めるのは、状態のある付箋と図形（shape）。状態を書かずに carriedFrom だけを書いた付箋は、持ち越し（carried）に入る。
 * 宿題（todo）と carriedFrom の両方を書いた付箋は、宿題にだけ入る（statusBadge と同じ決まり）。
 * 並ぶ順は、ボードの上の位置の順。まず、付箋が入っているセクションの順（上から。同じ高さなら左から）。
 * 同じセクションの中では、付箋の上から、同じ高さなら左から。セクションに入っていない付箋は、その後ろに、上から、左からの順。
 * WHY 要素の並びの順にしない: 要素の並びは、列で並べるセクションの詰め直しや、画面の「元に戻す」で入れ替わる。位置の順なら、見た目の順と同じになる
 */
export function summarize(els: readonly El[]): Summary {
  const sections = sectionsOf(els);
  const at = (el: El | undefined): [number, number] => {
    const b = el ? boxOf(el) : null;
    return b ? [b.y, b.x] : [Infinity, Infinity];
  };
  const found: { status: NoteStatus; key: number[]; item: SummaryItem }[] = [];
  for (const [index, el] of els.entries()) {
    const status = el.type === "shape" ? statusBadge(el)?.status : undefined;
    if (status === undefined) continue;
    const section = sections.get(el.id);
    const title = section ? (filled(section.title) ?? filled(section.question)) : undefined;
    found.push({
      status,
      // セクションに入っているか、セクションの場所、セクションの並び（同じ場所のセクションを分ける）、付箋の場所、付箋の並び
      key: [section ? 0 : 1, ...at(section), section ? els.indexOf(section) : 0, ...at(el), index],
      item: {
        id: el.id,
        label: labelOf(el),
        ...(el.who === undefined ? {} : { who: el.who }),
        ...(el.due === undefined ? {} : { due: el.due }),
        ...(el.carriedFrom === undefined ? {} : { carriedFrom: el.carriedFrom }),
        ...(section ? { section: { id: section.id, ...(title === undefined ? {} : { title }) } } : {}),
      },
    });
  }
  const compare = (a: number[], b: number[]): number => a.map((v, i) => v - (b[i] ?? 0)).find((d) => d !== 0 && !Number.isNaN(d)) ?? 0;
  found.sort((a, b) => compare(a.key, b.key));
  const out: Summary = { decided: [], open: [], todo: [], carried: [], priority: [] };
  for (const f of found) out[f.status].push(f.item);
  return out;
}

/** 帯の要素が集める行。帯でない要素には、空の並びを返す */
export function itemsOf(summary: Summary, el: El): SummaryItem[] {
  return el.type === "summary" && el.show !== undefined ? summary[el.show] : [];
}

/**
 * まとめの帯の h に、今の行の数からの高さを入れた要素の並びを返す。ほかの要素は、そのまま。
 * WHY: 帯の高さは、ほかの付箋の状態で決まり、要素 1 つからは分からない。大きさを使う所（検査、xwb ls、画面）は、先にこれを通す
 */
export function withSummaryHeights(els: readonly El[]): El[] {
  if (!els.some((e) => e.type === "summary")) return [...els];
  const summary = summarize(els);
  return els.map((el) => (el.type === "summary" ? { ...el, h: summaryHeight(itemsOf(summary, el).length) } : el));
}
