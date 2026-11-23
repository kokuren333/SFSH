# ハーネス本体の公開（AMENDMENT 08）— 運用手順

- 対象: ハーネス（コードと設計文書）を、サイト用とは別の公開リポジトリ **`kokuren333/SFSH`**（Apache-2.0）へ反映する手順。要件は REQUIREMENTS v1.5 の 6.6。作成: オーケストレーター（M5 の下書き → 開設時の初回公開（台帳 CP-048・049）→ M6 で `sfsh harness-publish` として自動化、台帳 CP-052 以後）。
- コマンドはリポジトリ直下（`sfsh/`）で `node harness/src/cli.ts harness-publish …`（`sfsh.cmd harness-publish …` でも同じ）。
- 記録: `logs/harness-publish/<時刻>.json`（dry-run は `.dry.json`）と台帳 `logs/LEDGER.md` の `- HARNESS-PUBLISH …` 行。

## 1. 仕組み

| 項目 | 内容 |
|---|---|
| 公開先 | `kokuren333/SFSH`（public、Apache-2.0、homepage = サイト URL）。設定 `harness/config/harness-export.json` の `remote_url`。 |
| 書き出し元 | ハーネス側リポジトリの **HEAD の追跡ファイル**（作業ツリーではない）。公開したい変更は先にコミットする。書き出しに使った HEAD のコミットは公開側のコミットメッセージと記録に残る。 |
| 含めるもの | 設定の `include`（`harness/` の src・test・schema・bin・probes・`config/*.json`、`site/src`・`site/fixtures`、`design/` の REQUIREMENTS・RUNBOOK・SITE_OPENING・本書、ルートの `package.json` 等）＋ `add`（`LICENSE`・公開用 `README.md`。正本は `harness/export/`）。 |
| 含めないもの | 設定の `exclude` に加え、コードで固定の禁止パス: `works/`・`logs/`・`queue/`・`_handoff/`・`BRIEF.md`・`publish/`・`publish-test/`・`harness-publish/`・`site/dist` 等のビルド出力・`node_modules/`・`secrets/`・`.env*`・`*.pem`・`*.key`・`research/raw/`、および書き出し設定 `harness/config/harness-export.json` 自身（発注者の氏名などの照合語を持つため）。 |
| 写し側だけの書き換え | `replace_all`（発注者の氏名 →「kokuren」）と `file_rewrites`（`.gitignore` 冒頭の「This repo is PRIVATE」の注記と、`package.json` の description「private local harness」を公開リポジトリの実態に合う文言へ）。`file_rewrites` は元の文言がちょうど1回現れないと止まる（元が変わったら設定を直す）。ハーネス側の正本は書き換えない。 |
| 機械走査（push 前） | 書き出したツリー全体に対して: (1) 禁止パス、(2) 照合語（発注者の氏名・ユーザー名）、(3) サイトの push 前検証 (c) と同じ規則の秘密情報様の文字列・メールアドレス・ローカルパス・file スキームの URL。該当が1件でもあれば push しない。テストの作り物や検出器自身の正規表現など、確認済みで漏えいではない該当は設定の `allow_hits`（パス・種類・値の完全一致、理由つき）に入れたものだけを除外する。メールは `*.invalid`・`example.*`・`users.noreply.github.com`・`git@github.com` を除外。 |
| 作業クローン | `harness-publish/`（ハーネス側では git 管理外）。独立したリポジトリで、remote は `origin`（= 公開先）の1つだけ。push 直前に、クローンがハーネス側リポジトリと別であること、remote が `origin` だけで fetch／push の URL が設定と一致すること、**ハーネス側に remote が無いこと**（U-06）を確かめ、どれかが違えば止まる。無ければ初回に clone する。 |
| 履歴 | 公開側は開設時の単一コミット（`3a7a5ac`）から始まり、書き出しのたびに1コミットを積む（強制 push しない）。ハーネス側の開発履歴は公開しない。名義は `kokuren333 <…@users.noreply.github.com>`（個人のメールアドレスを出さない）。 |

## 2. 日常の操作

| したいこと | コマンド | 確認するところ |
|---|---|---|
| 公開せずに確かめる | `harness-publish --dry-run` | `DRY_RUN`、`scan: ok`、`clone check: ok`、`diff vs public: +追加 ~変更 -削除` |
| 公開する | `harness-publish --message "変更の要約"` | `PUSHED`、`commit` と `remote` が同じ値、台帳に `- HARNESS-PUBLISH … status=pushed` |
| 変更が無いとき | （同上） | `NO_CHANGE`（何も push しない） |

手順:
1. ハーネス側で変更をコミットする（書き出しは HEAD から取る）。
2. `harness-publish --dry-run` で走査と差分を見る。`scan: BLOCKED` なら表示された種類・ファイル・行を確かめる。
   - 本物の漏えい（氏名・ローカルパス・トークン・メールアドレスなど）なら、ハーネス側の正本を直してコミットし直す（または `exclude` に足す）。
   - テストの作り物・検出器の正規表現なら、`allow_hits` に `{path, kind, value, why}` を足す（値は表示された文字列と完全一致）。
3. `harness-publish --message "…"` で公開する。rc=0 で `PUSHED`。
4. 必要なら `https://github.com/kokuren333/SFSH` で反映を見る。

## 3. 障害時

| 症状 | 対処 |
|---|---|
| `BLOCKED`（scan） | 上の 2-2。走査を外して push しない。 |
| `BLOCKED`（clone check） | `git -C harness-publish remote -v` を見て `origin` を設定の URL だけにする。ハーネス側に remote があれば消す（`git remote -v`）。壊れていれば `harness-publish/` を消して再実行（clone し直す。公開側の履歴は GitHub にある）。 |
| `FAILED`（`file_rewrites … occurs 0 times`） | 元の文言が変わった。`harness-export.json` の `from` を今の文言に合わせる（ハーネス側の正本の意味が変わっていないか確かめる）。 |
| `FAILED`（push の拒否・認証） | 資格情報（Git Credential Manager）を確かめる。公開側に別の更新があって fast-forward できない場合は、`harness-publish/` を消して再実行（最新を clone し、その上に積む）。 |
| 公開してはいけないものを公開してしまった | まず秘密情報なら無効化する。次に正本を直して `harness-publish` で消した版を積む。履歴に残った版の消去は GitHub Support への依頼（`RUNBOOK.md` 6 と同じ手続き）。 |

## 4. 開設時の記録（参考）

- 初回公開は開設の指示（2026-11-23 10:19）の後に手作業で行った（台帳 CP-048 区切り(6)(7)・CP-049）。書き出し元 `0ae6b24`、273 ファイル＋`LICENSE`・`README.md` = 275 ファイル、単一コミット `3a7a5ac`。
- M6 以後は本書 2 の `harness-publish` で反映する。
