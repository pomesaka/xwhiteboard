// image 要素の svg を、画面に出す形に直す。
// 既定は「マーカー」の見た目（線はペンで描いたように揺らし、塗りはマーカーで塗ったようにかすれさせる）。
// <svg> に data-look="clean" があれば、書かれたとおりに描く（設計図、地図、アイコンなど、正確さが要るもの）。
//
// 安全について: 直した SVG は <img> の data URL として出す。<img> の中の SVG は、スクリプトを実行せず、外部の
// ファイルも読まない（ブラウザの決まり）。マーカーの見た目では、そのうえで使える要素と属性を絞って組み直す。

// WHY 変数でなく値: <img> の中の SVG には、ページの CSS の変数が届かない
import { INK } from "../shared/colors.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

const SHAPES = ["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"];
const ELEMENTS = new Set(["svg", "g", ...SHAPES]);
const ATTRS = new Set([
  "viewBox", "width", "height", "data-look",
  "d", "points", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "transform",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-opacity", "opacity",
]);

const cache = new Map<string, string>();

function toDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** マーカーの見た目に使えない要素と属性を捨てる（文字、スタイル、参照、イベントの属性など） */
function strip(node: Element): void {
  for (const child of [...node.children]) {
    if (!ELEMENTS.has(child.localName)) child.remove();
    else strip(child);
  }
  for (const attr of [...node.attributes]) {
    // url(…) は、SVG の中の別の部品（フィルターや模様）を指す書き方。こちらで足すフィルターと混ざるので受け付けない
    if (!ATTRS.has(attr.name) || attr.value.includes("url(")) node.removeAttribute(attr.name);
  }
}

/** 線だけの部品にはペンの揺れを、塗っただけの部品にはマーカーのかすれを当てる。fill と stroke は、親の g から引き継ぐ */
function mark(node: Element, fill: string, stroke: string): void {
  const f = node.getAttribute("fill") ?? fill;
  const s = node.getAttribute("stroke") ?? stroke;
  if (node.localName === "g" || node.localName === "svg") {
    for (const child of [...node.children]) mark(child, f, s);
    return;
  }
  if (s !== "none") {
    node.setAttribute("stroke-linecap", "round");
    node.setAttribute("stroke-linejoin", "round");
    node.setAttribute("filter", "url(#xwb-pen)");
    return;
  }
  if (f !== "none") {
    node.setAttribute("filter", "url(#xwb-marker)");
    if (!node.hasAttribute("fill-opacity")) node.setAttribute("fill-opacity", "0.82");
  }
}

function addFilters(root: Element, box: number[], size: number): void {
  const doc = root.ownerDocument;
  const make = (name: string, attrs: Record<string, string>, children: Element[] = []): Element => {
    const n = doc.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    n.append(...children);
    return n;
  };
  // 揺れの細かさと幅は、絵の大きさ（viewBox）に合わせる。数字のまま固定すると、小さい絵は崩れ、大きい絵は揺れが見えない
  const freq = String(5 / size);
  // WHY フィルターの範囲を絵の全体（viewBox）で決める: 部品ごとの大きさを基準にすると、
  // 水平や垂直のまっすぐな線は高さか幅が 0 なので、範囲が無くなって線ごと消える（Chrome で確認）
  const [x = 0, y = 0, w = size, h = size] = box.length === 4 && box.every(Number.isFinite) ? box : [0, 0, size, size];
  const region = { x: String(x - w * 0.1), y: String(y - h * 0.1), width: String(w * 1.2), height: String(h * 1.2), filterUnits: "userSpaceOnUse" };
  const wobble = (id: string, scale: number, extra: Element[]): Element =>
    make("filter", { id, ...region }, [
      make("feTurbulence", { type: "fractalNoise", baseFrequency: freq, numOctaves: "2", seed: "4", result: "noise" }),
      make("feDisplacementMap", { in: "SourceGraphic", in2: "noise", scale: String(size * scale), xChannelSelector: "R", yChannelSelector: "G", result: "moved" }),
      ...extra,
    ]);
  const streaks = [
    // 横に長い雑音を不透明度にして、筆のかすれを作る
    make("feTurbulence", { type: "fractalNoise", baseFrequency: `${0.6 / size} ${30 / size}`, numOctaves: "1", seed: "9", result: "grain" }),
    make("feColorMatrix", { in: "grain", type: "matrix", values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.3 0 0 0 1.5", result: "alpha" }),
    make("feComposite", { in: "moved", in2: "alpha", operator: "in" }),
  ];
  root.prepend(make("defs", {}, [wobble("xwb-pen", 0.012, []), wobble("xwb-marker", 0.018, streaks)]));
}

/** image 要素の svg の文字列を、<img> の src に入れる URL にする */
export function svgSrc(svg: string): string {
  const hit = cache.get(svg);
  if (hit !== undefined) return hit;
  let out = toDataUrl(svg);
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  // 読めない SVG は、書かれたまま <img> に渡す（何も出ないだけで、害は無い）
  if (root.localName === "svg" && !doc.querySelector("parsererror")) {
    // currentColor は、ボードの文字の色にする。<img> の中の SVG には、ページの文字の色が伝わらない
    if (!root.hasAttribute("color")) root.setAttribute("color", INK);
    if (root.getAttribute("data-look") !== "clean") {
      strip(root);
      root.setAttribute("color", INK);
      const box = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
      const size = Math.max(box[2] ?? 0, box[3] ?? 0) || 200;
      mark(root, "black", "none");
      addFilters(root, box, size);
    }
    out = toDataUrl(new XMLSerializer().serializeToString(root));
  }
  cache.set(svg, out);
  return out;
}
