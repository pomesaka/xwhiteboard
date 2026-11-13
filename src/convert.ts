// 前の形のボード（window.BOARD = { topics, items, figures }）を、新しいボードへ変換する。
import { LABEL_FONT } from "./shared/route.ts";
import { applyOps, boxOf, emptyDoc, isRecord, membersOf, textWidth, GAP, OUTER_GAP, PAD, TITLE_H, type Color, type Doc, type Res } from "./shared/model.ts";

const KINDS: Record<string, { color: Color; tag: string }> = {
  point: { color: "yellow", tag: "論点" },
  decision: { color: "green", tag: "決定" },
  todo: { color: "blue", tag: "宿題" },
  open: { color: "orange", tag: "未決" },
  research: { color: "purple", tag: "調べた" },
  fact: { color: "gray", tag: "事実" },
};

const NOTE_W = 220;
const NOTE_H = 110;
const INNER_W = NOTE_W * 2 + GAP;
const SECTION_W = INNER_W + PAD * 2;
const PER_ROW = 3;
const STEP_H = 64;
const FLOW_GAP = 44;
const FLOW_MIN_W = 110;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/** 前の形のファイルは JSON ではなく JS なので、window を渡して実行して取り出す。読むのは利用者自身の議事録のファイルだけ */
export function readLegacy(source: string): Res<Record<string, unknown>> {
  const win: { BOARD?: unknown } = {};
  try {
    new Function("window", source)(win);
  } catch (e) {
    return { ok: false, error: `前の形のボードとして実行できない: ${String(e)}` };
  }
  if (!isRecord(win.BOARD)) return { ok: false, error: "window.BOARD が無い" };
  return { ok: true, value: win.BOARD };
}

