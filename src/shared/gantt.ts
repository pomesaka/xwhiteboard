// ガントチャートの日付の計算と配置。描く側（画面）と、大きさを見積もる側（サーバー）が同じ式を使う。
import { textWidth, type El } from "./model.ts";

export const GANTT_UNITS = ["day", "week", "month"] as const;
export type GanttUnit = (typeof GANTT_UNITS)[number];
export const GANTT_STATUS = ["planned", "doing", "done"] as const;

type GanttStatus = (typeof GANTT_STATUS)[number];

/** 帯 1 本の期間。start と end は "YYYY-MM-DD" か "YYYY-MM"。end はその日（その月の末日）を含む */
export interface GanttSegment {
  start: string;
  end: string;
  /** 書かなければ、行の status */
  status?: GanttStatus;
}

/**
 * 行。帯が 1 本なら start と end を、期間が分かれる作業なら segments を書く（どちらか片方）。
 * WHY 1 行に複数の帯: 同じ作業を 2 行に分けると、同じ名前の行が並んで、別の作業に見える。
 */
export interface GanttBar {
  name: string;
  start?: string;
  end?: string;
  segments?: GanttSegment[];
  color?: string;
  status?: GanttStatus;
  /** 名前の横に出す小さい札（担当など）。札のある行は、行全体に薄い色が付く */
  tag?: string;
  /** まとまりの名前。続いた同じ名前の行の上に、見出しが 1 つ出る */
  group?: string;
}

/** 行の帯を、書き方（start・end か segments か）によらず、同じ形で返す */
export function segmentsOf(bar: GanttBar): GanttSegment[] {
  if (bar.segments) return bar.segments.map((s) => ({ ...s, ...(s.status ?? bar.status ? { status: s.status ?? bar.status } : {}) }));
  if (bar.start === undefined || bar.end === undefined) return [];
  return [{ start: bar.start, end: bar.end, ...(bar.status ? { status: bar.status } : {}) }];
}

export interface GanttMark {
  name: string;
  date: string;
}

export const GANTT_W = 720;
export const GANTT_LABEL_W = 150;
export const GANTT_PAD = 10;
export const GANTT_TITLE_H = 30;
/** 目盛りの 2 段ぶんの高さ。上の段が GANTT_GROUP_H、残りが下の段 */
export const GANTT_SCALE_H = 36;
export const GANTT_GROUP_H = 16;
export const GANTT_ROW_H = 34;
/** まとまりの見出しの行の高さ */
export const GANTT_GROUP_ROW_H = 26;
export const GANTT_MARK_H = 26;

const DAY_MS = 86400000;
const DATE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;

/** 1970-01-01 からの日数。時差に左右されないよう、日付は UTC の日として数える */
function dayOf(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

function ymd(day: number): { y: number; m: number; d: number; weekday: number } {
  const date = new Date(day * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), weekday: date.getUTCDay() };
}

const monthStart = (y: number, m: number): number => dayOf(y, m, 1);
const monthEnd = (y: number, m: number): number => dayOf(y, m + 1, 1) - 1;

/**
 * 日付の文字を日数にする。"YYYY-MM" は、始まりとして読むなら 1 日、終わりとして読むなら末日。
 * 読めない文字と、無い日付（2 月 30 日など）は null。
 */
export function parseDay(text: string, asEnd: boolean): number | null {
  const m = DATE.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  if (m[3] === undefined) return asEnd ? monthEnd(y, mo) : monthStart(y, mo);
  const day = dayOf(y, mo, Number(m[3]));
  const back = ymd(day);
  return back.m === mo && back.d === Number(m[3]) ? day : null;
}

const two = (n: number): string => String(n).padStart(2, "0");

export function formatDay(day: number, monthOnly: boolean): string {
  const { y, m, d } = ymd(day);
  return monthOnly ? `${y}-${two(m)}` : `${y}-${two(m)}-${two(d)}`;
}

export interface GanttTick {
  label: string;
  /** この目盛りが始まる日と、終わる日（含む） */
  from: number;
  to: number;
}

export interface GanttLayout {
  /** 表示する範囲の最初の日と最後の日（含む） */
  first: number;
  last: number;
  ticks: GanttTick[];
  /** 目盛りの上の段。年か年月 */
  groups: GanttTick[];
  w: number;
  h: number;
  /** 行の名前を入れる欄の幅 */
  labelW: number;
  /** 帯を描く場所の左端と幅、行の上端 */
  chartX: number;
  chartW: number;
  rowsY: number;
  marksY: number;
  /** 行ごとの上端（bars と同じ順） */
  barY: number[];
  /** まとまりの見出し */
  groupRows: { label: string; y: number }[];
  pxPerDay: number;
  /** 表示する範囲に入るマイルストーンの置き場所。日付の早い順 */
  markSpots: GanttMarkSpot[];
}

