// 乱数の操作で、手で書いた例が通らない組み合わせを確かめる。種は固定で、何回走らせても同じ操作になる。
// 回数は、ふだんは数秒で終わる数。増やすときは XWB_FUZZ_SEEDS=3000 bun test test/fuzz.test.ts
// 落ちたら、出力の seed と操作を、手で書いたテスト（model.test.ts、restore.test.ts）に写してから直す。
import { expect, test } from "bun:test";
import { applyOps, boxOf, emptyDoc, isRecord, isSolid, membersOf } from "../src/shared/model.ts";
import { agentOp, bandOverlaps, board, gesture, overlaps, rng, violations } from "./random.ts";
import { send, undone, type Op } from "./screen.ts";
import { filterOf } from "../src/shared/summary.ts";

const SEEDS = Number(process.env.XWB_FUZZ_SEEDS ?? 150);
/** 回数を増やしたときに、時間切れにならないようにする */
const TIMEOUT = 5000 + SEEDS * 20;

test("エージェントの操作のまとまりを続けても、列で並べるセクションの決まりが破れない", () => {
  const broken: unknown[] = [];
  let batches = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    let doc = emptyDoc("t");
    let n = 0;
    for (let step = 0; step < 14; step++) {
      // まとまりの中の操作は、前の操作までをかけた仮のボードを見て作る
      const batch: Op[] = [];
      let view = doc;
      const size = 1 + Math.floor(r() * 4);
      for (let i = 0; i < size; i++) {
        const op = agentOp(r, view, n++);
        const t = applyOps(view, [op]);
        if (!t.ok) continue;
        view = t.value.doc;
        batch.push(op);
      }
      const res = applyOps(doc, batch);
      if (!res.ok) continue;
      const kinds = violations(doc, batch);
      if (kinds.length > 0) {
        broken.push({ seed, step, kinds, batch });
        break;
      }
      batches++;
      doc = res.value.doc;
    }
  }
  expect(broken).toEqual([]);
  expect(batches).toBeGreaterThan(SEEDS * 5);
}, TIMEOUT);

test("画面の操作は、決まりを破らず、「元に戻す」と、要素の中身も重なり順も、元に戻る", () => {
  const broken: unknown[] = [];
  let tried = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const doc = board(r);
    for (let i = 0; i < 12; i++) {
      const g = gesture(r, doc, i);
      const sent = g && g.ops.length > 0 ? send(doc, g) : null;
      if (!g || !sent) continue;
      tried++;
      const back = undone(sent.applied.doc, sent.undo);
      if (!Bun.deepEquals(back.elements, doc.elements)) broken.push({ seed, i, kind: g.kind, ops: g.ops, undo: sent.undo });
      // 画面の操作でも、決まりは破れない。自由に置くセクションどうしは重ねて置けるので、セクションの重なりだけは見ない
      const kinds = violations(doc, g.ops).filter((k) => k !== "セクションが重なる");
      if (kinds.length > 0) broken.push({ seed, i, kind: g.kind, kinds, ops: g.ops });
    }
  }
  expect(broken).toEqual([]);
  expect(tried).toBeGreaterThan(SEEDS * 5);
}, TIMEOUT);

