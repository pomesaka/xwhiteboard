# 画面の色・文字・余白の決め方

xwbの画面は、[ui-design](https://github.com/pomesaka/ui-design)のtokenとテーマ、Tailwind CSS v4で書く。ui-designの部品（React）は使わない。画面は素のTypeScriptでDOMを組み立てている。

## 利用者と目的

会議の最中に、人とエージェントが同じボードへ書き込む。人は中身（付箋・図・表・ガント）を読むのが主で、操作の部品は中身の邪魔をしないことが要る。

## ファイルの役割

| ファイル | 役割 | Tailwindを通すか |
|---|---|---|
| `src/client/ui-design/tailwind/tokens.css` | 共通契約とTailwindの対応表。ui-designの複製で、書き換えない | 通す |
| `src/client/ui-design/themes/xwb.css` | xwbのテーマ。共通契約の全tokenの値 | 通さない |
| `src/client/xwb-theme.css` | xwbが足す役割。ボードの中身の色と文字の大きさ | 通さない |
| `src/client/app.css` | 操作の部品。土台と、帯・ボタン・選択・色の丸のutility | 通す |
| `src/client/board.css` | ボードの中身の描き方。値は名前で参照する | 通さない |

サーバーが起動時に`app.css`をTailwindで組み立て、通さない3つをそのまま後ろへつなぐ。通さない理由は`src/server/server.ts`の`RAW_CSS`に書いてある。

操作の部品はutilityで書き、ボードの中身は`board.css`の決まりで書く。中身の見た目はデータで決まるclassの組み合わせ（色・形・状態）と疑似要素でできていて、utilityの並びにすると読めなくなるため。

## テーマ

ui-designの`themes/template.css`から作った。移行前の見た目を変えないことを優先して、基本の色は移行前の値をそのまま役割へ割り当てた。

| 役割 | 値 | 使う場所 |
|---|---|---|
| `background` | `#f6f3ec` | ボードの地（紙） |
| `foreground` / `primary` | `#2b2a28` | 文字、矢印、送るボタン |
| `header` 系 | 墨色の面に紙色の文字 | 題名・表示の操作・道具・選択バー |
| `header-accent` | 紙色の面に墨色の文字 | 選んでいる道具、効いている切り替え |
| `card` | `#ffffff` | コメントの欄 |
| `selected-border` / `ring` / `info` | `#2f6fed` | 選択の枠、フォーカスの輪、エージェントの書き込みの知らせ |
| `destructive` | `#b3261e` | 失敗の知らせ、送れていないコメント |
| `muted-foreground` | 文字74% + 紙26% | 控えめな文字。テンプレートの66%では控えめな面の上で4.18:1になるので上げた |

付箋の色（11色の面・縁・文字）、蛍光ペン（5色）、ガント、コメントの印の色は、共通契約に入れず`xwb-theme.css`に置いた。書く人が意味を持たせて選ぶ、このプロダクトの色だからだ。

付箋の面と蛍光ペンの値は`src/shared/colors.ts`にも写しがある。見た目の検査が、画面を描かずに色の近さを測るのに使う。2つがずれると`test/colors.test.ts`が落ちる。

## 置き換えた範囲

| 範囲 | 状態 |
|---|---|
| 題名・表示の操作・道具・選択バー・知らせ | utilityとtokenへ移した。選んでいる状態は`aria-pressed`で示す |
| コメントの欄（やりとり・入力・ボタン） | utilityとtokenへ移した |
| ボードの中身 | CSSの決まりのまま。色と文字の大きさを名前の参照に替えた（値は同じ） |

残っていること。

- 操作の部品の押せる大きさは高さ36pxで、共通契約の`control-hit-size`（44px）より小さい。ボードの中身を隠さないことを優先して、移行前の大きさに近いままにした
- 暗い配色のテーマは作っていない

## 前後の物差し

`inventory.mjs`（`src/client/ui-design`は除いて数えた）。

| 項目 | 前 | 後 |
|---|---|---|
| 色の直接指定 | 157 | 23 |
| 色の直接指定の種類 | 49 | 19 |
| 文字の大きさの直接指定 | 26 | 1 |
| Tailwind既定paletteのclass | 0 | 0 |
| tokenを参照しない任意値 | 0 | 0 |
| 段外の余白 | 0 | 0 |
| inline style | 0 | 0 |

後に残った色23は、すべて`src/shared/colors.ts`の写し。文字の大きさ1は、`code`の`0.9em`（まわりの文字に対する比）。

中身の見た目は、6枚のボードを`xwb shot`で書き出して、移行前とPNGのバイト列が一致することを確かめた。操作の部品は、6つの状態を幅1280pxで撮って見比べた。面と文字の対16組は、テーマの値から計算して4.5:1（文字）と3:1（縁・輪）を満たす。

`review`スキルでは、幅1280pxと768px、明るい配色、マウスでの操作を範囲にして確かめた。使うのは1人なので、キーボードだけでの操作・読み上げ・文字200%・幅390pxは範囲から外した。範囲の中の指摘（消える知らせ、選択バーの折り返し、空欄の選択、色の名前）は直してある。利用者の5段階の評価は取っていない。

## ui-designへ戻す改善

導入で見つけた次の点は、ui-designの`efdf1e66`に入っている。

- テーマを`bun-plugin-tailwind`に通すと`color-mix()`が失われること（`docs/migration.md`の「読み込み」）
- Reactを使わない採用先の進め方（`skills/setup`）
- 既存のclassと同じ名前のutilityの確かめ方（`docs/migration.md`の「名前の衝突」）
- 中身が主の画面の決まり（`docs/composition.md`）と、`review`の確認の範囲

`capture.mjs`と`contrast.mjs`は、導入済みのChromeで動くようになったと連絡を受けた。xwbではまだ実行していない。
