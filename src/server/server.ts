import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { COMMENT_IMAGE_DIR, COMMENT_IMAGE_MIME, commentImagePath, saveCommentImage } from "./comment-images.ts";
import { applyOps, checkCommentImages, commentPayload, emptyDoc, isRecord, isSafeSrc, localDay, parseDoc, pendingChanges, serialize, trackHuman, type Applied, type Doc, type El, type Res } from "../shared/model.ts";
import { checkBoard } from "../shared/check.ts";
import { bandsOf, summarize } from "../shared/summary.ts";
import { resolveBoardRef } from "../shared/rich.ts";
import { shoot } from "./shot.ts";
import { loadToken, sameToken } from "./token.ts";

export const DEFAULT_PORT = 4747;
export const BOARD_EXT = ".board.json";

interface Claim {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  expires: number;
}

interface Client {
  id: string;
  send: (event: string, data: unknown) => void;
}

interface Board {
  path: string;
  doc: Doc;
  mtime: number;
  clients: Set<Client>;
  claims: Map<string, Claim>;
  /** いま話している議題のセクションの id。画面は、そのセクションと中身を残して、ほかを薄くする。
   * WHY ファイルに書かない: 会議の進行に合わせた一時の表示で、ボードの中身ではない（書き込み中の枠と同じ扱い） */
  focus: string | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Claude Code のセッションが起動したチャネル（xwb channel）。「Claude に送る」の届け先 */
interface Channel {
  /** このフォルダより下にあるボードの知らせを受け取る。セッションの作業フォルダ */
  root: string;
  pid: number;
  /** セッションがチャネルを聞く旗つきで起動されているか。旗が無いセッションは、届いた知らせを黙って捨てる */
  listening: boolean;
  send: (event: string, data: unknown) => void;
}

const boards = new Map<string, Board>();
const channels = new Set<Channel>();
let claimSeq = 0;

function channelsFor(path: string): Channel[] {
  return [...channels].filter((c) => c.listening && path.startsWith(`${c.root}/`));
}

function sse(signal: AbortSignal, open: (send: (event: string, data: unknown) => void) => () => void): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = open((event, data) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)));
      const beat = setInterval(() => controller.enqueue(enc.encode(": beat\n\n")), 20000);
      signal.addEventListener("abort", () => {
        clearInterval(beat);
        close();
        try {
          controller.close();
        } catch {
          // 相手が先に切っていれば、閉じる必要が無い
        }
      });
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function boardPath(raw: unknown): string {
  if (typeof raw !== "string" || !isAbsolute(raw) || !raw.endsWith(BOARD_EXT)) {
    throw new HttpError(400, `board は ${BOARD_EXT} で終わる絶対パスで指定する`);
  }
  return resolve(raw);
}

function readDoc(path: string): { doc: Doc; mtime: number } {
  const r = parseDoc(readFileSync(path, "utf8"));
  if (!r.ok) throw new HttpError(422, `${path}: ${r.error}`);
  return { doc: r.value, mtime: statSync(path).mtimeMs };
}

function writeDoc(board: Board): void {
  // WHY 一時ファイルと rename: 書いている途中で止まっても、会議の記録が半分のファイルにならないようにする
  const tmp = `${board.path}.tmp`;
  writeFileSync(tmp, serialize(board.doc));
  renameSync(tmp, board.path);
  board.mtime = statSync(board.path).mtimeMs;
}

function snapshot(board: Board): unknown {
  return {
    path: board.path,
    title: board.doc.title,
    elements: board.doc.elements,
    claims: [...board.claims.values()],
    focus: board.focus,
  };
}

