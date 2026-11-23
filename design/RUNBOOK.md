# SFSH 運用手順書（公開・取り下げ・障害時）

- 対象: 公開（S5–S6）と取り下げの運用（REQUIREMENTS v1.4 の 5.3・5.4・6.3、WP-5.5）。作成: オーケストレーター（M5、台帳 CP-046）。開設の手順は `design/SITE_OPENING.md`。
- コマンドはすべてリポジトリ直下（`sfsh/`）で `node harness/src/cli.ts <コマンド>` として実行する（`sfsh.cmd <コマンド>` でも同じ）。
- 記録の置き場所: 公開の実行記録 `logs/publish/<release_id>.json`、台帳 `logs/LEDGER.md` の `- PUBLISH …`／`- OPS …` 行、作品の `works/<id>/work.json` の `history[]`、作品ごとのリリース記録 `works/<id>/releases/<release_id>.json`。

## 1. 仕組みの要点

| 項目 | 内容 |
|---|---|
| 公開先 | `publish/`（公開リポジトリの独立クローン）の `origin`。ハーネス側リポジトリとは履歴も remote も共有しない。ハーネス側に公開リポジトリを remote として登録しない。 |
| 本番ゲート | `harness/config/publish.json` の `production_enabled`。`false`（開設前の既定）の間は、push 先はローカルの試験用 bare（`test_remote_url`）だけで、git もネットワーク転送を拒否する設定で動く。`true` にするのは開設の指示の後（`SITE_OPENING.md`）。 |
| 公開の形 | 公開リポジトリは常に「現在の `site/dist` だけを含む親なしの単一コミット」。毎回強制 push で置き換えるので、取り下げた内容は公開リポジトリの履歴に残らない。 |
| push 前検証 | (a) 拡張子の許可リスト（html, css, js, json, svg, txt, xml, woff2, ico と `.nojekyll`）／(b) dist に現れる作品が Public だけ／(c) 秘密情報様の文字列・メールアドレス・ローカルパスなし／(d) 外部リソースの読み込みなし／(e) A-2（画像・メディア混入）の再検査／(f) 前回比の異常増（警告のみ）／(g) catalog.json と一覧系ページの作品が Public の集合と一致。(f) 以外が1つでも該当すれば push しない。 |
| 取り違え検査 | push 直前に、`publish/` が独立したリポジトリで、remote が `origin` の1つだけ、その URL（fetch・push とも）が設定の公開先と一致し、ハーネス側の remote と異なることを確かめる。不一致なら push しない。 |
| 自動公開 | 開設後（ゲート開）かつ `mode: auto` のとき、worker が作品の完成（`built`）の後に公開して `published` にする。`manual` なら `built` で止まり、`sfsh publish` でまとめて公開する。開設前はすべて `built` で止まる。 |

## 2. 日常の操作

| したいこと | コマンド | 確認するところ |
|---|---|---|
| 公開の状態を見る | `publish status` | ゲート（開／閉）、公開先、取り違え検査 ok、直近の公開 |
| 手で公開する（`manual` 運用、または自動公開の失敗後） | `publish` | `PUSHED`、`verify … ok`、`remote check ok`、`post-push … ok` |
| push せずに検証だけ | `publish --dry-run` | `DRY_RUN`、検証と取り違え検査の結果 |
| 公開 URL の中身を確かめる（開設後） | `publish verify-url` | 全ファイルの sha256 がマニフェストと一致 |
| 公開を止める（作品単位） | `hold <work_id> --reason "…"` | 次のビルド・公開から外れる。既に公開済みなら `takedown` を使う |
| 止めた作品を戻す | `release <work_id> --reason "…"` | 次の公開で戻る（自動公開なら次のジョブ完了時、`manual` なら `publish`） |

## 3. 取り下げ（takedown）

**申し立てを受けたら、是非を検討する前にまず取り下げる**（5.4）。確認の往復を挟まない。目標は指示から15分以内（M5 の試験用 bare での実測は 10.2 秒）。

```
node harness/src/cli.ts takedown <work_id> --reason "申し立て（Issue #番号）"
```

Discord からはオーナーの `/sfsh takedown`（開設後・bot の本番接続後）。

自動で行われること（1コマンド）:
1. 作品を Restricted にする（進行中のジョブは held）。
2. その作品を除いてサイトを再ビルドし、dist に作品 ID・題名・原題・エイリアスの痕跡が残っていないことを確かめる。
3. push 前検証 → 取り違え検査 → 単一コミットのスナップショットを強制 push → push 後検証。
4. 公開 URL で作品ページが 404 になり、catalog.json（検索データ）に作品が残っていないことを確かめる（Pages の反映を最大 `url_check.timeout_s` 待つ）。
5. `work.json` の `history[]` と台帳に記録する。

出力の確認:
- `push: pushed production <コミット>` … 公開リポジトリが作品を含まないスナップショットに置き換わった。
- `URL 404 check: ok: <URL> → 404, catalog clean (public URL)` … 公開 URL で消えたことを確認済み。
- rc=0。rc=3 のときは失敗の理由が表示される（7. 障害時）。

取り下げの後にすること:
- 依頼の Issue に、取り下げたこと（日時）を返信する。個人情報は書かない。
- 検索エンジンのキャッシュと GitHub 側の写しが残っていれば、4・5 の手続きをする。
- 是非を検討し、問題が無ければ `release` で戻す。完全に消すなら `purge`。

## 4. 完全消去（purge）

```
node harness/src/cli.ts purge <work_id> --reason "完全消去の要請"
```

takedown と同じ流れに加えて、ローカルの `gen/`・`releases/`・`check/`（生成文とその写し）を削除する。`research/`・`nkg/`・`work.json`・台帳の記録は証跡として残る。