export interface GanttMarkSpot {
  name: string;
  day: number;
  /** 印の位置（ガントの左端から） */
  x: number;
  /** 何段めに置くか。名前が重なるものは下の段へずらす */
  row: number;
  /** 名前を、印の左に出すか */
  left: boolean;
  /** 印と名前が占める横の範囲 */
  from: number;
  to: number;
  /** マイルストーンではなく、「今日」の札 */
  today: boolean;
}

/**
 * 目盛りは 2 段。下の段（ticks）は月の番号か日の番号だけを書き、上の段（groups）に年か年月を書く。
 * WHY: 1 年ぶんを幅 450 のセクションに入れると 1 か月が 24px しか無く、「2027年1月」は入らない。
 */
function ticksOf(first: number, last: number, unit: GanttUnit): { ticks: GanttTick[]; groups: GanttTick[] } {
  const ticks: GanttTick[] = [];
  const groups: GanttTick[] = [];
  let day = first;
  while (day <= last) {
    const { y, m, d } = ymd(day);
    const to = unit === "month" ? Math.min(last, monthEnd(y, m)) : unit === "week" ? Math.min(last, day + 6) : day;
    ticks.push({ label: unit === "month" ? `${m}月` : String(d), from: day, to });
    // 上の段は、月の単位なら年ごと、週と日の単位なら月ごとにまとめる。週は、始まる日（月曜）の月に入れる
    const label = unit === "month" ? `${y}年` : `${y}年${m}月`;
    const group = groups[groups.length - 1];
    if (group && group.label === label) group.to = to;
    else groups.push({ label, from: day, to });
    day = to + 1;
  }
  return { ticks, groups };
}

/** 範囲を、目盛りの単位の切れ目まで広げる。月なら月の初日から末日、週なら月曜から日曜 */
function snapRange(first: number, last: number, unit: GanttUnit): [number, number] {
  switch (unit) {
    case "month": {
      const a = ymd(first);
      const b = ymd(last);
      return [monthStart(a.y, a.m), monthEnd(b.y, b.m)];
    }
    case "week":
      return [first - ((ymd(first).weekday + 6) % 7), last + ((7 - ymd(last).weekday) % 7)];
    case "day":
      return [first, last];
  }
}

export const TODAY_LABEL = "今日";
/** マイルストーンの名前の文字の大きさ。画面の CSS（.gmark）と同じ値 */
const MARK_FONT = 12;
/** 印（ひし形）と名前の間、名前どうしの間に空ける幅 */
const MARK_GAP = 12;

/**
 * マイルストーンの印と名前の置き場所を決める。
 * 名前は、右半分にある印では左へ、左半分では右へ出す（ガントの枠からはみ出さないため）。
 * 名前がほかの名前に重なるときは、下の段へずらす。
 */
function placeMarks(marks: GanttMark[], today: number | null, first: number, last: number, xOf: (day: number) => number, middle: number): GanttMarkSpot[] {
  const rows: [number, number][][] = [];
  const spots: GanttMarkSpot[] = [];
  const inRange = marks.flatMap((m) => {
    const day = parseDay(m.date, false);
    return day !== null && day >= first && day <= last ? [{ name: m.name, day, today: false }] : [];
  });
  // 「今日」の札も、マイルストーンと同じ段に、同じ決まりで置く。
  // WHY: 目盛りの上に置くと、年や月の見出しに重なる。名前どうしが重ならない置き方は、もうここにある
  if (today !== null && today >= first && today <= last) inRange.push({ name: TODAY_LABEL, day: today, today: true });
  for (const m of inRange.sort((a, b) => a.day - b.day)) {
    // 今日の線は、その日の真ん中に引く。マイルストーンは、その日の始まり
    const x = xOf(m.day + (m.today ? 0.5 : 0));
    const left = x > middle;
    const w = m.name === "" ? 0 : textWidth(m.name, MARK_FONT) + MARK_GAP;
    const from = left ? x - w - MARK_GAP / 2 : x - MARK_GAP / 2;
    const to = left ? x + MARK_GAP / 2 : x + w + MARK_GAP / 2;
    let row = rows.findIndex((taken) => taken.every(([a, b]) => to + MARK_GAP <= a || from >= b + MARK_GAP));
    if (row < 0) row = rows.push([]) - 1;
    rows[row]?.push([from, to]);
    spots.push({ name: m.name, day: m.day, x, row, left, from, to, today: m.today });
  }
  return spots;
}