/** その場所の時刻を、時差つきの ISO 8601 で返す（議事録の時刻と見比べやすいように、UTC にしない） */
function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const two = (n: number): string => String(n).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${two(Math.floor(Math.abs(off) / 60))}:${two(Math.abs(off) % 60)}`;
}

function broadcast(board: Board, event: string, data: unknown): void {
  for (const c of board.clients) c.send(event, data);
}

/** サーバーの外でファイルが書き換わっていたら（jj の操作、手での編集）読み直す */
function refresh(board: Board): void {
  if (!existsSync(board.path)) return;
  if (statSync(board.path).mtimeMs === board.mtime) return;
  const { doc, mtime } = readDoc(board.path);
  board.doc = doc;
  board.mtime = mtime;
  broadcast(board, "snapshot", snapshot(board));
}

function getBoard(path: string): Board {
  const known = boards.get(path);
  if (known) {
    refresh(known);
    return known;
  }
  if (!existsSync(path)) throw new HttpError(404, `ボードが無い: ${path}（xwb open で作る）`);
  const board: Board = { path, ...readDoc(path), clients: new Set(), claims: new Map(), focus: null };
  boards.set(path, board);
  return board;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "本文が JSON として読めない");
  }
  if (!isRecord(raw)) throw new HttpError(400, "本文は JSON のオブジェクトで書く");
  return raw;
}

function unwrap<T>(r: Res<T>, status = 422): T {
  if (!r.ok) throw new HttpError(status, r.error);
  return r.value;
}

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${name} は数値`);
  return v;
}

