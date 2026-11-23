# サイト開設手順書（GitHub Pages）

- 対象: SFSH の公開サイトを GitHub Pages で開設する手順（REQUIREMENTS v1.4 の 6.3-6・7.2 M5、U-05）。作成: オーケストレーター（M5、台帳 CP-046）。
- **この手順は発注者（kokuren）の開設指示が出てから実行する。** 指示が出るまで、GitHub 上の作成・変更・push を伴う操作を一切しない（CP-041）。M5 の時点では手順 1〜6 のどれも実行していない。
- 開設前の状態（M5 完了時点）: `harness/config/publish.json` の `production_enabled: false`（本番ゲートは閉）。`publish/` はローカルの試験用 bare（`publish-test/site.git`）を向いている。ハーネス側リポジトリに remote は無い（U-06）。

## 0. 開設前に発注者に決めてもらうこと

下表の「既定」は回答が無いときの扱い。開設に必須なのは **U-05 のアカウントとリポジトリ名** だけで、他は既定のまま開設できる。

| ID | 決めること | 選択肢・影響 | 既定 |
|---|---|---|---|
| U-05 (a) | 公開リポジトリを置く GitHub アカウント（個人／組織） | URL が `https://<アカウント>.github.io/...` になる。push の資格情報はこのアカウントのもの | なし（**回答が必須**） |
| U-05 (b) | リポジトリ名 | `<アカウント>.github.io` にするとサイトの URL がドメイン直下（`https://<アカウント>.github.io/`）。それ以外の名前（例 `story-notes`）だと `https://<アカウント>.github.io/<名前>/` | なし（**回答が必須**） |
| U-05 (c) | 独自ドメインを使うか | 使う場合は DNS 設定と、ビルドに `CNAME` ファイルを出す小改修（push 前検証 (a) で `CNAME` だけを許可する。`.nojekyll` と同じ扱い）が開設前に必要。使わなければ改修不要 | 使わない |
| U-07 | 開設後の公開の運用 | `auto`: 作品が完成したら自動で公開（気になれば `hold`／`takedown`）／`manual`: `built` で止まり、オーナーの `sfsh publish` でまとめて公開 | `auto` |
| U-08 | 専門家（弁護士等）の確認を挟むか | 挟む場合は運用を `manual` にして、確認後に `sfsh publish` する形が最小 | 挟まない |
| U-10 | 取り下げ依頼の窓口 | 公開リポジトリの Issues（個人の連絡先を出さない）／別の窓口。メールアドレスにする場合は push 前検証 (c) がメールアドレスを止めるため、`publish.json` の `allow_emails` にそのアドレスだけを登録する | 公開リポジトリの Issues |
| U-14 | 公開サイトの名称（内部名 SFSH と分けるか） | `harness/config/site.json` の `site_name` に入れるだけで全ページ（ヘッダ・各ページのタイトル・方針ページ）が差し替わる。未設定の表示は「SFSH（仮称）」 | 未定（開設時に決める）。決まらなければ「SFSH（仮称）」のまま開設できる |
| U-15 | 収益化・広告・アクセス解析・検索エンジン登録 | 広告・解析を入れる場合は外部スクリプトになり push 前検証 (d) が止めるため、設計変更として PM の判断が要る | すべてなし（解析なし・広告なし）、検索登録は許可 |

## 1. リポジトリ作成（GitHub 上の作業。オーナー）

1. U-05 のアカウントで **公開（Public）** リポジトリを作る。名前は U-05 (b)。
2. README・.gitignore・ライセンスは **追加しない**（空のリポジトリにする）。追加しても初回の強制 push で置き換わるが、空の方が履歴が単一コミットのまま確認しやすい。
3. 既定ブランチは `main`。
4. Issues を有効にしておく（U-10 の既定の窓口）。Wiki・Projects は不要。

## 2. 資格情報（この機械。オーナー）

- push に使う資格情報は、この機械の git の通常の資格情報（Git Credential Manager 等）だけにする。**トークンや鍵をハーネスのリポジトリ・設定ファイルに書かない**（`.env` も git 管理外だが、公開の資格情報は置かない）。
- `sfsh publish` は端末でのパスワード入力を求めない設定（`GIT_TERMINAL_PROMPT=0`）で git を呼ぶ。初回は、オーナーが手で一度認証しておく（例: `git ls-remote https://github.com/<アカウント>/<リポジトリ>.git`）。

## 3. 設定（ハーネス側。オーナーまたはオーナーの指示を受けたオーケストレーター）

雛形: `harness/config/publish.opening.example.json`、`harness/config/site.opening.example.json`。

1. `harness/config/publish.json`
   - `remote_url`: `https://github.com/<アカウント>/<リポジトリ>.git`
   - `base_url`: 公開 URL（例 `https://<アカウント>.github.io/<リポジトリ>/`、`<アカウント>.github.io` リポジトリなら `https://<アカウント>.github.io/`）。sitemap.xml・404 ページのリンク・公開後検証に使う。
   - `mode`: U-07（既定 `auto`）。
   - `production_enabled`: **`true`（これが本番ゲートを開く操作）**。開くと `test_remote_url` は使われなくなり、push 先は `remote_url` だけになる。
