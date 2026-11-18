#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runChannel } from "./channel.ts";
import { convertLegacy, readLegacy } from "./convert.ts";
import { api, ensureServer, ping, port } from "./local.ts";
import { BOARD_EXT, DEFAULT_PORT, startServer } from "./server/server.ts";
import { loadToken } from "./server/token.ts";
import { boxOf, isRecord, parseEl, serialize } from "./shared/model.ts";
import { itemsOf, summarize, withSummaryHeights } from "./shared/summary.ts";

const USAGE = `xwb: ローカルで動くホワイトボード

  xwb open <board> [--title 題名] [--no-open]   ボードを開く（無ければ作る）。URL を返す
  xwb add <board> [json|-] [--in セクションの id | --above 要素の id]
                                                要素を足す（1 つか配列）。足した要素を返す
  xwb set <board> <id> <json>                   要素の項目を変える（null で項目を消す）
  xwb rm <board> <id>...                        要素を消す
  xwb apply <board> [json|-]                    add・set・rm・title をまとめて 1 回で行う
  xwb title <board> <題名>                      題名を変える
  xwb ls <board>                                要素の一覧（文字と表は見積もった w・h 付き。まとめの帯は h と items 付き）
  xwb summary <board>                           付箋の状態ごとの一覧（決定・未決・宿題・持ち越し・優先）
  xwb claim <board> <json>                      書き込み中の範囲を枠で示す（{x,y,w,h,label,ttl}）
  xwb unclaim <board> [id]                      枠を消す
  xwb focus <board> [セクションの id]            話している議題のセクションを残して、ほかを薄くする（id 無しでやめる）
  xwb check <board>                             見た目の問題（重なり、はみ出し、矢印の突き抜けなど）の一覧
  xwb template <board> [json|-]                 型（matrix・versus・tree）を、中身のデータから描く
  xwb compact <board> [--fit]                   空いた段を上へ詰める（--fit で、セクションも中身の高さまで低くする）
  xwb order <board> <id> front|back           要素を前面か背面へ動かす
  xwb changes <board> [--clear]                人がブラウザで変えた要素の一覧（--clear で、一覧を返して消す）
  xwb reply <board> <コメントの id> <本文>       コメントに返事を書く
  xwb resolve <board> <コメントの id> [--reopen] コメントを解決済みにする（--reopen で未解決に戻す）
  xwb shot <board> [-o 出力.png] [--scale 2] [--comments]
                                                ボード全体を PNG に書き出す（--comments でコメントも出す）
  xwb convert <前の形.board.js> [-o 出力] [--force]  前の形のボードを変換する
  xwb channel [--root フォルダ]                  Claude Code のチャネルとして動く（.mcp.json から起動される）
  xwb channels                                  つながっているチャネルの一覧
  xwb serve                                     サーバーを前面で動かす
  xwb stop                                      サーバーを止める

<board> は ${BOARD_EXT} で終わるファイル。サーバーは、動いていなければ自動で起動する。
ポートは環境変数 XWB_PORT（既定 ${DEFAULT_PORT}）。書き方は docs/agent-guide.md。`;

class CliError extends Error {}

function parseArgs(argv: string[]): { pos: string[]; flags: Map<string, string> } {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  const bool = new Set(["--no-open", "--force", "--help", "--comments", "--reopen", "--clear", "--fit"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-o") flags.set("--out", argv[++i] ?? "");
    else if (bool.has(a)) flags.set(a, "true");
    else if (a.startsWith("--")) flags.set(a, argv[++i] ?? "");
    else pos.push(a);
  }
  return { pos, flags };
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  await ensureServer();
  const r = await api(path, init);
  const j: unknown = await r.json();
  if (!r.ok) throw new CliError(isRecord(j) && typeof j.error === "string" ? j.error : `HTTP ${r.status}`);
  return j;
}

const call = (path: string, payload: Record<string, unknown>): Promise<unknown> =>
  request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

function boardArg(v: string | undefined): string {
  if (!v) throw new CliError("ボードのファイルを指定する");
  if (!v.endsWith(BOARD_EXT)) throw new CliError(`ボードのファイルは ${BOARD_EXT} で終わる名前にする: ${v}`);
  return resolve(v);
}

async function jsonArg(v: string | undefined): Promise<unknown> {
  const text = v === undefined || v === "-" ? await Bun.stdin.text() : v;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`JSON として読めない: ${String(e)}`);
  }
}

