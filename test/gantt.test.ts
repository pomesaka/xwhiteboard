import { describe, expect, test } from "bun:test";
import { dragBar, formatDay, ganttLayout, parseDay, segmentsOf, type GanttBar } from "../src/shared/gantt.ts";
import { parseEl, sizeOf, type El } from "../src/shared/model.ts";

const day = (text: string): number => parseDay(text, false) ?? Number.NaN;

describe("日付を読む", () => {
  test.each([
    ["日まで書いた日付", "2026-12-15", false, "2026-12-15"],
    ["月だけの日付は、始まりなら 1 日", "2026-12", false, "2026-12-01"],
    ["月だけの日付は、終わりなら末日", "2026-12", true, "2026-12-31"],
    ["2 月の末日（平年）", "2027-02", true, "2027-02-28"],
    ["2 月の末日（うるう年）", "2028-02", true, "2028-02-29"],
  ])("%s", (_name, text, asEnd, expected) => {
    const d = parseDay(text, asEnd);
    expect(d === null ? null : formatDay(d, false)).toBe(expected);
  });

  test.each([["2026-13"], ["2026-02-30"], ["2026/12/01"], ["12 月"], [""]])("読めない日付は断る: %s", (text) => {
    expect(parseDay(text, false)).toBeNull();
  });
});

const gantt = (extra: Partial<El>): El => ({ id: "g", type: "gantt", x: 0, y: 0, bars: [{ name: "a", start: "2026-12-10", end: "2027-01-20" }], ...extra });

describe("表示する範囲と目盛り", () => {
  test.each([
    ["月の単位は、行が入る月の初日から末日まで", gantt({ unit: "month" }), "2026-12-01", "2027-01-31", ["12月", "1月"], ["2026年", "2027年"]],
    ["単位を書かなければ月", gantt({}), "2026-12-01", "2027-01-31", ["12月", "1月"], ["2026年", "2027年"]],
    ["範囲を書いたら、行がはみ出してもその範囲", gantt({ start: "2026-11", end: "2027-03" }), "2026-11-01", "2027-03-31", ["11月", "12月", "1月", "2月", "3月"], ["2026年", "2027年"]],
    ["週の単位は、月曜から日曜まで", gantt({ unit: "week", bars: [{ name: "a", start: "2026-11-11", end: "2026-11-20" }] }), "2026-11-09", "2026-11-22", ["9", "16"], ["2026年11月"]],
    ["日の単位は、その日からその日まで", gantt({ unit: "day", bars: [{ name: "a", start: "2026-11-29", end: "2026-12-02" }] }), "2026-11-29", "2026-12-02", ["29", "30", "1", "2"], ["2026年11月", "2026年12月"]],
    ["マイルストーンも範囲に入れる", gantt({ marks: [{ name: "稼働", date: "2027-03-05" }] }), "2026-12-01", "2027-03-31", ["12月", "1月", "2月", "3月"], ["2026年", "2027年"]],
  ])("%s", (_name, el, first, last, labels, groups) => {
    const L = ganttLayout(el);
    expect([formatDay(L.first, false), formatDay(L.last, false)]).toEqual([first, last]);
    expect(L.ticks.map((t) => t.label)).toEqual(labels);
    expect(L.groups.map((g) => g.label)).toEqual(groups);
  });
});

describe("大きさは、行の数と、題名・マイルストーンの有無で決まる", () => {
  const bar: GanttBar = { name: "a", start: "2026-12", end: "2026-12" };
  test.each([
    ["1 行", gantt({ bars: [bar] }), { w: 720, h: 90 }],
    ["行を足すと、1 行ぶん高くなる", gantt({ bars: [bar, bar, bar] }), { w: 720, h: 158 }],
    ["題名があると、そのぶん高い", gantt({ bars: [bar], title: "日程" }), { w: 720, h: 120 }],
    ["マイルストーンがあると、そのぶん高い", gantt({ bars: [bar], marks: [{ name: "m", date: "2026-12-10" }] }), { w: 720, h: 116 }],
    ["幅を書いたら、その幅", gantt({ bars: [bar], w: 500 }), { w: 500, h: 90 }],
  ])("%s", (_name, el, expected) => {
    expect(sizeOf(el)).toEqual(expected);
  });
});

