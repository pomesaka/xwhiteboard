import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundsOf, type Doc, type Res } from "../shared/model.ts";
import { withSummaryHeights } from "../shared/summary.ts";

const BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

/** 書き出しの画面で、ボードの周りに空ける余白（CSS px）。ブラウザ側の fit と同じ値 */
export const SHOT_MARGIN = 48;
// WHY 16000: Chrome はテクスチャの上限（16384px）を超えるスクショを撮れないため、倍率を下げて収める
const MAX_SIDE = 16000;

function findBrowser(): string | null {
  const env = process.env.XWB_CHROME;
  if (env) return existsSync(env) ? env : null;
  return BROWSERS.find((p) => existsSync(p)) ?? null;
}

/**
 * ボード全体を PNG に書き出す。ブラウザと同じ画面をヘッドレスの Chrome で開いて撮る。
 * WHY: 描画を 2 つ持つと、画面で見たものと保存した絵がずれる。
 */
export async function shoot(pageUrl: string, doc: Doc, out: string, scale: number, comments: boolean): Promise<Res<{ out: string; width: number; height: number }>> {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: "Chrome が見つからない。XWB_CHROME に Chrome か Chromium の実行ファイルのパスを入れる" };
  // まとめの帯の高さは、集めた行の数で決まる。窓の大きさを決める前に入れる
  const b = boundsOf(withSummaryHeights(doc.elements), comments);
  if (!b) return { ok: false, error: "要素が無いので書き出せない" };
  const w = Math.max(400, Math.ceil(b.w + SHOT_MARGIN * 2));
  const h = Math.max(300, Math.ceil(b.h + SHOT_MARGIN * 2));
  const k = Math.min(scale, MAX_SIDE / w, MAX_SIDE / h);
  const profile = mkdtempSync(join(tmpdir(), "xwb-chrome-"));
  try {
    const proc = Bun.spawn(
      [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        `--force-device-scale-factor=${k}`,
        `--window-size=${w},${h}`,
        "--virtual-time-budget=4000",
        `--screenshot=${out}`,
        pageUrl,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), 30000);
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0 || !existsSync(out)) {
      const err = await new Response(proc.stderr).text();
      return { ok: false, error: `Chrome での書き出しに失敗した（終了コード ${code}）: ${err.slice(-400)}` };
    }
    return { ok: true, value: { out, width: Math.round(w * k), height: Math.round(h * k) } };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