2. `harness/config/site.json`
   - `site_name`: U-14 の公開名（決まっていなければ `null` のまま）。
   - `contact.url`: `https://github.com/<アカウント>/<リポジトリ>/issues`（U-10 が Issues の場合）。
3. `publish/` の remote を公開リポジトリへ向ける（ハーネス側リポジトリには **登録しない**）:
   ```
   git -C publish remote set-url origin https://github.com/<アカウント>/<リポジトリ>.git
   node harness/src/cli.ts publish status
   ```
   `remote check (6.3-8): ok` を確認する。ok でなければ、表示された問題（remote が origin 以外にもある、URL が `remote_url` と違う、ハーネス側に同じ URL の remote がある等）を直す。
4. 事前検証（push しない）: `node harness/src/cli.ts publish --dry-run` → `DRY_RUN`、検証 (a)〜(g) と取り違え検査が ok。

## 4. Pages の有効化（GitHub 上の作業。オーナー）

初回 push の前でも後でもよい（push の後の方がブランチを選びやすい）。

1. リポジトリの Settings → Pages。
2. Source: **Deploy from a branch**、Branch: **`main`**、フォルダ **`/ (root)`**。
3. サイトは `.nojekyll` を含むので Jekyll の処理は行われない。
4. 独自ドメインを使う場合（U-05 (c)）は、ここで設定する前に `CNAME` の小改修を済ませる（0 の表）。HTTPS の強制を有効にする。

## 5. 初回 push（オーナーの指示のもとで）

```
node harness/src/cli.ts publish
```

- 流れ: ビルド（`base_url` つき）→ push 前検証 (a)〜(g) → 取り違え検査 → 単一コミットのスナップショット → 強制 push → 公開 URL の照合（Pages の反映を `url_check.timeout_s`（既定 600 秒）まで 15 秒おきに待つ）。
- 結果は `PUSHED` と、`post-push (URL): ok — N files at <base_url>`。記録は `logs/publish/<release_id>.json`、台帳の `- PUBLISH …` 行、作品ごとの `works/<id>/releases/<release_id>.json`。
- URL の照合が時間切れになった場合（Pages の初回反映が遅い）: 数分後に `node harness/src/cli.ts publish verify-url` を実行して確認する（push のやり直しは不要）。

## 6. 開設後の確認（1回。結果を台帳に記録する。7.2 M5 末尾）

M5 で試験用 bare に対して行った確認を、公開リポジトリと公開 URL に対して1回行う。

1. **サイト以外のファイルが無い・単一コミット・マニフェスト一致**
   ```
   git -C publish ls-remote origin          # refs/heads/main だけ（HEAD を除く）
   git clone --mirror https://github.com/<アカウント>/<リポジトリ>.git %TEMP%\sfsh-mirror.git
   git --git-dir %TEMP%\sfsh-mirror.git rev-list --all --count     # 1
   git --git-dir %TEMP%\sfsh-mirror.git ls-tree -r --name-only main # site/.publish-stage のファイル一覧と一致
   node harness/src/cli.ts publish verify-url                        # 全ファイルの sha256 が release-manifest.json と一致
   ```
2. **取り下げ訓練（ダミー作品、15分以内）**
   ```
   node harness/probes/m5_dummy_work.ts --id novel-sfsh-takedown-drill-open-2026   # M5 のダミー（Restricted の記録）とは別 ID で作る
   node harness/src/cli.ts publish                            # ダミー作品が公開 URL に出ることを確認
   node harness/src/cli.ts takedown <ダミーの work_id> --reason "開設後の取り下げ訓練"
   ```
   - takedown の出力で `push: pushed production …` と `URL 404 check: ok: <base_url>works/<id>/ → 404, catalog clean (public URL)` を確認する。所要時間（指示から完了まで）を記録する（目標15分）。
   - 履歴からも消えたこと: 上の mirror を取り直して `rev-list --all --count` が 1、`git --git-dir … grep <ダミーの題名> main` が空。
   - 最後に `node harness/src/cli.ts purge <ダミーの work_id>`。
3. 台帳に CP を書く（日時、release_id、コミット、照合結果、takedown の所要時間、404 の確認）。

## 7. 開設をやめる・止めるとき

- push を止める: `harness/config/publish.json` の `production_enabled` を `false` に戻す（以後、公開リポジトリへは push しない。worker の自動公開も止まる）。
- サイトを閉じる（オーナーの GitHub 上の操作）: Settings → Pages を無効にする、またはリポジトリを非公開・削除する。
- 緊急時に GitHub に push できない状態で即時に隠したい場合も、上の GitHub 上の操作が最短になる（運用手順書「障害時」）。
