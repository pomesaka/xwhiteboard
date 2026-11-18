// まとめの帯（summary）。付箋の状態から、決定事項・宿題・未決などの一覧を集める。
// 集める決まりは、ここの 1 か所にある。画面の描画、帯の高さ（model.ts の settleSummaries）、xwb summary、xwb ls、検査が、ここを通る。
// 帯の条件は、状態・発言者（who）・tag の組（model.ts の SummaryFilter）。
import { STATUS_LABEL, boxOf, membersOf, parseShow, statusBadge, type El, type NoteStatus, type SummaryFilter } from "./model.ts";
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
 * 2 つ以上の枠に入る付箋は、面積がいちばん小さい枠のセクション。透明な枠（frame: "none"）は数えない
 */
function sectionsOf(els: readonly El[]): Map<string, El> {
  const area = (c: El): number => {
    const b = boxOf(c);
    return b ? b.w * b.h : Infinity;
  };
  const out = new Map<string, El>();
  for (const c of els) {
    // 透明な枠は、題名を見せない。行には添えず、その外側のセクションがあれば、そちらを添える
    if (c.type !== "container" || c.frame === "none") continue;
    for (const m of membersOf(els, c)) {
      const now = out.get(m.id);
      if (!now || area(c) < area(now)) out.set(m.id, c);
    }
  }
  return out;
}

/** 帯の行 1 つと、集めるのに使う付箋の値 */
export interface Row {
  /** 付箋の状態。状態の無い付箋は無い（状態で集めない帯にだけ出る） */
  status?: NoteStatus;
  who?: string;
  tag?: string;
  item: SummaryItem;
}

/**
 * ボードの付箋と図形（shape）を、並べる順に集める。帯ごとの行は、ここから条件で選ぶ（rowsFor）。
 * 状態を書かずに carriedFrom だけを書いた付箋は、持ち越し（carried）の状態。
 * 宿題（todo）と carriedFrom の両方を書いた付箋は、宿題の状態（statusBadge と同じ決まり）。
 * 状態の無い付箋も集める。状態で集める帯（rowsFor の status）は、状態の無い付箋を選ばない
 * 並ぶ順は、ボードの上の位置の順。まず、付箋が入っているセクションの順（上から。同じ高さなら左から）。
 * 同じセクションの中では、付箋の上から、同じ高さなら左から。セクションに入っていない付箋は、その後ろに、上から、左からの順。
 * WHY 要素の並びの順にしない: 要素の並びは、列で並べるセクションの詰め直しや、画面の「元に戻す」で入れ替わる。位置の順なら、見た目の順と同じになる
 */
export function collect(els: readonly El[]): Row[] {
  const sections = sectionsOf(els);
  const at = (el: El | undefined): [number, number] => {
    const b = el ? boxOf(el) : null;
    return b ? [b.y, b.x] : [Infinity, Infinity];
  };
  const found: { key: number[]; row: Row }[] = [];
  for (const [index, el] of els.entries()) {
    if (el.type !== "shape") continue;
    const status = statusBadge(el)?.status;
    const section = sections.get(el.id);
    const title = section ? (filled(section.title) ?? filled(section.question)) : undefined;
    found.push({
      // セクションに入っているか、セクションの場所、セクションの並び（同じ場所のセクションを分ける）、付箋の場所、付箋の並び
      key: [section ? 0 : 1, ...at(section), section ? els.indexOf(section) : 0, ...at(el), index],
      row: {
        ...(status === undefined ? {} : { status }),
        ...(el.who === undefined ? {} : { who: el.who }),
        ...(el.tag === undefined ? {} : { tag: el.tag }),
        item: {
          id: el.id,
          label: labelOf(el),
          ...(el.who === undefined ? {} : { who: el.who }),
          ...(el.due === undefined ? {} : { due: el.due }),
          ...(el.carriedFrom === undefined ? {} : { carriedFrom: el.carriedFrom }),
          ...(section ? { section: { id: section.id, ...(title === undefined ? {} : { title }) } } : {}),
        },
      },
    });
  }
  const compare = (a: number[], b: number[]): number => a.map((v, i) => v - (b[i] ?? 0)).find((d) => d !== 0 && !Number.isNaN(d)) ?? 0;
  found.sort((a, b) => compare(a.key, b.key));
  return found.map((f) => f.row);
}

/**
 * 条件に当てはまる行。who と tag は、前後の空白を除いて比べる。
 * status を書かない条件（who か tag だけで集める帯）は、状態の無い付箋も選ぶ。
 * WHY: tag を自由に付けて、その tag でまとめる使い方。状態を付けていない「リスク」の付箋も、リスクの帯に出したい
 */
export function rowsFor(rows: readonly Row[], filter: SummaryFilter): Row[] {
  const same = (a: string | undefined, b: string | undefined): boolean => b === undefined || (a !== undefined && a.trim() === b.trim());
  return rows.filter((r) => (filter.status === undefined || r.status === filter.status) && same(r.who, filter.who) && same(r.tag, filter.tag));
}

/** 帯の条件。帯でない要素か、条件が読めなければ null */
export function filterOf(el: El): SummaryFilter | null {
  if (el.type !== "summary" || el.show === undefined) return null;
  const r = parseShow(el.show);
  return r.ok ? r.value : null;
}

/** 帯の要素が集める行。帯でない要素には、空の並びを返す */
export function itemsOf(rows: readonly Row[], el: El): Row[] {
  const filter = filterOf(el);
  return filter ? rowsFor(rows, filter) : [];
}

/**
 * 帯の題名を書かなかったときの題名。状態だけの条件は、状態の名前（決定、宿題）。
 * ほかは、条件を、状態、発言者、tag の順に「・」でつないだ文字（「宿題・設楽」「リスク」）
 */
export function filterTitle(filter: SummaryFilter): string {
  return [filter.status === undefined ? undefined : STATUS_LABEL[filter.status], filter.who?.trim(), filter.tag?.trim()].filter((s) => s !== undefined).join("・");
}

/** 条件を比べるための文字。状態の名前で書いた show と、{ status } だけの組は、同じ文字になる */
export function filterKey(filter: SummaryFilter): string {
  return JSON.stringify([filter.status ?? null, filter.who?.trim() ?? null, filter.tag?.trim() ?? null]);
}

/** ボードの付箋を、状態ごとに集める（xwb summary の前からの形）。並ぶ順は collect と同じ */
export function summarize(els: readonly El[]): Summary {
  const out: Summary = { decided: [], open: [], todo: [], carried: [], priority: [] };
  for (const r of collect(els)) if (r.status !== undefined) out[r.status].push(r.item);
  return out;
}

/** xwb summary が返す、ボードにある帯ごとの一覧。帯の id、条件、題名（書かなければ既定の題名）、行（状態のある付箋は状態つき） */
export function bandsOf(els: readonly El[]): { id: string; show: SummaryFilter; title: string; items: (SummaryItem & { status?: NoteStatus })[] }[] {
  const rows = collect(els);
  return els.flatMap((el) => {
    const filter = filterOf(el);
    if (!filter) return [];
    return [{ id: el.id, show: filter, title: el.title?.trim() || filterTitle(filter), items: rowsFor(rows, filter).map((r) => ({ ...r.item, ...(r.status === undefined ? {} : { status: r.status }) })) }];
  });
}
