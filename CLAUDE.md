# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

xwbは、ローカルだけで動く会議用のホワイトボード。エージェントがCLIで書き込み、人がブラウザで見て直す。使うのは作者1人で、キーボードだけでの操作とa11yは優先しない。

## コマンド

```sh
bun install
bun test                                  # 全部
bun test test/model.test.ts               # 1ファイル
bun test -t "cols を書いたセクション"      # 名前で絞る
bun run typecheck                         # tsc --noEmit
```

lintとformatの道具は入っていない。ビルドの手順も無い。画面のスクリプトとCSSは、サーバーが起動時に`Bun.build`で組み立てる。

## 画面で確かめるとき

- `src/client`と`src/server`を直しても、動いているサーバーには入らない。起動し直しが要る。
- 既定のポート（4747）のサーバーは、会議で開いている画面がつながっていることがある。止めずに、別のポートで確かめる。`XWB_PORT=4801 bin/xwb open <作業用のフォルダ>/x.board.json --no-open`で立て、終わったら`XWB_PORT=4801 bin/xwb stop`で止める。
- `xwb open`が返すURLには、APIのトークンが`#k=…`で付いている。会話、ファイル、ログに書き写さない。スクリプトで扱うときは、出力から置き換えて消す。
- 見た目を変えないはずの変更（CSSの整理、描画の書き直し）は、`xwb shot`で書き出したPNGのハッシュを前後で比べる。書き出しは決定的で、同じボードなら同じバイト列になる。

## 全体の作り

ボードは`<名前>.board.json`の1ファイルで、1要素が1行。サーバーは1つで、どのフォルダのボードも絶対パスで扱う。

```
CLI（src/cli.ts）──HTTP──┐
ブラウザ（src/client）──HTTP＋SSE──┤ サーバー（src/server/server.ts）── ボードのファイル
チャネル（src/channel.ts）──HTTP──┘
```

- **`src/shared/model.ts`がデータの形と操作の唯一の置き場**。要素の検証（`parseEl`）と、操作の適用（`applyOps`。`add`・`set`・`rm`・`say`・`order`・`compact`・`title`・`template`と、画面の「元に戻す」だけが使う`restore`）がここにある。サーバーもCLIもブラウザも、これを通して同じ規則で読み書きする。項目を足すときは、`El`、`FIELDS`、`parseEl`の3か所を直す。
- **書き込みは必ずサーバーの`commitOps`を通る**。操作を適用し、ファイルに書き、SSEで開いている画面へ流す。ブラウザは、自分の操作の結果もサーバーの返事（`added`・`updated`・`removed`）から反映する。押し下げや並べ直しのようにサーバーが足した変更も、この返事で届く。同じ変更はSSEでも届き、返事より先に手元の状態へ入ることがある。「変える前の値」が要る処理（取り消し用の逆の操作）は、送る直前に写しを取る。
- **画面の「元に戻す」は、逆の操作でなく`restore`を送る**。変える前の形（`src/shared/restore.ts`の`restoreOp`が、サーバーの返事と、送る直前の写しから作る）をそのまま書き戻す。押し下げや、中身を連れていく規則は働かせず、その後に並べ直しだけをかける。配置の規則が働く`set`で戻すと、規則を打ち消す条件が直すたびに増える。画面が送る形の操作と「元に戻す」の往復は、`test/fuzz.test.ts`が乱数で確かめる（`XWB_FUZZ_SEEDS=3000 bun test test/fuzz.test.ts`で回数を増やせる）。
- **人の変更とエージェントの変更は、`client`を名乗るかで分ける**。ブラウザは名乗り、CLIは名乗らない。人の変更だけが`pending`に記録され、エージェントが`xwb changes`で読む。
- **サーバーとCLIは描画できない**。文字と表の大きさ、セクションの見出しの高さは、文字数からの見積もり（`sizeOf`、`sectionTop`、`check.ts`の定数）で決める。同じ数字が`src/client/board.css`にもあり、片方だけ変えると、置く場所と見た目がずれる。CSSの大きさや余白を変えたら、見積もりの式も直す。
- **セクションの中身は座標で決まる**。親子の項目は無く、中心がセクションの中にある要素が中身（`membersOf`）。列で並べるセクション（`cols`）の並ぶ順は、要素の並び（`doc.elements`の順）で持つ。位置から入れる場所を読むのは、その操作で場所を書いた要素だけ。
- **ファイルに書かない状態**がサーバーにある。書き込み中の枠（claim）と、注目（focus）。サーバーを起動し直すと消える。
- **見た目の検査（`src/shared/check.ts`）は描かずに測る**。純粋な関数で、ファイルの有無のようにボードの外を見る検査は、呼ぶ側が`CheckContext`で手段を渡す。
- **まとめの帯（`summary`）は中身を持たない**。付箋を状態で集める決まりは`src/shared/summary.ts`の`summarize`の1か所で、画面、帯の高さ、`xwb summary`、`xwb ls`、検査、書き出しが、全部そこを通る。
- **型（`src/shared/template.ts`）は専用の要素を持たない**。`matrix`・`versus`・`tree`を、ふつうの要素を足す操作に展開する。

エージェントから見た使い方（要素の形、コマンド、検査の種類）は`docs/agent-guide.md`にまとまっている。ここがCLIの仕様書を兼ねる。

## 画面のCSS

Tailwind CSS v4とui-designのtokenで書く。Reactは使わず、素のTypeScriptでDOMを組み立てる。役割の分け方と理由は`docs/ui-design.md`にある。

- 操作の部品（帯、ボタン、選択バー、コメントの欄）は、`src/client/app.css`とutilityで書く。
- ボードの中身（付箋、図形、表、ガント）は、`src/client/board.css`の決まりで書く。色と文字の大きさは、`xwb-theme.css`の変数を名前で参照する。直接の値を書かない。
- `board.css`、`xwb-theme.css`、`ui-design/themes/xwb.css`はTailwindを通さない。通すと`color-mix()`の式が失われる（理由は`server.ts`の`RAW_CSS`）。
- `board.css`にclassを足すときは、同じ名前のTailwindのutilityが無いかを確かめる。`container`・`table`・`grow`は衝突するので、`app.css`の`@source not inline`で除いてある。
- `src/client/ui-design/`はui-designからの複製で、書き換えない。
- 付箋の面と蛍光ペンの色は、`src/shared/colors.ts`に写しがある。ずれると`test/colors.test.ts`が落ちる。

## このリポジトリの決めごと

- **機能を足すときは、検査も同じ変更で作る**。新しい項目や要素を足したら、エージェントが間違えそうな使い方（指す先が無い、空のまま、矛盾する指定）を挙げ、`parseEl`で断るか、`check.ts`に規則を足す。テストと`docs/agent-guide.md`の検査の表も直す。ボードを書くのは主にエージェントで、検査が無いと、間違いに気づくのが人が画面で触ったときになる。
- **`docs/agent-guide.md`を実装と同じ変更で直す**。エージェントは、この文書だけを読んでボードを書く。
- **ボードのファイルの形を変えるときは、前のファイルが読めることを保つ**。会議のリポジトリに、過去のボードが入っている。
- 会議のボードの中身は社外の会議のものがある。このリポジトリのテストや文書に写さない。
