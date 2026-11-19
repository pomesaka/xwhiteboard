import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_COMMENT_IMAGE_BYTES, commentImageName, commentImagePath, saveCommentImage } from "../src/server/comment-images.ts";

const abc = new TextEncoder().encode("abc");
/** "abc" の sha256 */
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("画像の名前は、中身の sha256 と、種類から決まる拡張子", () => {
  test.each([
    ["png", "image/png", `${ABC}.png`],
    ["jpeg", "image/jpeg", `${ABC}.jpg`],
    ["gif", "image/gif", `${ABC}.gif`],
    ["webp", "image/webp", `${ABC}.webp`],
    ["大文字と付け足しのある種類", "image/PNG; charset=binary", `${ABC}.png`],
  ])("%s", (_name, mime, name) => {
    expect(commentImageName(abc, mime)).toEqual({ ok: true, value: name });
  });
});

describe("貼れない画像を断る", () => {
  test.each([
    ["svg", abc, "image/svg+xml", "png・jpeg・gif・webp"],
    ["文字", abc, "text/plain", "png・jpeg・gif・webp"],
    ["種類が無い", abc, "", "png・jpeg・gif・webp"],
    ["空", new Uint8Array(0), "image/png", "空"],
    ["上限を 1 バイト超える", new Uint8Array(MAX_COMMENT_IMAGE_BYTES + 1), "image/png", "大きすぎる"],
  ])("%s", (_name, bytes, mime, message) => {
    const r = commentImageName(bytes, mime);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  test("上限ちょうどは受け付ける", () => {
    expect(commentImageName(new Uint8Array(MAX_COMMENT_IMAGE_BYTES), "image/png").ok).toBe(true);
  });
});

describe("置き場のパスは、形に合う名前だけ", () => {
  test.each([
    ["形に合う名前", `${ABC}.png`, `/d/${ABC}.png`],
    ["上のフォルダ", "../token", null],
    ["置き場の外を指す名前", `../${ABC}.png`, null],
    ["拡張子が違う", `${ABC}.svg`, null],
  ])("%s", (_name, name, path) => {
    expect(commentImagePath("/d", name)).toBe(path);
  });
});

describe("保存", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "xwb-images-test-")), "images");
  afterAll(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

  test("置き場を作り、本人だけが読める形で書く。同じ中身なら同じ名前", () => {
    const first = saveCommentImage(dir, abc, "image/png");
    const second = saveCommentImage(dir, abc, "image/png");
    expect([first, second]).toEqual([
      { ok: true, value: `${ABC}.png` },
      { ok: true, value: `${ABC}.png` },
    ]);
    const file = join(dir, `${ABC}.png`);
    expect([readFileSync(file, "utf8"), statSync(dir).mode & 0o777, statSync(file).mode & 0o777]).toEqual(["abc", 0o700, 0o600]);
  });

  test("断った画像は書かない", () => {
    expect(saveCommentImage(dir, abc, "text/plain").ok).toBe(false);
    expect(existsSync(join(dir, `${ABC}.txt`))).toBe(false);
  });
});
