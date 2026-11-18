import { describe, expect, test } from "bun:test";
import { applyOps, commentPayload, dueLabel, emptyDoc, isOverdue, localDay, metaParts, parseDoc, parseEl, serialize, statusBadge, type El, type NoteStatus } from "../src/shared/model.ts";

const note = (extra: Record<string, unknown>) => ({ id: "a", type: "shape", x: 0, y: 0, w: 220, h: 110, ...extra });
const el = (extra: Partial<El>): El => ({ id: "a", type: "shape", ...extra });

describe("付箋の期限（due）を書く", () => {
  test.each([
    ["日までの日付", note({ due: "2026-11-20" }), "2026-11-20"],
    ["月までの日付", note({ due: "2026-11" }), "2026-11"],
    ["決定（decided）の付箋にも書ける", note({ due: "2026-11-20", status: "decided" }), "2026-11-20"],
    ["持ち越しの付箋にも書ける", note({ due: "2026-11-20", carriedFrom: "2026-11-11" }), "2026-11-20"],
    ["付箋でない図形にも書ける", note({ due: "2026-11-20", shape: "rect" }), "2026-11-20"],
  ])("%s", (_name, raw, expected) => {
    const r = parseEl(raw);
    expect(r.ok && r.value.due).toBe(expected);
  });

  test.each([
    ["月と日だけ", note({ due: "11/20" }), "due は YYYY-MM-DD か YYYY-MM の日付"],
    ["無い日", note({ due: "2026-02-30" }), "due は"],
    ["数値", note({ due: 20261120 }), "due は"],
    ["空の文字", note({ due: "" }), "due は"],
    ["文字（text）の要素", { id: "a", type: "text", x: 0, y: 0, text: "x", due: "2026-11-20" }, "text に due は無い"],
    ["セクション", { id: "a", type: "container", x: 0, y: 0, w: 400, h: 200, due: "2026-11-20" }, "container に due は無い"],
  ])("%s は断る", (_name, raw, message) => {
    const r = parseEl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  const build = (ops: unknown[]) => {
    const r = applyOps(emptyDoc("t"), ops);
    if (!r.ok) throw new Error(r.error);
    return r.value.doc;
  };
  const added = [{ op: "add", el: note({ due: "2026-11-20", text: "見積もり" }) }];

  test.each<[string, unknown, string | undefined]>([
    ["null を書くと消える", { due: null }, undefined],
    ["別の日付に替える", { due: "2026-12" }, "2026-12"],
  ])("set: %s", (_name, patch, expected) => {
    expect(build([...added, { op: "set", id: "a", patch }]).elements[0]?.due).toBe(expected);
  });

  test("set でも、日付でない値は断る", () => {
    expect(applyOps(emptyDoc("t"), [...added, { op: "set", id: "a", patch: { due: "11/20" } }]).ok).toBe(false);
  });

  test("ファイルに書いて読み直しても残る", () => {
    const r = parseDoc(serialize(build(added)));
    expect(r.ok && r.value.elements[0]?.due).toBe("2026-11-20");
  });

  test.each<[string, Record<string, unknown>, unknown]>([
    ["期限のある付箋", { due: "2026-11-20" }, "2026-11-20"],
    ["期限の無い付箋", {}, undefined],
  ])("コメントに付ける要素の中身: %s", (_name, extra, expected) => {
    const doc = build([{ op: "add", el: note({ text: "見積もり", ...extra }) }, { op: "add", el: { id: "c", type: "comment", x: 10, y: 10, on: "a" } }]);
    const said = applyOps(doc, [{ op: "say", id: "c", text: "これは？" }], { by: "human", at: "2026-11-18T10:00:00+09:00" });
    if (!said.ok) throw new Error(said.error);
    const r = commentPayload(said.value.doc, "c");
    expect(r.ok && r.value.elements[0]?.due).toBe(expected);
  });
});

describe("期限の文字", () => {
  test.each<[string, Partial<El>, string | null]>([
    ["月と日。年は出さない", { due: "2026-11-20" }, "〆11/20"],
    ["日の頭の 0 は出さない", { due: "2026-11-05" }, "〆11/5"],
    ["月の頭の 0 も出さない", { due: "2027-01-09" }, "〆1/9"],
    ["月までの期限", { due: "2026-11" }, "〆11月"],
    ["期限が無い", {}, null],
  ])("%s", (_name, fields, expected) => {
    expect(dueLabel(el(fields))).toBe(expected);
  });
});

describe("札の段に並ぶ部品", () => {
  test.each<[string, Partial<El>, string[]]>([
    ["何も無ければ、段が無い", { text: "本文" }, []],
    ["左から、状態の札、tag、期限、発言者", { status: "todo", tag: "営業", due: "2026-11-20", who: "竹内" }, ["status:宿題", "tag:営業", "due:〆11/20", "who:竹内"]],
    ["持ち越しの未決も、状態の札が 1 つ", { status: "open", carriedFrom: "2026-11-11", who: "竹内" }, ["status:未決11/11から", "who:竹内"]],
    ["持ち越しの宿題は、状態の札が 1 つ", { status: "todo", carriedFrom: "2026-11-11", due: "2026-11-20", who: "竹内" }, ["status:宿題11/11から", "due:〆11/20", "who:竹内"]],
    ["期限だけ", { due: "2026-11-20" }, ["due:〆11/20"]],
    ["持ち越しの日付だけを書いた付箋と、期限", { carriedFrom: "2026-11-11", due: "2026-11-20" }, ["status:持ち越し 11/11", "due:〆11/20"]],
    ["tag と発言者", { tag: "事実", who: "竹内" }, ["tag:事実", "who:竹内"]],
  ])("%s", (_name, fields, expected) => {
    expect(metaParts(el(fields)).map((p) => `${p.kind}:${p.text}`)).toEqual(expected);
  });
});

describe("期限切れか", () => {
  test.each<[string, Partial<El>, string, boolean]>([
    ["期限の前の日", { due: "2026-11-19" }, "2026-11-18", false],
    ["期限の日は、まだ過ぎていない", { due: "2026-11-18" }, "2026-11-18", false],
    ["期限の次の日", { due: "2026-11-17" }, "2026-11-18", true],
    ["月をまたぐ", { due: "2026-10-31" }, "2026-11-01", true],
    ["年をまたぐ", { due: "2025-12-31" }, "2026-01-01", true],
    ["月までの期限。前の月", { due: "2026-11" }, "2026-10-31", false],
    ["月までの期限。その月の初日", { due: "2026-11" }, "2026-11-01", false],
    ["月までの期限。その月の末日", { due: "2026-11" }, "2026-11-30", false],
    ["月までの期限。次の月の初日", { due: "2026-11" }, "2026-12-01", true],
    ["月までの期限。年をまたぐ", { due: "2026-12" }, "2027-01-01", true],
    ["月までの期限。うるう年の 2/29", { due: "2028-02" }, "2028-02-29", false],
    ["決定（decided）の付箋も、期限で見る", { due: "2026-11-17", status: "decided" }, "2026-11-18", true],
    ["宿題（todo）の付箋", { due: "2026-11-17", status: "todo" }, "2026-11-18", true],
    ["未決（open）の付箋は数える", { due: "2026-11-17", status: "open" }, "2026-11-18", true],
    ["持ち越しの付箋は数える", { due: "2026-11-17", carriedFrom: "2026-11-11" }, "2026-11-18", true],
    ["付箋でない図形も数える", { due: "2026-11-17", shape: "rect" }, "2026-11-18", true],
    ["期限が無い", { status: "open" }, "2026-11-18", false],
  ])("%s", (_name, fields, today, expected) => {
    expect(isOverdue(el(fields), today)).toBe(expected);
  });
});

describe("今日の日付", () => {
  // Date の年月日は、その場所の時計で作る。UTC で文字にすると、日本では朝 9 時まで前の日になる
  test.each<[string, Date, string]>([
    ["夜中の 0 時 30 分", new Date(2026, 10, 18, 0, 30), "2026-11-18"],
    ["夜の 23 時 59 分", new Date(2026, 10, 18, 23, 59), "2026-11-18"],
    ["1 桁の月と日は、0 を付ける", new Date(2027, 0, 5, 12), "2027-01-05"],
  ])("%s", (_name, now, expected) => {
    expect(localDay(now)).toBe(expected);
  });
});

describe("状態の宿題（todo）", () => {
  test.each<[string, Record<string, unknown>, { status: NoteStatus; label: string }]>([
    ["宿題", { status: "todo" }, { status: "todo", label: "宿題" }],
    ["持ち越しの宿題。1 つの札に、元の日付を付ける", { status: "todo", carriedFrom: "2026-11-11" }, { status: "todo", label: "宿題11/11から" }],
    ["持ち越しの宿題。日の頭の 0 は出さない", { status: "todo", carriedFrom: "2026-11-04" }, { status: "todo", label: "宿題11/4から" }],
    ["持ち越しの宿題。月までの日付", { status: "todo", carriedFrom: "2026-10" }, { status: "todo", label: "宿題10月から" }],
    ["持ち越しの未決。宿題と同じ形で、色は未決", { status: "open", carriedFrom: "2026-11-11" }, { status: "open", label: "未決11/11から" }],
    ["持ち越しの未決。月までの日付", { status: "open", carriedFrom: "2026-10" }, { status: "open", label: "未決10月から" }],
    ["未決（持ち越しでない）", { status: "open" }, { status: "open", label: "未決" }],
    ["持ち越し（宿題でも未決でもない）は、今までどおり", { status: "carried", carriedFrom: "2026-11-11" }, { status: "carried", label: "持ち越し 11/11" }],
    ["日付だけを書くと、持ち越し", { carriedFrom: "2026-11-11" }, { status: "carried", label: "持ち越し 11/11" }],
  ])("札の文字: %s", (_name, extra, expected) => {
    const r = parseEl(note(extra));
    if (!r.ok) throw new Error(r.error);
    expect(statusBadge(r.value)).toEqual(expected);
  });

  test.each([
    ["決定", "decided"],
    ["優先", "priority"],
  ])("%s の付箋には、持ち越しの日付を書けない", (_name, status) => {
    const r = parseEl(note({ status, carriedFrom: "2026-11-11" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("carriedFrom を書くなら、status は carried か todo か open か、書かない");
  });
});
