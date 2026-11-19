---
name: verify
description: xwbを別のポートで起動し、CLIと画面から操作して、変更が動くかを確かめる手順。
when_to_use: xwbの変更を、テストでなく実際に動かして確かめるとき。画面（src/client）、サーバー、CLI、ボードの操作（src/shared）を変えた後。レビューで、動かして確かめるとき。
---

# xwbを動かして確かめる

テストと型検査（`bun test`、`bun run typecheck`）は、ここでは走らせない。確かめるのは、CLIの返事、ボードのファイル、画面の3つ。

## 起動する

```bash
export XWB_PORT=4801          # 4747 は使わない。並べて確かめるなら、担当ごとに別の番号（4811、4812…）
DIR=$(mktemp -d)              # フォルダは先に作る。無いと「フォルダが無い」で断られる
BOARD="$DIR/v.board.json"
URL=$(bin/xwb open "$BOARD" --no-open --title 確認 | jq -r .url)
```

- シェルの変数は、Bashの呼び出しをまたいで残らない。起動から操作までを1つのスクリプトのファイルに書いて走らせる。`$URL`は、動いているサーバーに`bin/xwb open "$BOARD" --no-open`を打ち直せば、同じボードのものが取れる。
- 既定のポート（4747）のサーバーは、会議で開いている画面がつながっていることがある。止めない、使わない。
- サーバーは、起動したときの`src/client`と`src/server`、`src/shared`を使う。直した後は`bin/xwb stop`（同じ`XWB_PORT`で）してから開き直す。
- `$URL`には、APIのトークンが`#k=…`で付いている。変数のまま使い、画面にも報告にもファイルにも出さない。出力に混ざるときは`sed -E 's/k=[A-Za-z0-9_-]+/k=…/g'`を通す。
- 終わったら`bin/xwb stop`。`pkill`と`killall`は使わない。止めた直後は、ポートの待ち受けが数秒残る。同じポートで起動し直すなら、少し待つ。

## CLIから操作する

返事のJSONと、ボードの今の状態が証拠になる。

```bash
bin/xwb add "$BOARD" '{"id":"t1","type":"container","title":"列","w":504,"cols":2}' | jq -c '.[] | {id, h}'
bin/xwb add "$BOARD" --in t1 '{"id":"a","type":"shape","text":"付箋"}' | jq -c '.[] | {id, x, y}'
bin/xwb ls "$BOARD" | jq -c '.elements[] | {id, x, y, w, h}'    # 全部の要素の位置と大きさ
bin/xwb check "$BOARD" | jq -c .                                  # 見た目の検査。問題が無ければ []
bin/xwb shot "$BOARD"                                             # $DIR/v.board.png に書き出す。Read で見る
```

`apply`、`set`、`template`、`focus`などの書き方は`docs/agent-guide.md`にある。

## 画面から操作する

`playwright-cli`を、名前付きのセッションで使う（`-s=<名前>`。名前を付けないと、ほかのセッションと同じブラウザを取り合う）。記録のフォルダ（`.playwright-cli/`）が今いる場所にできるので、先に`$DIR`へ移る。

```bash
cd "$DIR"
playwright-cli -s=xwbv open "$URL" >/dev/null
playwright-cli -s=xwbv resize 1280 800 >/dev/null
playwright-cli -s=xwbv run-code "async page => {
  await page.waitForSelector('.el');
  await page.click('#fit');                         // 「全体」。画面の外の要素は、クリックで選べない
  await page.click('[data-id=a] .txt');             // 付箋を選ぶ。セクションは '[data-id=t1] .ttl'
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);                   // サーバーの返事を待つ
  await page.click('#undo');                        // 「戻す」
  await page.waitForTimeout(300);
  return await page.evaluate(() => [...document.querySelectorAll('.el')]
    .map((n) => n.dataset.id + '@' + parseInt(n.style.left) + ',' + parseInt(n.style.top)).join(' '));
}" | sed -E 's/k=[A-Za-z0-9_-]+/k=…/g' | rg -A2 '### Result'
playwright-cli -s=xwbv screenshot --filename="$DIR/shot.png" >/dev/null
playwright-cli -s=xwbv close >/dev/null
```

- 要素は`[data-id=<id>]`で取れる。位置は`style.left`・`style.top`、大きさは`style.width`・`style.height`（ボードの座標）。
- ドラッグは`page.mouse.move`・`down`・`move(…, { steps: 8 })`・`up`。座標は`locator.boundingBox()`で取る（画面の座標）。
- 選択バーは`#bar`の中。選択は`page.selectOption('#bar select[title="中身の並べ方"]', '2')`、ボタンは`page.click('#bar button:has-text("注目")')`。
- 道具は`#tools button[data-tool=note]`など。表示の操作は`#fit`（全体）、`#undo`（戻す）、`#png`。
- 画面どうしの同期（注目、人とエージェントが同時に触る流れ）は、セッションの名前を変えて画面を2つ開く（`-s=xwbv1`と`-s=xwbv2`）。
- `run-code`が文字列を返すと、結果の行は引用符とエスケープが付いて出る。
- 入力のダイアログ（選択バーの「見出し」「期限」「論点」「結論」の`prompt`）は、`run-code`の中で`page.on('dialog')`で答えると、次の`run-code`が`does not handle the modal state`で止まる。ボタンのクリックを待たずに`run-code`を終え（`page.click(...)`を`await`しない）、別の呼び出しで`playwright-cli -s=<名前> dialog-accept "<値>"`を打つ。取り消しは`dialog-dismiss`。
- `playwright-cli`のセッションは、開いたフォルダごとに分かれる。`close`を別のフォルダで打つと`Browser '…' is not open`と返って閉じない。開いたフォルダ（`$DIR`）で打つ。
- 画面の状態とボードのファイルの両方を見る。画面だけが正しい、ファイルだけが正しい、のどちらもありうる。
- コメントの入力欄に画像を貼るのは、`run-code`の中で`navigator.clipboard.write`に画像を入れてから`Meta+V`を押す。先に`await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4801' })`が要る（`origin`は`XWB_PORT`に合わせる）。受け付けない形式や大きすぎる画像は、`new DataTransfer()`に`File`を足し、`new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })`を`.cinput`へ`dispatchEvent`する。

