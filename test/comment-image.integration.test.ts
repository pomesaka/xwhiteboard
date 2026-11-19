// コメントの画像の API を、サーバーを別のプロセスで立てて確かめる。
// HOME を一時フォルダにして、本物の ~/.cache/xwb（トークンと画像）に触らない
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const home = mkdtempSync(join(tmpdir(), "xwb-home-"));
const boards = join(home, "boards");
const images = join(home, ".cache", "xwb", "images");
const board = join(boards, "x.board.json");
// WHY 決まったポートを使わない: 4747（会議で開いている画面）や、ほかの確かめのサーバーとぶつからないように
const port = 20000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Subprocess | null = null;
let token = "";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function call(path: string, init: RequestInit = {}, withToken = true): Promise<Response> {
  return fetch(`${origin}${path}`, { ...init, headers: { ...init.headers, ...(withToken ? { "x-xwb-token": token } : {}) } });
}

function post(path: string, body: unknown): Promise<Response> {
  return call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function upload(bytes: Uint8Array, type = "image/png"): Promise<Response> {
  return call("/api/comment/image", { method: "POST", headers: { "content-type": type }, body: new Blob([new Uint8Array(bytes)]) });
}

async function nameOf(bytes: Uint8Array): Promise<string> {
  const j: unknown = await (await upload(bytes)).json();
  if (typeof j !== "object" || j === null || !("name" in j) || typeof j.name !== "string") throw new Error("名前が返らない");
  return j.name;
}

async function thread(id: string): Promise<unknown[]> {
  const j: unknown = await (await call(`/api/board?board=${encodeURIComponent(board)}`)).json();
  if (typeof j !== "object" || j === null || !("elements" in j) || !Array.isArray(j.elements)) throw new Error("ボードが読めない");
  const el: unknown = j.elements.find((e: unknown) => typeof e === "object" && e !== null && "id" in e && e.id === id);
  return typeof el === "object" && el !== null && "thread" in el && Array.isArray(el.thread) ? el.thread : [];
}

let seq = 0;
async function newComment(): Promise<string> {
  const id = `c${++seq}`;
  const r = await post("/api/ops", { board, ops: [{ op: "add", el: { id, type: "comment", x: 0, y: seq * 100 } }] });
  if (!r.ok) throw new Error(await r.text());
  return id;
}

/** チャネルとしてつなぎ、届いた最初の知らせの line を返す。send を呼んでから待つ */
async function listen(run: () => Promise<Response>): Promise<{ status: number; line: Record<string, unknown> | null }> {
  const abort = new AbortController();
  // WHY 応答を待たずに先へ進む: SSE の応答の頭は、最初の知らせが流れるまで返らない。チャネルが登録されるのを一覧で待つ
  const opened = call(`/api/channel?root=${encodeURIComponent(boards)}&pid=1&listening=1`, { signal: abort.signal });
  for (let i = 0; i < 50; i++) {
    const list: unknown = await (await call("/api/channels")).json();
    if (Array.isArray(list) && list.length > 0) break;
    await Bun.sleep(20);
  }
  const sent = await run();
  if (!sent.ok) {
    abort.abort();
    await opened.catch(() => undefined);
    return { status: sent.status, line: null };
  }
  const reader = (await opened).body?.getReader();
  if (!reader) throw new Error("チャネルにつながらない");
  let buf = "";
  let line: Record<string, unknown> | null = null;
  while (line === null) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const m = buf.match(/event: feedback\ndata: (.*)\n\n/);
    if (m?.[1]) {
      const data: unknown = JSON.parse(m[1]);
      if (typeof data === "object" && data !== null && "line" in data && typeof data.line === "object" && data.line !== null) line = { ...data.line };
    }
  }
  abort.abort();
  // 次のテストの send が、切れたチャネルに届かないように、一覧から消えるのを待つ
  for (let i = 0; i < 50; i++) {
    const list: unknown = await (await call("/api/channels")).json();
    if (Array.isArray(list) && list.length === 0) break;
    await Bun.sleep(20);
  }
  return { status: sent.status, line };
}

