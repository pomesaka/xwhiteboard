// 色の値。見た目の検査（check.ts）が、色どうしの近さを測るのに使う。
// 画面の色は CSS（client/style.css の .c-* の --bg と、.hl-* の --hl）が決めている。ここは、その写し。
// CSS の色を変えたら、ここも同じ値に直す。
import type { Color } from "./model.ts";
import type { MarkColor } from "./rich.ts";

/** 図形の面の色（.c-* の --bg） */
export const FILL: Record<Color, string> = {
  yellow: "#fff1a8",
  orange: "#ffd9b0",
  red: "#ffc9c4",
  pink: "#ffd0e4",
  purple: "#e2d6ff",
  blue: "#cfe3ff",
  teal: "#c5efe9",
  green: "#d3f0c8",
  gray: "#e9e6df",
  white: "#ffffff",
  ink: "#2b2a28",
};

/** 蛍光ペンの帯の色（.hl-* の --hl）。帯は不透明なので、どの地の上でも、この色のまま出る */
export const HIGHLIGHT: Record<MarkColor, string> = {
  yellow: "#ffee58",
  green: "#a8efb4",
  blue: "#a9d6ff",
  pink: "#ffb3d4",
  orange: "#ffc680",
};


/** ボードの地の色（--paper）と、表の地の色 */
export const PAPER = "#f6f3ec";
export const TABLE_CELL = "#ffffff";
export const TABLE_HEAD = "#ece8de";

function lab(hex: string): [number, number, number] {
  const channel = (i: number): number => {
    const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [channel(0), channel(1), channel(2)];
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** 2 つの色の、見た目の差（CIE76 の ΔE）。0 が同じ色で、大きいほど違って見える */
export function colorDistance(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
