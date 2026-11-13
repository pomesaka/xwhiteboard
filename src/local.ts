// この Mac で動いている xwb のサーバーへつなぐ手順。CLI とチャネルが使う。
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT } from "./server/server.ts";
import { CACHE_DIR, loadToken } from "./server/token.ts";
import { isRecord } from "./shared/model.ts";

export const port = Number(process.env.XWB_PORT ?? DEFAULT_PORT);
export const base = `http://127.0.0.1:${port}`;

export class LocalError extends Error {}

export async function ping(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/ping`);
    const j: unknown = await r.json();
    return isRecord(j) && j.name === "xwb";
  } catch {
    return false;
  }
}

/** サーバーが動いていなければ、この端末から切り離して起動する */
export async function ensureServer(): Promise<void> {
  if (await ping()) return;
  mkdirSync(CACHE_DIR, { recursive: true });
  const logFile = join(CACHE_DIR, "server.log");
  const log = openSync(logFile, "a");
  const child = spawn(process.execPath, [join(import.meta.dir, "cli.ts"), "serve"], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    if (await ping()) return;
  }
  throw new LocalError(`サーバーを起動できない。ログ: ${logFile}`);
}

/** トークンを付けて API を呼ぶ。サーバーが先にトークンを作るよう、呼ぶ前に ensureServer を済ませておく */
export function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { ...init, headers: { ...init.headers, "x-xwb-token": loadToken() } });
}