beforeAll(async () => {
  mkdirSync(boards);
  server = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "serve"], { env: { ...process.env, HOME: home, XWB_PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${origin}/api/ping`).then((r) => r.ok).catch(() => false);
    if (up) break;
    await Bun.sleep(100);
  }
  token = readFileSync(join(home, ".cache", "xwb", "token"), "utf8").trim();
  const r = await post("/api/open", { board, title: "確かめ" });
  if (!r.ok) throw new Error(await r.text());
});

afterAll(() => {
  server?.kill();
  rmSync(home, { recursive: true, force: true });
});

describe("画像を貼る", () => {
  test("保存して名前を返し、その名前で同じバイト列が返る。同じ中身なら同じ名前で、ボードのフォルダには何も書かない", async () => {
    const before = readdirSync(boards);
    const first = await nameOf(PNG);
    const second = await nameOf(PNG);
    const got = await call(`/api/comment/image?name=${first}`);
    expect([second, got.status, got.headers.get("content-type"), new Uint8Array(await got.arrayBuffer()), existsSync(join(images, first)), readdirSync(boards)]).toEqual([
      first,
      200,
      "image/png",
      PNG,
      true,
      before,
    ]);
  });

  test.each([
    ["受け付けない種類", PNG, "text/plain"],
    ["上限を超える大きさ", new Uint8Array(10 * 1024 * 1024 + 1), "image/png"],
  ])("貼れない画像は 400 で、ファイルを書かない: %s", async (_name, bytes, type) => {
    const before = existsSync(images) ? readdirSync(images) : [];
    const r = await upload(bytes, type);
    expect([r.status, existsSync(images) ? readdirSync(images) : []]).toEqual([400, before]);
  });

  test.each([
    ["上のフォルダ", "../token", 400],
    ["URL で符号にした上のフォルダ", "%2e%2e%2ftoken", 400],
    ["形は合うが無い", `${"0".repeat(64)}.png`, 404],
  ])("取り出せない名前: %s", async (_name, name, status) => {
    expect((await call(`/api/comment/image?name=${name}`)).status).toBe(status);
  });

  test("トークンが要る。取り出しは、クエリの k でも通る（<img> はヘッダーを付けられない）", async () => {
    const name = await nameOf(PNG);
    const statuses = [
      (await call("/api/comment/image", { method: "POST", headers: { "content-type": "image/png" }, body: new Blob([PNG]) }, false)).status,
      (await call(`/api/comment/image?name=${name}`, {}, false)).status,
      (await call(`/api/comment/image?name=${name}&k=${token}`, {}, false)).status,
    ];
    expect(statuses).toEqual([401, 401, 200]);
  });
});

describe("画像を付けて送る", () => {
  test("やりとりには名前で積まれ、Claude には絶対パスで届く", async () => {
    const id = await newComment();
    const name = await nameOf(PNG);
    const { status, line } = await listen(() => post("/api/comment/send", { board, id, text: "これ", images: [name], client: "t" }));
    expect([status, line?.text, line?.images]).toEqual([200, "これ", [join(images, name)]]);
    expect((await thread(id)).map((m) => (typeof m === "object" && m !== null && "images" in m ? m.images : null))).toEqual([[name]]);
  });

  test("画像だけで送れる", async () => {
    const id = await newComment();
    const name = await nameOf(PNG);
    const { status, line } = await listen(() => post("/api/comment/send", { board, id, text: "", images: [name], client: "t" }));
    expect([status, line?.text, line?.images]).toEqual([200, "", [join(images, name)]]);
  });

  test.each([
    ["名前の形が違う", ["x.png"]],
    ["形は合うが、貼っていない", [`${"1".repeat(64)}.png`]],
  ])("送れない画像は 400 で、やりとりを積まない: %s", async (_name, names) => {
    const id = await newComment();
    const r = await post("/api/comment/send", { board, id, text: "これ", images: names, client: "t" });
    expect([r.status, (await thread(id)).length]).toEqual([400, 0]);
  });

  test("届け先が無くて残ったやりとりは、本文も画像も無しで送り直せる", async () => {
    const id = await newComment();
    const name = await nameOf(PNG);
    const first = await post("/api/comment/send", { board, id, text: "前の", images: [name], client: "t" });
    const { status, line } = await listen(() => post("/api/comment/send", { board, id, client: "t" }));
    expect([first.status, status, line?.text, line?.images, (await thread(id)).length]).toEqual([409, 200, "前の", [join(images, name)], 1]);
  });
});