test("画面の操作と「元に戻す」の間に、エージェントの操作を挟んでも、決まりが破れない", () => {
  const broken: unknown[] = [];
  let tried = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const doc = board(r);
    for (let i = 0; i < 12; i++) {
      const g = gesture(r, doc, i);
      const sent = g && g.ops.length > 0 ? send(doc, g) : null;
      if (!g || !sent) continue;
      // エージェントが、1〜2 個の操作を、1 つずつ送る
      let later = sent.applied.doc;
      const agent: Op[] = [];
      for (let k = 0; k < 1 + Math.floor(r() * 2); k++) {
        const op = agentOp(r, later, 100 + i * 10 + k);
        const res = applyOps(later, [op]);
        if (!res.ok) continue;
        later = res.value.doc;
        agent.push(op);
      }
      const back = undone(later, sent.undo);
      // WHY 外す: 戻す操作がセクションの場所か幅を書くときに、その場所が、エージェントの足したセクションや、伸びたセクションでふさがっていると、重なる。
      // 戻す操作は断らない（断ると、戻せるはずの残りまで戻らない）。重なった先の決まりは、扱わない。
      // 戻す操作が高さだけを戻すセクションは外さない（下を詰められていたら、押し下げて離す）
      const sites = (id: unknown, patch: unknown): boolean => isRecord(patch) && ["x", "y", "w"].some((k) => k in patch) && later.elements.find((e) => e.id === id)?.type === "container";
      const resited = sent.undo.some((u) => Array.isArray(u.set) && u.set.some((item) => isRecord(item) && sites(item.id, item.patch))) || sent.undo.some((u) => Array.isArray(u.add) && u.add.some((el) => isRecord(el) && el.type === "container"));
      const before = overlaps(later);
      if (resited && [...overlaps(back)].some((pair) => !before.has(pair))) continue;
      tried++;
      // 元と同じにはならない。確かめるのは、崩れないこと
      const kinds = violations(later, sent.undo);
      // 列で並べるセクションの中身だった要素は、戻す操作が場所を書くか消すかしていなければ、戻した後も、同じセクションの中身
      const moved = new Set(sent.undo.flatMap((u) => [...(Array.isArray(u.rm) ? u.rm : []), ...(Array.isArray(u.set) ? u.set.flatMap((item) => (isRecord(item) && isRecord(item.patch) && ("x" in item.patch || "y" in item.patch) ? [item.id] : [])) : [])]));
      for (const c of later.elements.filter((e) => e.type === "container" && e.cols !== undefined)) {
        const now = back.elements.find((e) => e.id === c.id);
        if (!now || now.cols === undefined) continue;
        const still = new Set(membersOf(back.elements, now).map((m) => m.id));
        if (membersOf(later.elements, c).some((m) => isSolid(m) && !moved.has(m.id) && !still.has(m.id))) kinds.push("中身だった要素が、セクションから外れる");
      }
      // 戻す操作が場所を書いたまとめの帯は、戻した場所で、下の要素に重ならない（その間にエージェントが行を増やしていても、押し下げる）
      const bandsSited = new Set(sent.undo.flatMap((u) => (Array.isArray(u.set) ? u.set.flatMap((item) => (isRecord(item) && isRecord(item.patch) && ("y" in item.patch || "x" in item.patch) && later.elements.find((e) => e.id === item.id)?.type === "summary" ? [item.id] : [])) : [])));
      // 見るのは、帯の上の端と同じか下から始まる要素（入っているセクションも）との重なり。
      // WHY 上から始まる要素を外す: 帯が離れている間に、エージェントが、帯の空けた場所へ、上から要素を動かしている（compact、帯を足す）ことがある。
      // セクションの場所を戻すときと同じに、戻した場所がふさがっている形は扱わない
      const was = new Set([...bandOverlaps(later), ...bandOverlaps(doc)]);
      const topOf = (id: string): number => {
        const el = back.elements.find((e) => e.id === id);
        const home = back.elements.filter((c) => c.type === "container" && el !== undefined && membersOf(back.elements, c).some((m) => m.id === id));
        return Math.min(boxOf(el ?? { id, type: "shape" })?.y ?? Infinity, ...home.map((c) => c.y ?? Infinity));
      };
      const fresh = [...bandOverlaps(back)].filter((pair) => {
        const [band, other] = pair.split("/");
        const bandY = back.elements.find((e) => e.id === band)?.y ?? 0;
        return !was.has(pair) && bandsSited.has(band ?? "") && topOf(other ?? "") >= bandY;
      });
      if (fresh.length > 0) kinds.push("戻した帯が、下の要素に重なる");
      if (kinds.length > 0) broken.push({ seed, i, kind: g.kind, kinds, ops: g.ops, agent, undo: sent.undo });
    }
  }
  expect(broken).toEqual([]);
  expect(tried).toBeGreaterThan(SEEDS * 5);
}, TIMEOUT);

test("付箋の状態を変えて、まとめの帯が伸び縮みしても、帯が、重なっていなかった要素に重ならない", () => {
  const broken: unknown[] = [];
  let tried = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    let doc = board(r);
    for (let i = 0; i < 12; i++) {
      const bands = doc.elements.filter((e) => e.type === "summary");
      const notes = doc.elements.filter((e) => e.type === "shape");
      const band = bands[Math.floor(r() * bands.length)];
      const note = notes[Math.floor(r() * notes.length)];
      if (!band || !note) break;
      // 帯が集める状態を付けるか、外す。付箋の場所と大きさは変えない
      // 帯の条件に当てはまる値を付箋に書くか、状態を外す
      const filter = filterOf(band);
      const fit = { status: filter?.status ?? "decided", carriedFrom: null, ...(filter?.who === undefined ? {} : { who: filter.who }), ...(filter?.tag === undefined ? {} : { tag: filter.tag }) };
      const op: Op = { op: "set", id: note.id, patch: r() < 0.6 ? fit : { status: null, carriedFrom: null } };
      const res = applyOps(doc, [op]);
      if (!res.ok) continue;
      tried++;
      const before = bandOverlaps(doc);
      const fresh = [...bandOverlaps(res.value.doc)].filter((pair) => !before.has(pair));
      const kinds = violations(doc, [op]);
      if (fresh.length > 0 || kinds.length > 0) {
        broken.push({ seed, i, op, fresh, kinds });
        break;
      }
      doc = res.value.doc;
    }
  }
  expect(broken).toEqual([]);
  expect(tried).toBeGreaterThan(SEEDS * 3);
}, TIMEOUT);