## 5. 検索エンジンのキャッシュ削除申請（SFSH の外の手続き）

取り下げたページが検索結果やキャッシュに残っている場合（5.4）。ページはすでに 404 なので、「サイトから削除済みのページ」として申請できる。

- **Google**: 「古いコンテンツの削除」ツール（Search Console の一般公開向けツール。サイトの所有権の確認は不要）に、404 になった URL を入力して申請する。サイトの所有権を Search Console で確認済みなら、Search Console の「削除」から一時的な非表示も申請できる。
- **Bing**: Bing Webmaster Tools の「コンテンツ削除ツール」（Content Removal Tool）で、404 の URL を申請する。
- ツールの場所や名称は変わることがある。見つからなければ名称で検索する。申請した URL と日時を台帳に記録する。

## 6. GitHub 側に残る写しの消去（SFSH の外の手続き）

スナップショットの強制 push で、公開リポジトリのブランチの履歴からは消える。ただし次は GitHub 側やほかの場所に残りうる。

- **旧コミットの表示**: 置き換え前のコミットは到達不能になるが、コミット ID を直接指定した URL ではしばらく表示されうる（GitHub が不要なオブジェクトを片付けるまで）。急ぐ場合は GitHub Support に、リポジトリ名と旧コミットの ID を添えて、キャッシュされた表示と到達不能なオブジェクトの削除を依頼する。旧コミットの ID は `logs/publish/<release_id>.json` の `commit` で分かる（台帳の `- PUBLISH` 行にも先頭12桁）。
- **フォークや他人のクローン**: 公開中に作られたフォークやクローンには残る。SFSH からは消せない。フォークの削除は GitHub の所定の手続き（権利者からの申し立てなら DMCA 等）による。
- **Pages の配信キャッシュ**: 通常は数分で新しい内容に置き換わる。takedown の 404 確認が時間切れになったら、時間を置いて `publish verify-url` と作品 URL を確かめる。

## 7. 障害時

| 症状 | 原因と対処 |
|---|---|
| `publish` が `BLOCKED`（push 前検証） | 表示された検査 ID と種類（例 `(c) github_token about/index.html`）を見る。秘密情報様の文字列やメールアドレスなら、生成元（作品の `gen/`）を直して再ビルド。Restricted の作品が混ざっていれば `site/dist` が古い（`publish` は既定で再ビルドするので、`--no-build` を外して再実行）。外部参照ならサイトのテンプレートの不具合。**検査を外して push しない。** |
| `publish` が `BLOCKED`（取り違え検査） | `git -C publish remote -v` を見て、`origin` を設定の公開先（ゲート閉: `test_remote_url`／開: `remote_url`）に直す。余計な remote は消す。ハーネス側に公開リポジトリの remote があれば消す（`git remote -v`）。 |
| `publish` が `BLOCKED`（ゲート） | `production_enabled: false` のまま公開先がネットワークの URL になっている。開設前なら正常な停止。開設の指示が出ているなら `SITE_OPENING.md` の 3 を行う。 |
| `FAILED`（push の失敗: 認証・ネットワーク） | 資格情報を確認し（`git -C publish ls-remote origin` を手で一度実行して認証）、`publish` を再実行する。スナップショットは毎回作り直すので、何度やり直しても公開リポジトリは単一コミットのまま。 |
| `FAILED`（push 後検証: URL の不一致・時間切れ） | Pages の反映待ちが多い。数分後に `publish verify-url`。続く場合は GitHub の Settings → Pages と Actions のビルド状況を確認する。 |
| takedown が rc=3（push 側の失敗） | 作品はすでに Restricted で、ローカルのビルドからは外れている。原因を直して `publish` を再実行すれば、作品を含まないスナップショットが公開される。GitHub に push できず急ぐ場合は、オーナーが GitHub 上で Pages を無効にするか、リポジトリを非公開にする（最短の緊急措置）。 |
| takedown が rc=3（ローカルの検査で痕跡が残った） | 作品の題名などが他の作品のページに書かれている可能性がある。表示されたファイルと文字列を確認し、他作品の生成文を直すか、その作品も hold する。痕跡が残ったままでは push しない。 |
| 自動公開に失敗した（ジョブは `built` のまま、通知に「公開に失敗」） | 原因を直して `publish`。ジョブを再実行する必要はない。 |
| ロックが残っている（`publish lock busy` / `build lock busy`） | 持ち主のプロセスが死んでいれば次の実行で自動的に引き継ぐ。生きているプロセスが無いのに残る場合だけ `site/.publish.lock`・`site/.input.lock` を消す。 |
| `publish/` が壊れた | `publish/` を消して作り直す（履歴を持たない方式なので失うものは無い）。ゲート閉: `publish init`。ゲート開: `git init -b main publish` → `git -C publish remote add origin <remote_url>` → `publish status` で取り違え検査 ok を確認 → `publish`。 |
| 秘密情報が公開されてしまった | まず秘密情報を無効化（トークンの再発行など）する。次に原因を消して `publish`（スナップショットで履歴からも消える）。6 の GitHub Support への依頼も行う。push 前検証 (c) が止めなかった形式なら、検査の規則に追加する。 |

## 8. 開設前の試験（試験用 bare）

開設前でも、公開と取り下げの流れはローカルの試験用 bare で確かめられる。

```
node harness/src/cli.ts publish init          # publish-test/site.git と publish/ を作る（済みなら何もしない）
node harness/src/cli.ts publish               # bare へ公開
node harness/src/cli.ts publish serve-test    # bare の main を http://127.0.0.1:8790/ で配信（Pages の代わり）
node harness/probes/m5_bare_check.ts          # bare の独立検査（コミット数・ファイル・マニフェスト）
```
