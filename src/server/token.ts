import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CACHE_DIR = join(homedir(), ".cache", "xwb");
const TOKEN_FILE = join(CACHE_DIR, "token");

/**
 * API を呼ぶのに要る秘密のトークン。無ければ作る。
 * サーバー、CLI、チャネルが同じファイルを読む。ブラウザには、xwb open が URL の # の後ろに付けて渡す。
 * WHY ファイル（本人だけが読める）: この Mac の同じ利用者のプロセスだけが書き込めるようにする。
 * ほかのサイトのページと、ほかの利用者のプロセスは、このファイルを読めない。
 * WHY 起動のたびに作り直さない: サーバーを起動し直しても、開いたままの画面が使えるようにする。
 */
export function loadToken(): string {
  if (existsSync(TOKEN_FILE)) {
    const saved = readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved.length >= 32) return saved;
  }
  const token = randomBytes(24).toString("hex");
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

export function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
