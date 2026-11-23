# SFSH (Super Fast Story Harness)

物語作品（小説・映画・アニメなど）について、公開ウェブ上の二次情報を調べ、「物語の認知モデル」——何が起きたか／誰が何を望みどう変わったか／なぜその展開か／なぜ面白いか——を構造化したグラフ（Narrative Knowledge Graph, NKG）にまとめ、静的サイトとして公開するためのローカル実行ハーネスです。

- 公開サイト: **https://kokuren333.github.io/sfsh-site/** （サイト名は「SFSH」。サイトのリポジトリ: https://github.com/kokuren333/sfsh-site ）
- このリポジトリ: ハーネス本体（コード・テスト・スキーマ・設定・設計文書）
- ライセンス: [Apache License 2.0](LICENSE)

## 仕組みの概要

```
指示（作品名＋範囲。CLI / Discord bot）
  → S0 受付（キュー）→ S1 調査 → S2 NKG 構築 → S3 生成 → S4 自動確認 → S5 静的ビルド → S6 公開（サイトのみ push）
```

- 調査・NKG 構築・生成の「中身」は LLM（調査は Luna 系、デザイン・執筆は Haiku。互いにレビュー）が作り、スキーマ検証・公開射影・ビルド・push 可否の判定は決定的なコードが行います。
- 原作の文章・台詞・画像は再利用しません（最上位制約 C-2）。原作本体を取得・保存・モデル入力する経路は持たず、混入は公開前に機械で検査します。
- 公開リポジトリにはビルド済みのサイトだけを、親コミットなしの単一コミットとして push します。push の前に、拡張子の許可リスト・公開対象の作品・秘密情報やローカルパス・外部リソース参照などを検査し、該当があれば push しません。
- 取り下げの依頼があれば、是非を検討する前にまず取り下げます（`takedown` の1コマンドで、再ビルド・push・公開 URL での 404 確認まで行います）。

詳しくは `design/` の文書を参照してください。

| 文書 | 内容 |
|---|---|
| `design/REQUIREMENTS.md` | 要件定義書（パイプライン、NKG スキーマ、モデルの分担、指示インターフェース、権利まわりの確認と取り下げ、公開の設計、マイルストーン） |
| `design/RUNBOOK.md` | 運用手順書（公開・取り下げ・完全消去・障害時） |
| `design/SITE_OPENING.md` | GitHub Pages でのサイト開設手順 |
| `design/HARNESS_PUBLISHING.md` | このリポジトリ（ハーネスの公開写し）の更新手順（`sfsh harness-publish`） |

## ディレクトリ

| パス | 内容 |
|---|---|
| `harness/src/` | CLI（`cli.ts`）と各段の実装（queue, research, nkg, gen, check, site, publish, discord ほか） |
| `harness/test/` | テスト（`node --test`）とブラウザ検査（Playwright） |
| `harness/schema/` | JSON スキーマ |
| `harness/config/` | 設定（モデル、ジャンル、公開先、サイト名と窓口など）と雛形 |
| `harness/probes/` | 実測・検査用のスクリプト |
| `site/src/`, `site/fixtures/` | 静的サイトのテンプレート・クライアントと、架空の作品による試験データ |

## 動かすには

- Node.js 22 以上。`npm install` の後、`node harness/src/cli.ts <コマンド>`（Windows では `sfsh.cmd <コマンド>` も可）。
- 型検査 `npm run typecheck`、テスト `npm test`。
- 調査・生成の段は、モデルを CLI のヘッドレス実行で呼び出します（Codex CLI と Claude Code CLI）。それぞれの CLI のインストールと認証が別途必要です。

## このリポジトリに含まれないもの

このリポジトリは、開発用の作業リポジトリから許可リストで書き出した写しです（開発時の git 履歴は含みません）。更新は `sfsh harness-publish` で行い、書き出しのたびに1コミットを積みます（各コミットのメッセージに書き出し元のコミットを記録）。push の前に、含めないパス・発注者の氏名・秘密情報様の文字列・メールアドレス・ローカルパスを機械で走査します。次のものは含めていません。

- 作品ごとの調査データ・NKG・生成物（`works/`）、キュー（`queue/`）
- 台帳・実行記録・関門の証拠などの記録（`logs/`）、発注文書とハンドオフ文書
- 秘密情報（API キー・トークン類。実行時は環境変数や各 CLI の認証を使います）

設計文書の中で参照している `BRIEF.md` や `logs/LEDGER.md` などはこのためリポジトリにありません。

## 取り下げ・問い合わせ

公開サイトの内容についての取り下げ依頼は、サイトのリポジトリの Issues（https://github.com/kokuren333/sfsh-site/issues ）で受け付けています。