## Claude への届き方を見る

コメントの「送る」で Claude に届く中身は、チャネルを立てずに、`/api/channel`をcurlでつないで読む。ボードのフォルダ（`$DIR`）を`root`に渡す。curlは別の呼び出し（`run_in_background`）で走らせるので、その呼び出しの頭で`XWB_PORT`と`DIR`を設定し直す。つながっていないと「送る」は`Claude につながっていません`になり、やりとりに「送り直す」が出る。

```bash
curl -sN -H @<(printf 'x-xwb-token: %s' "$(cat ~/.cache/xwb/token)") "http://127.0.0.1:$XWB_PORT/api/channel?root=$(jq -rn --arg r "$DIR" '$r|@uri')&pid=1&listening=1" > "$DIR/chan.log"   # Bash の run_in_background で走らせる
rg '^data:' "$DIR/chan.log" | tail -1 | sed 's/^data: //' | jq -c '.line | {id, text, images, elements}'
```

- トークンは`-H @<(…)`で渡す。`-H "x-xwb-token: …"`と書くと、`ps`にトークンが出る。
- 止めるときは、`pgrep -f '^curl .*listening=1'`で番号を取り、`kill <番号>`。`^curl`を外すと、curlを走らせているシェルも当たる。
- コメントに貼った画像は、ボードのフォルダでなく`~/.cache/xwb/images/`に書かれる。

## つつく価値のある流れ

不具合が実際に出た所。変更が関わるものを選ぶ。

- **操作して「戻す」**。前後で、全部の要素の位置と大きさを比べる（`bin/xwb ls`）。列で並べるセクション（`cols`）では、行が増える例と減る例の両方（最後の行の付箋を消す、外へ出す、1枚だけのセクションで消す）。続けて何回か操作してから、同じ回数だけ戻す。
- **人とエージェントが同時に触る**。画面を開いたまま、CLIで同じ要素を`set`・`rm`する。画面で操作した直後に「戻す」。
  画面で操作した後、「戻す」の前にCLIで触る順も試す。その操作で動いた要素を`rm`する、動かしたセクションに`--in`で足す。戻した後に、重なった付箋と、セクションの外に残った付箋が無いかを見る。
- **「戻す」を待たずに続けて押す**。操作を3つ積み、⌘Zを間を空けずに3回押す。
- **セクションの周り**。セクションをドラッグで動かす（中身ごと動くか）、中身を出し入れする、すぐ下や横に別のセクションがある配置で中身を増やす。
- **同じ操作を2回**。何もしない操作（`bin/xwb title "$BOARD" x`）をかけた後に、位置が変わらないこと。
- **並べ直し（format）**。画面を開いたまま `bin/xwb format "$BOARD"` を打ち、返った `moved`、`ls` の前後で座標が変わった id の集まり、画面の `.el` の left/top の 3 つを比べる。`--dry-run` の前後で、ファイルの shasum が変わらないこと。固定したセクション、入れ子、枠の外の付箋（障害物）を混ぜる。2 回目は `{"moved":[]}` で、shasum が変わらないこと（何も変わらなくてもファイルは書き直すので、mtime は変わる）。人が画面で触った要素を format で動かすと、`xwb changes` の `fields` に `x`・`y` が加わる（人が触る前の値との差を出す作りのため）。
- **見た目**。`bin/xwb shot`のPNGと、画面のスクリーンショットを見る。`bin/xwb check`が`[]`でも、見た目が崩れていることがある。

## つまずく点

- 自分の操作の結果は、返事より先にSSEで届くことがある。画面の値を読む前に、少し待つ。
- 書き出しの画面（`bin/xwb shot`）には、操作の部品、選択、注目が出ない。それらは画面のスクリーンショットで見る。
- 文字の編集は、ダブルクリックで始め、Escapeで確定する。確定の後に、何も無い場所をクリックして選択を外す。
- 要素をクリックした直後に、同じ場所からドラッグすると、ダブルクリックになって編集が始まる。選んでからつかむまで、0.7秒ほど待つ。
- コメントのピン（`[data-id=<id>] .cpin`）を押すと欄が開き、入力欄にフォーカスが移る。Deleteキーでは消えないので、`#bar button:has-text("削除")`を押す。欄はEscapeでは閉じない（入力欄のフォーカスが外れるだけ）。何も無い所をクリックして閉じる。やりとりの無いコメントは、欄を閉じると消える。CLIで置いたコメントは、`bin/xwb reply "$BOARD" <id> 文`で1件書いてから使う。
- 断られた操作の知らせは`#toast`に出る（`hidden`でなければ表示中）。次の操作の前に、`#toast button`で閉じる。
- このワークスペースの`.git`は、元のリポジトリを指している。`git diff HEAD`の結果は、ほかのワークスペースのコミットで変わる。変更の範囲は`jj diff`で読む。
- 見た目を変えないはずの変更は、`bin/xwb shot`のPNGのハッシュ（`shasum -a 256`）を前後で比べる。同じボードなら同じバイト列になる。