const print = (v: unknown): void => console.log(JSON.stringify(v, null, 2));

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (!cmd || cmd === "help" || cmd === "--help" || flags.has("--help")) {
    console.log(USAGE);
    return;
  }
  switch (cmd) {
    case "serve":
      await startServer(port);
      return;
    case "stop":
      if (await ping()) await api("/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return;
    case "channel":
      // Claude Code が .mcp.json から起動する。届け先にするボードの範囲は、既定ではセッションの作業フォルダ
      await runChannel(resolve(flags.get("--root") ?? process.cwd()));
      return;
    case "channels":
      print(await request("/api/channels", {}));
      return;
    case "open": {
      const res = await call("/api/open", { board: boardArg(pos[0]), ...(flags.has("--title") ? { title: flags.get("--title") } : {}) });
      // 画面が API を呼ぶためのトークンを、# の後ろに付けて渡す（# の後ろはサーバーにも Referer にも送られない）
      const opened = isRecord(res) && typeof res.url === "string" ? { ...res, url: `${res.url}#k=${loadToken()}` } : res;
      print(opened);
      if (!flags.has("--no-open") && isRecord(opened) && typeof opened.url === "string") Bun.spawn(["open", opened.url]);
      return;
    }
    case "add": {
      const input = await jsonArg(pos[1]);
      const into = flags.get("--in");
      const above = flags.get("--above");
      const ops = (Array.isArray(input) ? input : [input]).map((el) => ({ op: "add", el, ...(into === undefined ? {} : { in: into }), ...(above === undefined ? {} : { above }) }));
      const res = await call("/api/ops", { board: boardArg(pos[0]), ops });
      print(isRecord(res) ? res.added : res);
      return;
    }
    case "set": {
      if (!pos[1]) throw new CliError("id を指定する");
      const res = await call("/api/ops", { board: boardArg(pos[0]), ops: [{ op: "set", id: pos[1], patch: await jsonArg(pos[2]) }] });
      print(isRecord(res) ? res.updated : res);
      return;
    }
    case "rm": {
      if (pos.length < 2) throw new CliError("id を指定する");
      const res = await call("/api/ops", { board: boardArg(pos[0]), ops: pos.slice(1).map((id) => ({ op: "rm", id })) });
      print(isRecord(res) && Array.isArray(res.removed) ? res.removed.map((e) => (isRecord(e) ? e.id : e)) : res);
      return;
    }
    case "apply": {
      const res = await call("/api/ops", { board: boardArg(pos[0]), ops: await jsonArg(pos[1]) });
      // 押し下げで何十もの要素が動くことがあるので、足した要素だけ全体を返し、ほかは id だけにする（読む側の文脈を埋めないため）
      const ids = (v: unknown): unknown[] => (Array.isArray(v) ? v.map((e) => (isRecord(e) ? e.id : e)) : []);
      print(isRecord(res) ? { added: res.added, updated: ids(res.updated), removed: ids(res.removed) } : res);
      return;
    }
    case "title":
      await call("/api/ops", { board: boardArg(pos[0]), ops: [{ op: "title", title: pos[1] ?? "" }] });
      return;
    case "ls": {
      const j = await request(`/api/board?board=${encodeURIComponent(boardArg(pos[0]))}`, {});
      if (!isRecord(j)) throw new CliError("ボードを読めない");
      // 描画できない CLI でも重なりを判断できるよう、文字と表には見積もった大きさを足して返す。
      // まとめの帯には、今の行の数からの高さ（h）と、集めた付箋の id（items）を足す
      const raws: unknown[] = Array.isArray(j.elements) ? j.elements : [];
      const parsed = raws.flatMap((raw) => {
        const el = parseEl(raw);
        return el.ok ? [el.value] : [];
      });
      const summary = summarize(parsed);
      const sized = new Map(withSummaryHeights(parsed).map((el) => [el.id, el]));
      const elements = raws.map((raw: unknown) => {
        const el = isRecord(raw) && typeof raw.id === "string" ? sized.get(raw.id) : undefined;
        const box = el ? boxOf(el) : null;
        if (!isRecord(raw) || !el || !box) return raw;
        if (el.type === "summary") return { ...raw, w: box.w, h: box.h, items: itemsOf(summary, el).map((i) => i.id) };
        return el.type === "text" || el.type === "table" ? { ...raw, w: box.w, h: box.h } : raw;
      });
      print({ title: j.title, elements });
      return;
    }
    case "template": {
      // 型（matrix・versus・tree）を、セクション・付箋・矢印に展開して足す
      const data = await jsonArg(pos[1]);
      // オブジェクトでなければ、サーバーが理由を付けて断る（kind が無い）
      const res = await call("/api/ops", { board: boardArg(pos[0]), ops: [{ ...(isRecord(data) ? data : {}), op: "template" }] });
      print(isRecord(res) && Array.isArray(res.added) ? { added: res.added.map((e) => (isRecord(e) ? e.id : e)) } : res);
      return;
    }
    case "compact": {
      const res = await call("/api/ops", { board: boardArg(pos[0]), ops: [{ op: "compact", fit: flags.has("--fit") }] });
      // 動いた要素は多いので、id だけを返す
      print(isRecord(res) && Array.isArray(res.updated) ? { moved: res.updated.map((e) => (isRecord(e) ? e.id : e)) } : res);
      return;
    }
    case "summary": {
      // 付箋の状態ごとの一覧。まとめの帯の要素がボードに無くても使える
      const res = await request(`/api/summary?board=${encodeURIComponent(boardArg(pos[0]))}`, {});
      print(res);
      return;
    }
    case "check": {
      const res = await request(`/api/check?board=${encodeURIComponent(boardArg(pos[0]))}`, {});
      print(isRecord(res) ? res.issues : res);
      return;
    }
    case "order": {
      if (!pos[1] || !pos[2]) throw new CliError("要素の id と、front か back を指定する");
      await call("/api/ops", { board: boardArg(pos[0]), ops: [{ op: "order", id: pos[1], to: pos[2] }] });
      return;
    }
    case "changes": {
      const board = boardArg(pos[0]);
      const res = flags.has("--clear") ? await call("/api/changes/clear", { board }) : await request(`/api/changes?board=${encodeURIComponent(board)}`, {});
      print(isRecord(res) ? res.changes : res);
      return;
    }
    case "reply": {
      if (!pos[1] || !pos[2]) throw new CliError("コメントの id と本文を指定する");
      const res = await call("/api/ops", { board: boardArg(pos[0]), ops: [{ op: "say", id: pos[1], text: pos[2] }] });
      print(isRecord(res) ? res.updated : res);
      return;
    }
    case "resolve": {
      if (!pos[1]) throw new CliError("コメントの id を指定する");
      await call("/api/ops", { board: boardArg(pos[0]), ops: [{ op: "set", id: pos[1], patch: { resolved: flags.has("--reopen") ? null : true } }] });
      return;
    }
    case "claim": {
      const input = await jsonArg(pos[1]);
      if (!isRecord(input)) throw new CliError("{x, y, w, h, label} の形で書く");
      print(await call("/api/claim", { ...input, board: boardArg(pos[0]) }));
      return;
    }
    case "focus":
      // セクションの id を書けば注目し、書かなければやめる
      print(await call("/api/focus", { board: boardArg(pos[0]), ...(pos[1] ? { id: pos[1] } : {}) }));
      return;
    case "unclaim":
      await call("/api/unclaim", { board: boardArg(pos[0]), ...(pos[1] ? { id: pos[1] } : {}) });
      return;
    case "shot": {
      const out = flags.get("--out");
      const scale = flags.get("--scale");
      print(await call("/api/shot", { board: boardArg(pos[0]), ...(out ? { out: resolve(out) } : {}), ...(scale ? { scale: Number(scale) } : {}), comments: flags.has("--comments") }));
      return;
    }
    case "convert": {
      const src = pos[0];
      if (!src || !existsSync(src)) throw new CliError(`前の形のボードが無い: ${src ?? ""}`);
      const out = resolve(flags.get("--out") ?? src.replace(/\.board\.js$/, "") + BOARD_EXT);
      if (!out.endsWith(BOARD_EXT)) throw new CliError(`出力は ${BOARD_EXT} で終わる名前にする`);
      if (existsSync(out) && !flags.has("--force")) throw new CliError(`もうある: ${out}（上書きするなら --force）`);
      const legacy = readLegacy(readFileSync(src, "utf8"));
      if (!legacy.ok) throw new CliError(legacy.error);
      const doc = convertLegacy(legacy.value);
      if (!doc.ok) throw new CliError(doc.error);
      writeFileSync(out, serialize(doc.value));
      print({ board: out, elements: doc.value.elements.length });
      return;
    }
    default:
      throw new CliError(`知らないコマンド: ${cmd}\n\n${USAGE}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof CliError ? `xwb: ${e.message}` : e);
  process.exit(1);
});