function events(board: Board, clientId: string, signal: AbortSignal): Response {
  return sse(signal, (send) => {
    const client: Client = { id: clientId, send };
    board.clients.add(client);
    send("snapshot", snapshot(board));
    return () => board.clients.delete(client);
  });
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * Tailwind を通さずに、そのまま画面へ渡す CSS（テーマの値と、ボードの中身の描き方）。
 * WHY 通さない: Tailwind は、変数を含む color-mix() に古いブラウザ向けの代わりの値を足して、元の式を @supports の中へ移す。
 * 1 つの規則に color-mix() の宣言がいくつもあるテーマでは、元の式が最初の 1 つしか残らず、ほかは混ぜる前の色になった
 * （tailwindcss 4.3.5 + bun-plugin-tailwind 0.1.2 で確認。--header-border が --header-foreground と同じ色になる）。
 * どちらも utility を使わない素の CSS なので、通す必要が無い。
 */
const RAW_CSS = ["ui-design/themes/xwb.css", "xwb-theme.css", "board.css"];

export async function startServer(port: number): Promise<void> {
  const clientDir = join(import.meta.dir, "../client");
  const built = await Bun.build({ entrypoints: [join(clientDir, "main.ts")], target: "browser" });
  const script = built.outputs[0];
  if (!built.success || !script) throw new Error(`画面のスクリプトを組み立てられない: ${built.logs.join("\n")}`);
  const appJs = await script.text();
  // 操作の部品の CSS は、app.css を入口に Tailwind が作る（使っている utility だけが出る）
  const styled = await Bun.build({ entrypoints: [join(clientDir, "app.css")], plugins: [tailwind] });
  const sheet = styled.outputs[0];
  if (!styled.success || !sheet) throw new Error(`画面の CSS を組み立てられない: ${styled.logs.join("\n")}`);
  const raw = await Promise.all(RAW_CSS.map((name) => Bun.file(join(clientDir, name)).text()));
  const appCss = [await sheet.text(), ...raw].join("\n");
  const origin = `http://127.0.0.1:${port}`;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  const pageUrl = (path: string, extra = ""): string => `${origin}/?board=${encodeURIComponent(path)}${extra}`;

  const token = loadToken();

  const takeShot = async (board: Board, out: string, scale: number, comments = false): Promise<{ out: string; width: number; height: number }> =>
    unwrap(await shoot(`${pageUrl(board.path, `&export=1${comments ? "&comments=1" : ""}`)}#k=${token}`, board.doc, out, scale, comments), 500);

  /** 操作を適用して、ファイルに書き、開いている画面に流す */
  const commitOps = (board: Board, ops: unknown, client: string): Applied => {
    // client を名乗るのはブラウザの画面だけ。CLI と HTTP の書き込み（エージェント）は名乗らないので、人の変更として記録しない
    const human = client !== "";
    const applied = unwrap(applyOps(board.doc, ops, { by: human ? "human" : "claude", at: localIso(new Date()) }));
    board.doc = human ? { ...applied.doc, pending: trackHuman(board.doc, applied) } : applied.doc;
    writeDoc(board);
    const upserts: El[] = [...applied.added, ...applied.updated];
    broadcast(board, "ops", {
      client,
      upserts,
      removed: applied.removed.map((e) => e.id),
      ...(applied.titleChanged ? { title: board.doc.title } : {}),
      ...(applied.order ? { order: applied.order } : {}),
    });
    // 注目しているセクションが消えたら、注目をやめる（ほかが薄いまま残らないように）
    if (board.focus !== null && applied.removed.some((e) => e.id === board.focus)) {
      board.focus = null;
      broadcast(board, "focus", { id: null });
    }
    return applied;
  };

  const handle = async (req: Request, url: URL): Promise<Response> => {
    const q = url.searchParams;
    switch (`${req.method} ${url.pathname}`) {
      case "GET /":
        return new Response(Bun.file(join(clientDir, "index.html")));
      case "GET /app.css":
        return new Response(appCss, { headers: { "content-type": "text/css; charset=utf-8" } });
      case "GET /app.js":
        return new Response(appJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      case "GET /api/ping":
        return json({ name: "xwb", pid: process.pid });
      case "GET /api/board":
        return json(snapshot(getBoard(boardPath(q.get("board")))));
      case "GET /api/events":
        return events(getBoard(boardPath(q.get("board"))), q.get("client") ?? "", req.signal);
      case "GET /api/asset": {
        const path = boardPath(q.get("board"));
        const src = q.get("src") ?? "";
        if (!isSafeSrc(src) || src.startsWith("data:")) throw new HttpError(400, "src が使えない");
        const file = join(dirname(path), src);
        if (!existsSync(file)) throw new HttpError(404, `画像が無い: ${src}`);
        const ext = src.slice(src.lastIndexOf(".") + 1).toLowerCase();
        return new Response(Bun.file(file), { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
      }
      case "GET /api/shot": {
        const board = getBoard(boardPath(q.get("board")));
        const dir = mkdtempSync(join(tmpdir(), "xwb-shot-"));
        try {
          const shot = await takeShot(board, join(dir, "board.png"), 2);
          return new Response(readFileSync(shot.out), { headers: { "content-type": "image/png" } });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      case "POST /api/open": {
        const b = await body(req);
        const path = boardPath(b.board);
        let created = false;
        if (!existsSync(path)) {
          if (!existsSync(dirname(path))) throw new HttpError(404, `フォルダが無い: ${dirname(path)}`);
          writeFileSync(path, serialize(emptyDoc(typeof b.title === "string" ? b.title : "")));
          created = true;
        }
        const board = getBoard(path);
        return json({ board: path, url: pageUrl(path), created, title: board.doc.title, elements: board.doc.elements.length });
      }
      case "POST /api/ops": {
        const b = await body(req);
        const board = getBoard(boardPath(b.board));
        const applied = commitOps(board, b.ops, typeof b.client === "string" ? b.client : "");
        return json({ added: applied.added, updated: applied.updated, removed: applied.removed, ...(applied.order ? { order: applied.order } : {}) });
      }
      case "POST /api/ops/dry": {
        // 操作を適用した結果だけを返す。ボードは書き換えず、画面にも流さない（xwb format --dry-run）。
        // WHY /api/ops と同じ applyOps を通す: 別の計算にすると、試した結果と、実際に動く要素が食い違う
        const b = await body(req);
        const applied = unwrap(applyOps(getBoard(boardPath(b.board)).doc, b.ops));
        return json({ added: applied.added, updated: applied.updated, removed: applied.removed, ...(applied.order ? { order: applied.order } : {}) });
      }
      case "POST /api/comment/image": {
        // コメントの入力欄に貼った画像を受け取る。本文は画像のバイト列そのもの
        const saved = saveCommentImage(COMMENT_IMAGE_DIR, new Uint8Array(await req.arrayBuffer()), req.headers.get("content-type") ?? "");
        if (!saved.ok) throw new HttpError(400, saved.error);
        return json({ name: saved.value });
      }
      case "GET /api/comment/image": {
        const name = q.get("name") ?? "";
        const path = commentImagePath(COMMENT_IMAGE_DIR, name);
        if (path === null) throw new HttpError(400, "画像の名前の形が違う");
        if (!existsSync(path)) throw new HttpError(404, `画像が無い: ${name}`);
        return new Response(Bun.file(path), { headers: { "content-type": COMMENT_IMAGE_MIME[name.slice(name.lastIndexOf(".") + 1)] ?? "application/octet-stream" } });
      }
      case "POST /api/comment/send": {
        // 人がコメントに書いて「送る」を押した。本文は先にコメントへ足して残し、その後で Claude に届ける。
        // 届け先が無くても本文は消えず、unsent の印が付く。本文なしで呼ぶと、残っているものを送り直す
        const b = await body(req);
        const board = getBoard(boardPath(b.board));
        const id = typeof b.id === "string" ? b.id : "";
        const client = typeof b.client === "string" ? b.client : "browser";
        const text = typeof b.text === "string" ? b.text.trim() : "";
        // 名前の形は checkCommentImages で確かめた（ボードの中の名前も parseEl が同じ関数で確かめている）ので、置き場に join してよい。
        // WHY 積む前に確かめる: 先に積むと、無い画像を指すやりとりが残る
        const images = b.images === undefined ? [] : unwrap(checkCommentImages(b.images), 400);
        const missing = images.find((n) => !existsSync(join(COMMENT_IMAGE_DIR, n)));
        if (missing !== undefined) throw new HttpError(400, `画像が無い: ${missing}。貼り直す`);
        const say = text === "" && images.length === 0 ? [] : [{ op: "say", id, text, ...(images.length > 0 ? { images } : {}) }];
        commitOps(board, [...say, { op: "set", id, patch: { unsent: true } }], client);
        const payload = unwrap(commentPayload(board.doc, id, (name) => join(COMMENT_IMAGE_DIR, name)));
        const targets = channelsFor(board.path);
        if (targets.length === 0) throw new HttpError(409, "Claude につながっていません");
        const line = { at: localIso(new Date()), ...payload };
        for (const c of targets) c.send("feedback", { board: board.path, title: board.doc.title, meta: { kind: "comment", comment: id }, line });
        commitOps(board, [{ op: "set", id, patch: { unsent: null } }], client);
        return json({ sessions: targets.length });
      }
      case "GET /api/summary":
      {
        // 状態ごとの一覧（前からの形。議事録のセッションが使っている）に、ボードにある帯ごとの一覧（bands）を足して返す
        const els = getBoard(boardPath(q.get("board"))).doc.elements;
        return json({ ...summarize(els), bands: bandsOf(els) });
      }
      case "GET /api/check": {
        const board = getBoard(boardPath(q.get("board")));
        // style=1 で、書き方の提案も返す（xwb check --style）
        return json({ issues: checkBoard(board.doc, { boardExists: (ref) => existsSync(resolveBoardRef(board.path, ref)), today: localDay(new Date()), style: q.get("style") === "1" }) });
      }
      case "GET /api/changes":
        // 人がブラウザで変えて、まだ読み終えたことにしていない要素。読むだけでは消さない（議事録を書き直すときに読み直せるように）
        return json({ changes: pendingChanges(getBoard(boardPath(q.get("board"))).doc) });
      case "POST /api/changes/clear": {
        // 読み終えた変更を消す。消したものを返すので、読んでから消すまでの間に人が足した変更も取りこぼさない
        const b = await body(req);
        const board = getBoard(boardPath(b.board));
        const changes = pendingChanges(board.doc);
        board.doc = { ...board.doc, pending: {} };
        writeDoc(board);
        return json({ changes });
      }
      case "GET /api/channel": {
        const root = resolve(q.get("root") ?? "");
        const channel: Channel = { root, pid: Number(q.get("pid") ?? 0), listening: q.get("listening") === "1", send: () => undefined };
        return sse(req.signal, (send) => {
          channel.send = send;
          channels.add(channel);
          return () => channels.delete(channel);
        });
      }
      case "GET /api/channels":
        return json([...channels].map((c) => ({ root: c.root, pid: c.pid, listening: c.listening })));
      case "POST /api/claim": {
        const b = await body(req);
        const board = getBoard(boardPath(b.board));
        const id = typeof b.id === "string" ? b.id : `c${++claimSeq}`;
        const ttl = b.ttl === undefined ? 60 : num(b.ttl, "ttl");
        board.claims.set(id, {
          id,
          x: num(b.x, "x"),
          y: num(b.y, "y"),
          w: num(b.w, "w"),
          h: num(b.h, "h"),
          label: typeof b.label === "string" ? b.label : "",
          expires: Date.now() + ttl * 1000,
        });
        broadcast(board, "claims", [...board.claims.values()]);
        return json({ id });
      }
      case "POST /api/focus": {
        const b = await body(req);
        const board = getBoard(boardPath(b.board));
        // id を書かなければ、注目をやめる
        if (b.id !== undefined && b.id !== null) {
          const el = board.doc.elements.find((e) => e.id === b.id);
          if (!el) throw new HttpError(422, `id ${JSON.stringify(b.id)} の要素が無い`);
          if (el.type !== "container") throw new HttpError(422, `注目できるのはセクションだけ。${el.id} は ${el.type}`);
          board.focus = el.id;
        } else {
          board.focus = null;
        }
        broadcast(board, "focus", { id: board.focus });
        return json({ focus: board.focus });
      }
      case "POST /api/unclaim": {
        const b = await body(req);
        const board = getBoard(boardPath(b.board));
        if (typeof b.id === "string") board.claims.delete(b.id);
        else board.claims.clear();
        broadcast(board, "claims", [...board.claims.values()]);
        return json({ ok: true });
      }
      case "POST /api/shot": {
        const b = await body(req);
        const board = getBoard(boardPath(b.board));
        const out = typeof b.out === "string" && isAbsolute(b.out) ? b.out : `${board.path.slice(0, -BOARD_EXT.length)}.board.png`;
        return json(await takeShot(board, out, b.scale === undefined ? 2 : num(b.scale, "scale"), b.comments === true));
      }
      case "POST /api/stop":
        setTimeout(() => process.exit(0), 50);
        return json({ ok: true });
      default:
        throw new HttpError(404, `無い: ${req.method} ${url.pathname}`);
    }
  };

  Bun.serve({
    hostname: "127.0.0.1",
    port,
    // WHY 0: SSE は書き込みが無い間も開いたままにする。Bun の既定（10 秒）だと切られる
    idleTimeout: 0,
    async fetch(req) {
      // WHY Host と Origin を見る: ほかのサイトのページが、ブラウザ越しにこのサーバーへ書き込めないようにする
      // （ファイルのパスを受け取って書き換える API なので、127.0.0.1 に bind するだけでは足りない）
      const host = req.headers.get("host") ?? "";
      const from = req.headers.get("origin");
      if (!hosts.includes(host) || (from !== null && !hosts.includes(from.replace(/^http:\/\//, "")))) {
        return json({ error: "この接続元からは使えない" }, 403);
      }
      const url = new URL(req.url);
      // 画面のファイルと ping には秘密が無いので、トークン無しで返す。ボードを読み書きする API は全部トークンを求める。
      // WHY 読む側にも求める: ボードには社外の会議の中身が入る
      // WHY クエリの k も受ける: EventSource と <img> は、ヘッダーを付けられない
      if (url.pathname.startsWith("/api/") && url.pathname !== "/api/ping") {
        const given = req.headers.get("x-xwb-token") ?? url.searchParams.get("k") ?? "";
        if (!sameToken(given, token)) return json({ error: "トークンが合わない。xwb open で開き直す" }, 401);
      }
      try {
        return await handle(req, url);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error(e);
        return json({ error: String(e) }, 500);
      }
    },
  });

  setInterval(() => {
    const now = Date.now();
    for (const board of boards.values()) {
      let expired = false;
      for (const c of board.claims.values()) {
        if (c.expires <= now) {
          board.claims.delete(c.id);
          expired = true;
        }
      }
      if (expired) broadcast(board, "claims", [...board.claims.values()]);
      if (board.clients.size > 0) {
        try {
          refresh(board);
        } catch (e) {
          console.error(e);
        }
      }
    }
  }, 2000);

  console.log(`xwb: ${origin} で待ち受け中（pid ${process.pid}）`);
}