export function ganttLayout(el: El): GanttLayout {
  const unit = el.unit ?? "month";
  const bars = el.bars ?? [];
  const marks = el.marks ?? [];
  const days: number[] = [];
  const push = (text: string | undefined, asEnd: boolean): void => {
    const d = text === undefined ? null : parseDay(text, asEnd);
    if (d !== null) days.push(d);
  };
  // 範囲を書いていれば、その範囲。書いていなければ、行とマイルストーンが全部入る範囲
  if (el.start !== undefined && el.end !== undefined) {
    push(el.start, false);
    push(el.end, true);
  } else {
    push(el.start, false);
    push(el.end, true);
    for (const b of bars) {
      for (const seg of segmentsOf(b)) {
        push(seg.start, false);
        push(seg.end, true);
      }
    }
    for (const m of marks) push(m.date, false);
  }
  const lo = days.length > 0 ? Math.min(...days) : dayOf(2026, 1, 1);
  const hi = days.length > 0 ? Math.max(...days) : lo + 30;
  const [first, last] = snapRange(lo, hi, unit);
  const w = el.w ?? GANTT_W;
  const labelW = el.labelW ?? GANTT_LABEL_W;
  const chartX = GANTT_PAD + labelW;
  const chartW = Math.max(60, w - chartX - GANTT_PAD);
  const rowsY = GANTT_PAD + (el.title ? GANTT_TITLE_H : 0) + GANTT_SCALE_H;
  // 行を上から置く。まとまりの名前が変わる行の上に、見出しの行を 1 つ入れる
  const barY: number[] = [];
  const groupRows: { label: string; y: number }[] = [];
  let y = rowsY;
  let group: string | undefined;
  for (const b of bars) {
    if (b.group !== undefined && b.group !== group) {
      groupRows.push({ label: b.group, y });
      y += GANTT_GROUP_ROW_H;
    }
    group = b.group;
    barY.push(y);
    y += GANTT_ROW_H;
  }
  const marksY = y;
  const pxPerDay = chartW / (last - first + 1);
  const today = el.today === undefined ? null : parseDay(el.today, false);
  const markSpots = placeMarks(marks, today, first, last, (day) => chartX + (day - first) * pxPerDay, chartX + chartW / 2);
  // 印か「今日」が 1 つでもあれば 1 段ぶんは取る（範囲の外の印だけでも、置き場所が要るかどうかで高さが変わらないように）
  const markRows = marks.length > 0 || today !== null ? Math.max(1, ...markSpots.map((s) => s.row + 1)) : 0;
  return {
    first,
    last,
    ...ticksOf(first, last, unit),
    w,
    h: marksY + markRows * GANTT_MARK_H + GANTT_PAD,
    labelW,
    chartX,
    chartW,
    rowsY,
    marksY,
    barY,
    groupRows,
    pxPerDay,
    markSpots,
  };
}

function addMonths(day: number, months: number, toEnd: boolean): number {
  const { y, m } = ymd(day);
  return toEnd ? monthEnd(y, m + months) : monthStart(y, m + months);
}

/**
 * 人が帯を動かした後の、その帯の開始と終了。edge は、つかんだ場所（左端・右端・帯の全体）。
 * 月の単位では月の切れ目に、週と日の単位では日に合わせる。開始が終了を越えないように止める。
 */
export function dragBar(bar: { start: string; end: string }, unit: GanttUnit, edge: "start" | "end" | "move", deltaDays: number): { start: string; end: string } {
  const start = parseDay(bar.start, false);
  const end = parseDay(bar.end, true);
  if (start === null || end === null) return { start: bar.start, end: bar.end };
  // 動かしていない端は、書かれたままの文字を残す（月の単位でも、日付まで書かれた端を月に丸めない）
  if (unit === "month") {
    const months = Math.round(deltaDays / 30.44);
    switch (edge) {
      case "start":
        return { start: formatDay(Math.min(addMonths(start, months, false), addMonths(end, 0, false)), true), end: bar.end };
      case "end":
        return { start: bar.start, end: formatDay(Math.max(addMonths(end, months, true), addMonths(start, 0, true)), true) };
      case "move":
        return months === 0 ? { start: bar.start, end: bar.end } : { start: formatDay(addMonths(start, months, false), true), end: formatDay(addMonths(end, months, true), true) };
    }
  }
  switch (edge) {
    case "start":
      return { start: formatDay(Math.min(start + deltaDays, end), false), end: bar.end };
    case "end":
      return { start: bar.start, end: formatDay(Math.max(end + deltaDays, start), false) };
    case "move":
      return deltaDays === 0 ? { start: bar.start, end: bar.end } : { start: formatDay(start + deltaDays, false), end: formatDay(end + deltaDays, false) };
  }
}