describe("1 行に帯を複数置ける。まとまりの見出しは、名前が変わる行の上に 1 つ入る", () => {
  const split = gantt({
    bars: [
      { name: "CI/CD", segments: [{ start: "2027-02", end: "2027-03" }, { start: "2027-07", end: "2027-08", status: "planned" }], status: "done", group: "開発" },
      { name: "結合試験", start: "2027-07", end: "2027-08", group: "開発" },
      { name: "周知", start: "2027-09", end: "2027-10", group: "移行" },
      { name: "その他", start: "2027-10", end: "2027-10" },
    ],
  });
  const L = ganttLayout(split);

  test("範囲は、全部の帯が入る月まで", () => {
    expect([formatDay(L.first, false), formatDay(L.last, false)]).toEqual(["2027-02-01", "2027-10-31"]);
  });

  test("帯ごとの状態は、書いていなければ行の状態を引き継ぐ", () => {
    expect(segmentsOf(split.bars?.[0] ?? { name: "" })).toEqual([
      { start: "2027-02", end: "2027-03", status: "done" },
      { start: "2027-07", end: "2027-08", status: "planned" },
    ]);
  });

  test("start・end で書いた行は、帯 1 本として読む", () => {
    expect(segmentsOf({ name: "a", start: "2027-01", end: "2027-02" })).toEqual([{ start: "2027-01", end: "2027-02" }]);
  });

  test("見出しは、まとまりごとに 1 つ。まとまりの無い行には付かない", () => {
    expect(L.groupRows).toEqual([
      { label: "開発", y: 46 },
      { label: "移行", y: 140 },
    ]);
    expect(L.barY).toEqual([72, 106, 166, 200]);
  });

  test("高さは、見出しの行のぶんだけ増える", () => {
    expect(L.h).toBe(244);
  });
});

