import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMENT_IMAGE_RE, type Res } from "../shared/model.ts";
import { CACHE_DIR } from "./token.ts";

/**
 * コメントに貼った画像の置き場。
 * WHY ボードのフォルダに置かない: 会議のボードはリポジトリに入る。共有画面のスクショ（取引先の画面）をリポジトリに入れないため。
 * 代わりに、ほかのマシンでボードを開くと画像は見えない
 */
export const COMMENT_IMAGE_DIR = join(CACHE_DIR, "images");

/** 貼れる画像の大きさの上限（バイト） */
export const MAX_COMMENT_IMAGE_BYTES = 10 * 1024 * 1024;

const EXT_OF: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const COMMENT_IMAGE_MIME: Record<string, string> = Object.fromEntries(Object.entries(EXT_OF).map(([mime, ext]) => [ext, mime]));

/** 画像の名前（中身の sha256 と拡張子）を決める。種類が違うか、空か、大きすぎれば、理由を返す。ファイルには触らない */
export function commentImageName(bytes: Uint8Array, mime: string): Res<string> {
  const ext = EXT_OF[mime.split(";")[0]?.trim().toLowerCase() ?? ""];
  if (!ext) return { ok: false, error: "貼れる画像は png・jpeg・gif・webp だけ" };
  if (bytes.length === 0) return { ok: false, error: "画像が空" };
  if (bytes.length > MAX_COMMENT_IMAGE_BYTES) return { ok: false, error: `画像が大きすぎる（${MAX_COMMENT_IMAGE_BYTES / 1024 / 1024}MB まで）` };
  return { ok: true, value: `${createHash("sha256").update(bytes).digest("hex")}.${ext}` };
}

/** 名前の形が合っていれば、置き場 dir の中の絶対パスを返す。合わなければ null（ほかの場所のファイルを指させない） */
export function commentImagePath(dir: string, name: string): string | null {
  return COMMENT_IMAGE_RE.test(name) ? join(dir, name) : null;
}

/** 画像を置き場 dir に保存して、名前を返す。同じ中身なら同じ名前で、書き直さない */
export function saveCommentImage(dir: string, bytes: Uint8Array, mime: string): Res<string> {
  const name = commentImageName(bytes, mime);
  if (!name.ok) return name;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name.value);
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 });
  return name;
}