export function convertLegacy(board: Record<string, unknown>): Res<Doc> {
  let doc = emptyDoc(str(board.title));
  const run = (ops: unknown[]): string | null => {
    const r = applyOps(doc, ops);
    if (!r.ok) return r.error;
    doc = r.value.doc;
    return null;
  };

  const head: unknown[] = [{ op: "add", el: { id: "title", type: "text", x: 0, y: 0, size: "xl", text: str(board.title) } }];
  const when = [str(board.date), str(board.time)].filter((s) => s !== "").join(" ");
  if (when !== "") head.push({ op: "add", el: { id: "when", type: "text", x: 0, y: 64, size: "m", color: "gray", text: when } });
  if (str(board.takeaway) !== "") {
    head.push({ op: "add", el: { id: "takeaway", type: "shape", shape: "round", color: "yellow", x: 0, y: 104, w: SECTION_W, h: 64, text: str(board.takeaway) } });
  }
  const err = run(head);
  if (err) return { ok: false, error: err };

  const topics = list(board.topics);
  let y = 104 + 64 + OUTER_GAP;
  for (let start = 0; start < topics.length; start += PER_ROW) {
    const row = topics.slice(start, start + PER_ROW);
    const ids: string[] = [];
    for (const [col, topic] of row.entries()) {
      const tid = str(topic.id) || `t${start + col + 1}`;
      ids.push(tid);
      const ops: unknown[] = [{ op: "add", el: { id: tid, type: "container", x: col * (SECTION_W + OUTER_GAP), y, w: SECTION_W, title: str(topic.title) } }];
      for (const item of list(topic.items)) {
        const kind = KINDS[str(item.kind)] ?? { color: "yellow", tag: "" };
        const due = str(item.due);
        const tag = [kind.tag, str(item.owner) || str(item.who), due === "" ? "" : `〜${due}`].filter((s) => s !== "").join(" · ");
        const wide = item.wide === true;
        ops.push({
          op: "add",
          in: tid,
          el: { ...(str(item.id) === "" ? {} : { id: str(item.id) }), type: "shape", color: kind.color, tag, text: str(item.text), w: wide ? INNER_W : NOTE_W, h: wide ? 84 : NOTE_H },
        });
      }
      for (const [fi, fig] of list(topic.figures).entries()) {
        const fid = `${tid}-f${fi + 1}`;
        if (str(fig.caption) !== "") ops.push({ op: "add", in: tid, el: { type: "text", size: "s", color: "gray", text: str(fig.caption), w: INNER_W } });
        switch (str(fig.type)) {
          case "flow": {
            const steps = list(fig.steps);
            // 自動配置の間隔（GAP）では矢印のラベルが入らないので、流れの箱だけは座標を決めて置く。
            // そのために、ここまでの中身を先に置いて、空いている高さを調べる
            const e = run(ops.splice(0));
            if (e) return { ok: false, error: `${tid}: ${e}` };
            const section = doc.elements.find((x) => x.id === tid);
            const sb = section ? boxOf(section) : null;
            if (!section || !sb) return { ok: false, error: `${tid}: セクションが無い` };
            const bottoms = membersOf(doc.elements, section).map((m) => {
              const b = boxOf(m);
              return b ? b.y + b.h + GAP : 0;
            });
            const top = Math.max(sb.y + TITLE_H, ...bottoms);
            // 箱の間は、いちばん長いラベルが両側の箱にかからない幅にする
            const labels = steps.slice(0, -1).map((s) => textWidth(str(s.next), LABEL_FONT) + 24);
            const gap = Math.max(FLOW_GAP, ...labels);
            const n = Math.max(1, steps.length);
            const across = Math.floor((INNER_W - gap * (n - 1)) / n);
            // 横に並べると箱が細くなりすぎる（か、セクションからはみ出す）ときは、上から下へ並べる
            const horizontal = across >= FLOW_MIN_W;
            const w = horizontal ? across : INNER_W;
            // WHY 箱より先にセクションを広げる: 後から広げると、先に置いた箱が「セクションの下にあるもの」として押し下げられる
            const bottom = top + STEP_H + (horizontal ? 0 : (n - 1) * (STEP_H + FLOW_GAP));
            ops.push({ op: "set", id: tid, patch: { h: Math.max(sb.h, bottom + PAD - sb.y) } });
            for (const [si, step] of steps.entries()) {
              const sub = str(step.sub);
              ops.push({
                op: "add",
                el: {
                  id: `${fid}-s${si + 1}`,
                  type: "shape",
                  shape: "rect",
                  color: step.bad === true ? "red" : "white",
                  x: sb.x + PAD + (horizontal ? si * (w + gap) : 0),
                  y: top + (horizontal ? 0 : si * (STEP_H + FLOW_GAP)),
                  w,
                  h: STEP_H,
                  text: sub === "" ? str(step.label) : `${str(step.label)}\n${sub}`,
                },
              });
            }
            for (let si = 0; si + 1 < steps.length; si++) {
              const label = str(steps[si]?.next);
              ops.push({ op: "add", el: { type: "arrow", from: `${fid}-s${si + 1}`, to: `${fid}-s${si + 2}`, ...(label === "" ? {} : { label }) } });
            }
            break;
          }
          case "table":
            ops.push({ op: "add", in: tid, el: { id: fid, type: "table", w: INNER_W, head: strings(fig.head), rows: (Array.isArray(fig.rows) ? fig.rows : []).map(strings) } });
            break;
          case "svg":
            ops.push({ op: "add", in: tid, el: { id: fid, type: "image", w: INNER_W, h: 260, svg: str(fig.svg) } });
            break;
        }
      }
      const e = run(ops);
      if (e) return { ok: false, error: `${tid}: ${e}` };
    }
    // 次の段は、この段でいちばん背の高いセクションの下から始める
    const bottoms = ids.map((id) => {
      const el = doc.elements.find((x) => x.id === id);
      const b = el ? boxOf(el) : null;
      return b ? b.y + b.h : y;
    });
    y = Math.max(y, ...bottoms) + OUTER_GAP;
  }
  return { ok: true, value: doc };
}