describe("期間の書き方が合わない行は断る", () => {
  test.each([
    ["start・end と segments の両方", { name: "a", start: "2027-01", end: "2027-02", segments: [{ start: "2027-03", end: "2027-04" }] }, "どちらか片方"],
    ["空の segments", { name: "a", segments: [] }, "1 つ以上"],
    ["segments の中の期間が逆さま", { name: "a", segments: [{ start: "2027-04", end: "2027-03" }] }, "segments[0] の start が end より後"],
    ["期間が無い", { name: "a" }, "start と end が要る"],
    ["札が文字列でない", { name: "a", start: "2027-01", end: "2027-02", tag: 1 }, "tag は文字列"],
  ])("%s", (_name, bar, message) => {
    const r = parseEl({ id: "g", type: "gantt", x: 0, y: 0, bars: [bar] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe("マイルストーンの名前は、重なるなら下の段へずらし、枠の中へ向けて出す", () => {
  const year = { start: "2026-12", end: "2027-11", w: 456 };
  const spots = (marks: { name: string; date: string }[]): string[] => ganttLayout(gantt({ ...year, marks })).markSpots.map((s) => `${s.name}:${s.row}:${s.left ? "左" : "右"}`);

  test.each([
    ["離れた印は、同じ段に並ぶ", [{ name: "着手", date: "2026-12" }, { name: "稼働", date: "2027-11" }], ["着手:0:右", "稼働:0:左"]],
    ["隣り合う月の印は、名前が重なるので段をずらす", [{ name: "動作確認 1 回め", date: "2026-12" }, { name: "動作確認 2 回め", date: "2027-01" }, { name: "動作確認 3 回め", date: "2027-02" }], ["動作確認 1 回め:0:右", "動作確認 2 回め:1:右", "動作確認 3 回め:2:右"]],
    ["名前の無い印は場所を取らないので、同じ段に並ぶ", [{ name: "", date: "2026-12" }, { name: "", date: "2027-01" }, { name: "", date: "2027-02" }], [":0:右", ":0:右", ":0:右"]],
    ["日付の早い順に置く（書いた順ではない）", [{ name: "後", date: "2027-10" }, { name: "先", date: "2026-12" }], ["先:0:右", "後:0:左"]],
    ["表示する範囲の外の印は置かない", [{ name: "外", date: "2028-01" }, { name: "中", date: "2027-03" }], ["中:0:右"]],
  ])("%s", (_name, marks, expected) => {
    expect(spots(marks)).toEqual(expected);
  });

  test.each([
    ["印が同じ段に収まれば、1 段ぶんの高さ", [{ name: "着手", date: "2026-12" }, { name: "稼働", date: "2027-11" }], 116],
    ["段をずらしたぶん、高くなる", [{ name: "動作確認 1 回め", date: "2026-12" }, { name: "動作確認 2 回め", date: "2027-01" }, { name: "動作確認 3 回め", date: "2027-02" }], 168],
  ])("%s", (_name, marks, h) => {
    expect(ganttLayout(gantt({ ...year, marks })).h).toBe(h);
  });
});

describe("「今日」の札は、マイルストーンと同じ段に置く（目盛りの見出しに重ねない）", () => {
  const year = { start: "2026-11", end: "2027-11", w: 900 };
  const spots = (extra: Partial<El>): string[] => ganttLayout(gantt({ ...year, ...extra })).markSpots.map((s) => `${s.name}:${s.row}:${s.today ? "今日" : "印"}`);

  test.each([
    ["今日だけなら、1 段めに置く", { today: "2026-11-13" }, ["今日:0:今日"]],
    ["離れた印とは、同じ段に並ぶ", { today: "2026-11-13", marks: [{ name: "稼働", date: "2027-11-15" }] }, ["今日:0:今日", "稼働:0:印"]],
    ["近い印とは、段をずらす", { today: "2026-11-13", marks: [{ name: "キックオフ", date: "2026-11-20" }] }, ["今日:0:今日", "キックオフ:1:印"]],
    ["表示する範囲の外の今日は置かない", { today: "2025-01-01" }, []],
  ])("%s", (_name, extra, expected) => {
    expect(spots(extra)).toEqual(expected);
  });

  test.each([
    ["今日を書かなければ、段を取らない", {}, 90],
    ["今日を書くと、1 段ぶん高くなる", { today: "2026-11-13" }, 116],
  ])("%s", (_name, extra, h) => {
    expect(ganttLayout(gantt({ ...year, ...extra })).h).toBe(h);
  });
});

describe("人が帯を動かすと、単位の切れ目に合わせて日付が変わる", () => {
  type Period = { start: string; end: string };
  const monthly: Period = { start: "2026-12", end: "2027-02" };
  const daily: Period = { start: "2026-12-10", end: "2026-12-20" };
  test.each<[string, Period, "day" | "week" | "month", "start" | "end" | "move", number, Period]>([
    ["月: 右端を 1 か月ぶん右へ", monthly, "month", "end", 31, { start: "2026-12", end: "2027-03" }],
    ["月: 左端を 1 か月ぶん右へ", monthly, "month", "start", 30, { start: "2027-01", end: "2027-02" }],
    ["月: 全体を 2 か月ぶん左へ", monthly, "month", "move", -61, { start: "2026-10", end: "2026-12" }],
    ["月: 半月に満たない動きでは変わらない", monthly, "month", "end", 10, { start: "2026-12", end: "2027-02" }],
    ["月: 左端は、終わりの月より後へは行かない", monthly, "month", "start", 200, { start: "2027-02", end: "2027-02" }],
    ["月: 動かしていない端は、日まで書かれていても残る", { start: "2026-12-15", end: "2027-02" }, "month", "end", 31, { start: "2026-12-15", end: "2027-03" }],
    ["日: 右端を 3 日右へ", daily, "day", "end", 3, { start: "2026-12-10", end: "2026-12-23" }],
    ["週: 全体を 7 日右へ", daily, "week", "move", 7, { start: "2026-12-17", end: "2026-12-27" }],
    ["日: 右端は、始まりの日より前へは行かない", daily, "day", "end", -40, { start: "2026-12-10", end: "2026-12-10" }],
  ])("%s", (_name, bar, unit, edge, delta, expected) => {
    expect(dragBar(bar, unit, edge, delta)).toEqual(expected);
  });
});

describe("ガントの要素は、読めない日付と逆さまの期間を断る", () => {
  test.each([
    ["行の日付が読めない", { bars: [{ name: "a", start: "12 月", end: "2027-01" }] }, "YYYY-MM-DD か YYYY-MM"],
    ["行の始まりが終わりより後", { bars: [{ name: "a", start: "2027-02", end: "2027-01" }] }, "start が end より後"],
    ["行に知らない項目", { bars: [{ name: "a", start: "2027-01", end: "2027-02", owner: "x" }] }, "owner は無い"],
    ["知らない状態", { bars: [{ name: "a", start: "2027-01", end: "2027-02", status: "wip" }] }, "status は"],
    ["知らない単位", { bars: [], unit: "year" }, "unit は"],
    ["マイルストーンの日付が読めない", { bars: [], marks: [{ name: "m", date: "来月" }] }, "marks[0]"],
    ["行が無い", {}, "bars が要る"],
  ])("%s", (_name, extra, message) => {
    const r = parseEl({ id: "g", type: "gantt", x: 0, y: 0, ...extra });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  test("帯の位置は、日付から決まる（12/1〜1/31 の範囲で、1/1 は幅の半分の位置）", () => {
    const L = ganttLayout(gantt({}));
    expect(Math.round((day("2027-01-01") - L.first) * L.pxPerDay)).toBe(Math.round(L.chartW / 2));
  });
});
