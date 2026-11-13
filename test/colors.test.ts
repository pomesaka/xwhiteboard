import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILL, HIGHLIGHT, INK, PAPER, TABLE_CELL, TABLE_HEAD } from "../src/shared/colors.ts";

// 画面の色（CSS の変数）と、検査が使う色の写し（shared/colors.ts）が同じ値であること。
// 片方だけ変えると、検査が画面と違う色で近さを測る。

const client = join(import.meta.dir, "../src/client");
const css = ["ui-design/themes/xwb.css", "xwb-theme.css"].map((name) => readFileSync(join(client, name), "utf8")).join("\n");
const declared = new Map([...css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));

/** 変数の値。ほかの変数を指していたら、たどる */
function cssValue(name: string): string {
  const value = declared.get(name) ?? "";
  const ref = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return ref ? cssValue(ref) : value;
}

test.each([
  ...Object.entries(FILL).map(([color, hex]) => [`--note-${color}`, hex]),
  ...Object.entries(HIGHLIGHT).map(([color, hex]) => [`--highlight-${color}`, hex]),
  ["--background", PAPER],
  ["--board-surface", TABLE_CELL],
  ["--board-head", TABLE_HEAD],
  ["--foreground", INK],
])("%s は、検査が使う色の写しと同じ値", (name, hex) => {
  expect(cssValue(name)).toBe(hex);
});
