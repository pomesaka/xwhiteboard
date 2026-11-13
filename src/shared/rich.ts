// 付箋・図形・文字・表のセルの文字の装飾。Markdown の一部だけを読む。
// 読むのは、太字（**…**）、斜体（*…*）、取り消し線（~~…~~）、蛍光ペン（==…==）、コード（`…`）、リンク（[文字](https://…)）、
// 行頭の「- 」「1. 」の箇条書き。
// 入れ子は読まない。HTML は読まず、書かれた文字のまま出す。

/** 蛍光ペンの色。書かなければ yellow */
export const MARK_COLORS = ["yellow", "green", "blue", "pink", "orange"] as const;
export type MarkColor = (typeof MARK_COLORS)[number];

export type Inline =
  | { kind: "text" | "bold" | "italic" | "strike" | "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "mark"; text: string; color: MarkColor };

/** 段落（行の並び）か、箇条書き */
export interface Block {
  kind: "lines" | "bullets" | "numbers";
  lines: Inline[][];
}

// WHY リンクは http と https だけ: javascript: などの URL を、押せるリンクとして出さないため
// WHY 太字と斜体の中身は空白で始まらず、空白で終わらない: 「5 * 3 と 2 * 4」のような掛け算の記号を、斜体にしないため
// 蛍光ペンは ==…== で、色を選ぶなら =={pink}…==。中身は、太字と同じく空白で始まらず、空白で終わらない。
// 中身が { で始まるものも蛍光ペンにしない（=={red}…== のように知らない色を書いたとき、書いたままの文字で出して気づけるようにする）
const INLINE = /`([^`\n]+)`|\*\*([^*\s](?:[^*\n]*[^*\s])?)\*\*|\*([^*\s](?:[^*\n]*[^*\s])?)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|==(?:\{(yellow|green|blue|pink|orange)\})?([^=\s{](?:[^=\n]*[^=\s])?)==|~~([^~\s](?:[^~\n]*[^~\s])?)~~/g;

function markColor(name: string | undefined): MarkColor {
  return MARK_COLORS.find((c) => c === name) ?? "yellow";
}
const BULLET = /^- (.*)$/;
const NUMBER = /^\d+\. (.*)$/;

export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    if (m.index > last) out.push({ kind: "text", text: line.slice(last, m.index) });
    const [, code, bold, italic, label, href, color, marked, struck] = m;
    if (code !== undefined) out.push({ kind: "code", text: code });
    else if (bold !== undefined) out.push({ kind: "bold", text: bold });
    else if (italic !== undefined) out.push({ kind: "italic", text: italic });
    else if (label !== undefined && href !== undefined) out.push({ kind: "link", text: label, href });
    else if (marked !== undefined) out.push({ kind: "mark", text: marked, color: markColor(color) });
    else if (struck !== undefined) out.push({ kind: "strike", text: struck });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ kind: "text", text: line.slice(last) });
  return out;
}

export function parseRich(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    const bullet = BULLET.exec(line);
    const number = NUMBER.exec(line);
    const kind = bullet ? "bullets" : number ? "numbers" : "lines";
    const body = bullet?.[1] ?? number?.[1] ?? line;
    const prev = blocks[blocks.length - 1];
    if (prev && prev.kind === kind) prev.lines.push(parseInline(body));
    else blocks.push({ kind, lines: [parseInline(body)] });
  }
  return blocks;
}

export type MarkupKind = "bold" | "italic" | "strike" | MarkColor;

interface Marker {
  open: string;
  close: string;
  /** 選んだ範囲のすぐ前にある開く記号と、すぐ後ろにある閉じる記号を見つける式 */
  before: RegExp;
  after: RegExp;
  /** 選んだ範囲そのものが、記号ごと囲まれているかを見る式。1 つめの括弧が開く記号、2 つめが中身 */
  whole: RegExp;
}

function markerOf(kind: MarkupKind): Marker {
  switch (kind) {
    case "bold":
      return { open: "**", close: "**", before: /\*\*$/, after: /^\*\*/, whole: /^(\*\*)([\s\S]*)\*\*$/ };
    case "italic":
      // 太字の ** を、斜体の * と取り違えない
      return { open: "*", close: "*", before: /(?<!\*)\*$/, after: /^\*(?!\*)/, whole: /^(\*)(?!\*)([\s\S]*)(?<!\*)\*$/ };
    case "strike":
      return { open: "~~", close: "~~", before: /~~$/, after: /^~~/, whole: /^(~~)([\s\S]*)~~$/ };
    default:
      return { open: kind === "yellow" ? "==" : `=={${kind}}`, close: "==", before: /==(?:\{[a-z]+\})?$/, after: /^==/, whole: /^(==(?:\{[a-z]+\})?)([\s\S]*)==$/ };
  }
}

/**
 * 編集中の文字の、選んだ範囲（start から end）に、装飾の記号を付けるか外す。
 * 付いていなければ記号で挟み、同じ装飾が付いていれば外す。蛍光ペンは、違う色が付いていれば色を替える。
 * 返すのは、直した文字と、直した後に選んでおく範囲（記号を除いた中身）。
 */
export function toggleMarkup(text: string, start: number, end: number, kind: MarkupKind): { text: string; start: number; end: number } {
  const m = markerOf(kind);
  const head = text.slice(0, start);
  const sel = text.slice(start, end);
  const tail = text.slice(end);
  /** 選んだ範囲に、その装飾の記号がもう付いていれば、記号を除いた前・開く記号・中身・後ろに分ける */
  const find = (k: Marker): { prefix: string; opening: string; inner: string; suffix: string } | null => {
    // 記号ごと選んでいる
    const whole = k.whole.exec(sel);
    if (whole) return { prefix: head, opening: whole[1] ?? "", inner: whole[2] ?? "", suffix: tail };
    // 記号のすぐ内側を選んでいる
    const opened = k.before.exec(head);
    if (opened && k.after.test(tail)) return { prefix: head.slice(0, opened.index), opening: opened[0], inner: sel, suffix: tail.replace(k.after, "") };
    return null;
  };
  const put = (prefix: string, opening: string, inner: string, suffix: string): { text: string; start: number; end: number } => {
    const at = prefix.length + opening.length;
    return { text: prefix + opening + inner + (opening === "" ? "" : m.close) + suffix, start: at, end: at + inner.length };
  };
  // 同じ装飾が付いていれば外す。蛍光ペンで色が違えば、色だけ替える
  const same = find(m);
  if (same) return put(same.prefix, same.opening === m.open ? "" : m.open, same.inner, same.suffix);
  // 別の装飾が付いていれば、それを外してから付ける。WHY: 装飾は入れ子にできない（重ねて書くと、内側の記号がそのまま文字で出る）
  const others: MarkupKind[] = ["bold", "italic", "strike", "yellow"];
  for (const other of others) {
    const found = find(markerOf(other));
    if (found) return put(found.prefix, m.open, found.inner, found.suffix);
  }
  return put(head, m.open, sel, tail);
}

/** 装飾の記号を除いた、画面に出る文字。大きさの見積もりに使う。箇条書きの行頭は、印のぶんの 2 文字を残す */
export function plainText(text: string): string {
  return parseRich(text)
    .flatMap((b) => b.lines.map((line) => (b.kind === "lines" ? "" : "・ ") + line.map((i) => i.text).join("")))
    .join("\n");
}
