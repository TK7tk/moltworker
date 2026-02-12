# OpenClaw (Moltworker) セットアップ状況

## プロジェクト概要
OpenClaw（旧Clawdbot）を Cloudflare Workers 上にデプロイするプロジェクト。
LLM は Gemini API（無料枠）を OpenClaw のネイティブ `google` プロバイダー経由で使用。

**状態: 動作中（2026-02-11 完了）**

---

## 重要な教訓（トラブルシューティング知見）

### 教訓1: OpenClaw のプロバイダー選択は「ネイティブ優先」
**問題**: `openai-completions` アダプターでストリーミング時にレスポンスが消失する既知バグ（[openclaw/openclaw#9900](https://github.com/openclaw/openclaw/issues/9900)）。
agent run が ~200ms で完了し、実際のLLM APIコールが行われない/結果が破棄される。

**症状**: チャットUIでアシスタントが空メッセージを返す。`/debug/test-api`（Worker側直接テスト）は HTTP 200 で正常応答するのに、OpenClaw 経由だと空。

**解決策**: 利用するLLMプロバイダーに対応するネイティブプロバイダーがあればそちらを使う。
- Google Gemini → `google` プロバイダー + `GEMINI_API_KEY`（`openai-completions` は使わない）
- Anthropic → `anthropic-messages` アダプター
- OpenAI → `openai-completions`（OpenAI自身のAPIなら問題なし）

**調査方法**: `/debug/test-api` で Worker 側から直接API呼び出し → 成功なら API 自体は正常 → OpenClaw 内部のアダプターが原因。

### 教訓2: Gemini モデル名は `-preview` サフィックスが必要な場合がある
**問題**: `gemini-3-flash` は存在しない。正しくは `gemini-3-flash-preview`。

**症状**: HTTP 404 "models/gemini-3-flash is not found"

**調査方法**: `/debug/test-api` で HTTP ステータスを確認。404 = モデル名が間違い。
- [Google AI モデル一覧](https://ai.google.dev/gemini-api/docs/models) で正式名を確認
- `/debug/test-api?model=google-ai/正しいモデル名` でクエリパラメータ上書きテスト可能

### 教訓3: 推測で修正せず、まずログで証拠を集める
**失敗パターン**: 「AI Gatewayが悪いのでは」→ URLを変更 → 直らない → 「モデル名では」→ ...
**正しいアプローチ**:
1. `/debug/test-api` で Worker → LLM API を直接テスト（コンテナ不要）
2. HTTP ステータスで切り分け: 401=キー無効、404=モデル名不正、200=API正常
3. API正常なら OpenClaw 内部の問題 → `/debug/logs` でゲートウェイ stdout 確認
4. agent run の所要時間に注目: ~200ms = API未呼び出し、15-30秒 = 正常なLLMコール

### 教訓4: DO（Durable Object）はシングルスレッド
**問題**: `/api/status` が `listProcesses()` を頻繁にポーリング → DOの処理キューを占有 → バックグラウンドの `ensureMoltbotGateway()` がハング。

**解決策**: `/api/status` は DO にアクセスしない静的応答にする。ローディング画面は自動リロードで状態確認。

### 教訓5: sandbox名を変更すると新しいDOインスタンスが作られる
コンテナの状態がおかしい時は sandbox 名を変更して新しいコンテナを強制作成。
ただし古いコンテナが残るので "Maximum number of running container instances exceeded" エラーが出ることがある（数分で自動解消）。

---

## リサーチ方法論（AIツール連携のトラブルシューティング）

### なぜ間違えたか: 3つの失敗分析

#### 失敗1: モデル名の誤り（gemini-3-flash → gemini-3-flash-preview）
- **何が起きたか**: マーケティング名「Gemini 3 Flash」をそのまま API モデル ID として使用
- **なぜ間違えたか**: Google AI の API Reference を確認せず、直感で名前を推測した
- **正しいアプローチ**: [Google AI モデル一覧](https://ai.google.dev/gemini-api/docs/models) で正式な API モデル ID を確認してから設定する

#### 失敗2: AI Gateway URL の試行錯誤
- **何が起きたか**: AI Gateway の URL パスを何度も変更して試した（セッション2: 作業9-12）
- **なぜ間違えたか**: エラーを見て「URL が違うのでは」と推測 → パスを変更 → 直らない → また変更、のループ。Cloudflare の公式ドキュメントを確認せず手探りで進めた
- **正しいアプローチ**: AI Gateway のドキュメントで正しい URL 形式を確認し、1回で正しく設定する

#### 失敗3: openai-completions アダプターバグの発見遅延
- **何が起きたか**: LLM API は正常（`/debug/test-api` で確認）なのに、OpenClaw 経由だと空レスポンス。原因特定に長時間を要した
- **なぜ間違えたか**: OpenClaw の GitHub Issues やドキュメントを確認せず、インフラ側（AI Gateway、URL、トークン等）の問題だと思い込んでいた
- **正しいアプローチ**: `/debug/test-api` で API 正常と確認した時点で、問題を「OpenClaw 内部」に絞り込み、OpenClaw の Issues/Docs を調査すべきだった

### 根本原因: ボトムアップ vs トップダウン

**失敗パターン（ボトムアップ = 症状追い）**:
```
症状を見る → 推測で原因を考える → 修正を試す → 直らない → 別の推測 → ...
```
このアプローチは AI ツールのように変化が速く、暗黙の仕様が多い領域では特に非効率。

**正しいパターン（トップダウン = ドキュメント起点）**:
```
公式ドキュメントで正しい仕様を確認 → 現状との差分を特定 → ピンポイント修正
```

### リサーチソースの優先順位

| 優先度 | ソース | 確認すべき情報 | 例 |
|---|---|---|---|
| 1 | **API Reference** | 正式なパラメータ名、モデルID、URL形式 | Google AI docs, CF Workers API docs |
| 2 | **公式ドキュメント** | 設定方法、アーキテクチャ、既知の制約 | OpenClaw docs, Cloudflare docs |
| 3 | **GitHub Issues / Release Notes** | 既知バグ、破壊的変更、ワークアラウンド | openclaw/openclaw#9900 |
| 4 | **ブログ / フォーラム** | ユースケース、経験談 | — |
| 5 | **推測 / 試行錯誤** | 最終手段（上記で見つからない場合のみ） | — |

### このプロジェクトでの具体的なリサーチ先

| 対象 | リサーチ先 |
|---|---|
| Gemini モデル名・API仕様 | https://ai.google.dev/gemini-api/docs/models |
| OpenClaw プロバイダー設定 | https://docs.openclaw.ai/concepts/model-providers |
| OpenClaw 既知バグ | https://github.com/openclaw/openclaw/issues |
| CF Workers Containers | https://developers.cloudflare.com/containers/ |
| CF AI Gateway | https://developers.cloudflare.com/ai-gateway/ |
| CF Access | https://developers.cloudflare.com/cloudflare-one/policies/access/ |

---

## システム全体構成図

### 1. 全体俯瞰図

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          開発者 PC (Windows 11)                         │
│                                                                         │
│  ┌──────────────┐    git push     ┌──────────────────────────────────┐  │
│  │ ローカルリポ  │───────────────►│  GitHub (TK7tk/moltworker)       │  │
│  │ C:\Users\..   │                │  ├── main ブランチ               │  │
│  │ \moltworker   │                │  ├── .github/workflows/deploy.yml│  │
│  └──────┬───────┘                │  └──────────┬───────────────────┘  │
│         │                         │             │ workflow_dispatch    │
│         │ wrangler tail           │             │ (手動実行)           │
│         │ (ログ監視)              │             ▼                     │
│         │                         │  ┌──────────────────────────────┐  │
│         │                         │  │  GitHub Actions Runner       │  │
│         │                         │  │  1. checkout                 │  │
│         │                         │  │  2. npm ci                   │  │
│         │                         │  │  3. npm run deploy           │  │
│         │                         │  │     (wrangler deploy)        │  │
│         │                         │  └──────────┬───────────────────┘  │
│         │                         │             │ CLOUDFLARE_API_TOKEN │
│         │                         └─────────────┼──────────────────────┘
│         │                                       │
│  ブラウザ ──────────────────────────┐            │
└──────┼──────────────────────────────┼────────────┼──────────────────────┘
       │                              │            │
       ▼                              ▼            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge Network                                │
│                                                                          │
│  ┌────────────────────────┐     ┌─────────────────────────────────────┐  │
│  │  CF Access              │     │  Worker: moltbot-sandbox            │  │
│  │  (認証ゲートウェイ)      │     │  (wrangler deploy で更新)           │  │
│  │  ┌──────────────────┐  │     │                                     │  │
│  │  │ IdP連携           │  │ JWT │  ┌──────────┐  ┌───────────────┐   │  │
│  │  │ (Google/GitHub等) │──┼────►│  │ Worker   │  │ Durable Object│   │  │
│  │  └──────────────────┘  │     │  │ (Hono)   │─►│ (Sandbox DO)  │   │  │
│  │  Team: openclaw-taka   │     │  └──────────┘  └───────┬───────┘   │  │
│  └────────────────────────┘     │                        │           │  │
│                                  │                        ▼           │  │
│  ┌────────────────────────┐     │  ┌─────────────────────────────┐   │  │
│  │  R2 Bucket              │◄────┤  │  Sandbox Container          │   │  │
│  │  (moltbot-data)         │     │  │  (cloudflare/sandbox:0.7.0) │   │  │
│  │  永続ストレージ          │     │  │  OpenClaw Gateway :18789    │   │  │
│  └────────────────────────┘     │  └──────────┬──────────────────┘   │  │
│                                  │             │                      │  │
│                                  └─────────────┼──────────────────────┘  │
└───────────────────────────────────────────────┼─────────────────────────┘
                                                │
                                                ▼
                              ┌──────────────────────────────┐
                              │  Google AI API (ネイティブ)     │
                              │  OpenClaw google プロバイダー    │
                              │  → Gemini SDK 経由              │
                              │  モデル: gemini-3-flash-preview │
                              └──────────────────────────────┘
```

### 2. 環境変数の流れ

```
Cloudflare Dashboard                Worker env                Container env
(Secrets/Vars)                      (MoltbotEnv)              (start-openclaw.sh)
──────────────────                  ────────────              ──────────────────

MOLTBOT_GATEWAY_TOKEN ──────► env.MOLTBOT_GATEWAY_TOKEN
                                    │ buildEnvVars()
                                    ▼
                              OPENCLAW_GATEWAY_TOKEN ────► $OPENCLAW_GATEWAY_TOKEN
                                                           → --token で起動

CLOUDFLARE_AI_GATEWAY_API_KEY ──► env.CLOUDFLARE_AI_..
                                    │ buildEnvVars()
                                    ├──► CLOUDFLARE_AI_GATEWAY_API_KEY
                                    └──► GEMINI_API_KEY ───► $GEMINI_API_KEY
                                         (google-ai時のみ)    → onboard --auth-choice gemini-api-key
                                                               → ネイティブ google プロバイダーが使用

CF_AI_GATEWAY_MODEL ────────────► env.CF_AI_GATEWAY_MODEL
(google-ai/gemini-3-flash-preview)  │ buildEnvVars()
                                    ▼
                              CF_AI_GATEWAY_MODEL ───────► config パッチで解析:
                                                           gwProvider = "google-ai"
                                                           modelId = "gemini-3-flash-preview"
                                                           → google/gemini-3-flash-preview
                                                             (ネイティブプロバイダー)
```

---

## 環境情報
- Worker名: `moltbot-sandbox`
- Worker URL: `https://moltbot-sandbox.taka-nishida7.workers.dev/`
- Cloudflare Account ID: `4c43442890664e459f8639d66d7548f9`
- CF Access Team Domain: `openclaw-taka.cloudflareaccess.com`
- GitHub Fork: `https://github.com/TK7tk/moltworker`
- デプロイ方法: GitHub Actions（fork先リポジトリ、`Deploy` ワークフロー手動実行）
- LLM: Gemini API → OpenClaw ネイティブ `google` プロバイダー
- OpenClaw バージョン: `2026.2.9`
- Sandbox名: `moltbot-v7`（src/index.ts で定義）

## 設定済みシークレット一覧
| シークレット名 | 状態 | 備考 |
|---|---|---|
| MOLTBOT_GATEWAY_TOKEN | OK（length: 64） | コンテナに `OPENCLAW_GATEWAY_TOKEN` として渡す |
| CLOUDFLARE_AI_GATEWAY_API_KEY | OK | Gemini API キー（→ コンテナに `GEMINI_API_KEY` としても渡す） |
| CF_AI_GATEWAY_ACCOUNT_ID | OK | |
| CF_AI_GATEWAY_GATEWAY_ID | OK | `moltbot-sandbox` |
| CF_AI_GATEWAY_MODEL | OK | **`google-ai/gemini-3-flash-preview`**（`-preview` 必須） |
| CF_ACCOUNT_ID | OK | `4c43442890664e459f8639d66d7548f9` |
| CF_ACCESS_TEAM_DOMAIN | OK | `openclaw-taka.cloudflareaccess.com` |
| CF_ACCESS_AUD | OK | AUD タグ設定済み |
| R2_ACCESS_KEY_ID | OK | R2 API Token |
| R2_SECRET_ACCESS_KEY | OK | R2 Secret |
| DEBUG_ROUTES | OK | `true`（デバッグ用、本番では false にすること） |

---

## 認証設計
```
外部認証: CF Access が Worker レベルで認証（ブラウザ → Worker）
内部認証: MOLTBOT_GATEWAY_TOKEN → OPENCLAW_GATEWAY_TOKEN → gateway --token で起動
WS認証: Worker が WebSocket URL に ?token= を自動付与
UI認証: allowInsecureAuth=true でデバイスペアリング不要（CF Accessで保護済み）
```

## LLM接続設計
```
google-ai プロバイダの場合（現在の構成）:
  env.ts: CLOUDFLARE_AI_GATEWAY_API_KEY → GEMINI_API_KEY としてコンテナに渡す
  onboard: --auth-choice gemini-api-key --gemini-api-key $GEMINI_API_KEY
  config patch: agents.defaults.model.primary = "google/gemini-3-flash-preview"
  → OpenClaw のネイティブ google プロバイダーが Gemini SDK で直接通信
  → ストリーミングも正常に動作

  ※ openai-completions アダプタは使わない（#9900 バグで空レスポンスになる）

その他プロバイダ（anthropic, workers-ai, openai 等）:
  AI Gateway 経由: https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}
  api = "anthropic-messages" or "openai-completions"
```

---

## デバッグ方法
| エンドポイント | 用途 |
|---|---|
| `wrangler tail --format pretty` | Worker/DOレベルのリアルタイムログ、WS通信内容 |
| `/debug/test-api` | **Worker側から直接LLM APIテスト**（コンテナ不要、最重要） |
| `/debug/test-api?model=provider/model` | 別モデル名でのテスト |
| `/debug/test-llm` | コンテナ内から直接LLM APIテスト |
| `/debug/container-config` | コンテナ内の openclaw.json 設定確認 |
| `/debug/logs` | ゲートウェイプロセスの stdout/stderr |
| `/debug/cli?cmd=...` | コンテナ内で任意コマンド実行 |
| `/debug/processes?logs=true` | 全プロセス一覧 + ログ |
| AI Gateway ダッシュボード | LLM API リクエスト数、トークン使用量、エラー |

### 空レスポンスのデバッグ手順
1. `/debug/test-api` → HTTP 200 + 応答あり = API自体は正常
2. `/debug/logs` → agent run の所要時間確認: ~200ms = API未呼び出し（OpenClaw内部問題）
3. `/debug/container-config` → プロバイダー設定確認
4. OpenClaw GitHub Issues で既知バグを検索

---

## 作業履歴

### 2026-02-09 セッション1: 初期デバッグ
| # | 作業 | 結果 | コミット |
|---|---|---|---|
| 1 | テスト修正（env.test.ts） | 全84テスト通過 | `d0195b7` |
| 2 | R2復元設定から古いトークン削除 | 効果不明（GW未起動） | `8850387` |
| 3 | sandbox名変更（moltbot→v2）でコンテナ再作成 | プロセス138→13に減少、GW依然未起動 | `9d45802` |
| 4 | /api/status の DOデッドロック解消（v1） | 効果なし | `173833b` |

### 2026-02-11 セッション2: ゲートウェイ起動〜AI Gateway調整
| # | 作業 | 結果 | コミット |
|---|---|---|---|
| 5 | waitUntil タイムアウト修正（startGatewayBackground） | GW起動成功 | `83f857d` |
| 6 | --bind lan トークン認証復元 | HTTP 200、WS 接続成功 | `83f857d` |
| 7 | デバイスペアリング（/_admin/ から手動） | チャットUI利用可能に | — |
| 8 | LLM空応答の調査 | AI Gateway ID が無効と判明 | — |
| 9-12 | AI Gateway URL 修正試行 | LLM依然空応答（AI Gateway 経由は不安定） | 複数 |
| 13 | DOデッドロック完全解消 | ローディング画面ハング解消 | `aae9840` |
| 14 | AI Gateway 迂回、Google 直接エンドポイント使用 | config は正しいが LLM 依然空応答 | `2403d56` |

### 2026-02-11 セッション3: 根本原因特定〜完全解決
| # | 作業 | 結果 | コミット |
|---|---|---|---|
| 15 | `/debug/test-api` エンドポイント追加 | Worker側から直接API呼び出しテスト可能に | `156f334` |
| 16 | `/debug/test-api` でモデル名テスト | HTTP 404: `gemini-3-flash` は存在しない | — |
| 17 | モデル名を `gemini-3-flash-preview` に修正 | HTTP 200、API応答確認 | — |
| 18 | CF_AI_GATEWAY_MODEL シークレット更新 | Worker側テスト正常 | — |
| 19 | `/debug/logs` で agent run 分析 | **198ms で完了 = API未呼び出し**（openai-completions バグ） | — |
| 20 | OpenClaw #9900 発見、ネイティブ google プロバイダーに切替 | **チャット応答成功！** | `583bbdd` |

### 解決済み問題と根本原因
| 問題 | 根本原因 | 解決策 |
|---|---|---|
| ローディング画面で永久停止 | `waitUntil()` 30秒タイムアウト + DOデッドロック | `startGatewayBackground` + `/api/status` 静的応答 |
| WS 1008 エラー | `--bind lan` でトークン認証が必須 | Worker が `?token=` を自動付与 |
| NOT_PAIRED エラー | デバイスペアリング必須 | `allowInsecureAuth=true`（CF Access で保護済み） |
| LLM HTTP 404 | モデル名 `gemini-3-flash` が不正 | `gemini-3-flash-preview` に修正 |
| **LLM空応答（根本原因）** | **`openai-completions` ストリーミングバグ (#9900)** | **ネイティブ `google` プロバイダーに切替** |

---

## セキュリティ対応状況

### 完了済み（2026-02-11 コミット 332d83b）
- [x] `DEBUG_ROUTES` を `false` に変更（ダッシュボードで設定済み）
- [x] 毎リクエストの診断ログ削除（トークン長・シークレット有無の漏洩防止）
- [x] Hono 脆弱性修正（4.11.6 → 4.11.9、CVE 4件解消）
- [x] `requestId` コマンドインジェクション修正（英数字+`-_`のみ許可）
- [x] デバッグレスポンスヘッダー削除（`X-Worker-Debug`, `X-Debug-Path`）

### 対応不要と判断（調査済み）
- [x] ~~WebSocket トークンのクエリパラメータ~~ → Worker→コンテナ間の内部通信のみで使用。外部ユーザーに露出しないため実質安全。OpenClaw は WS の HTTP ヘッダー認証に非対応（公式は connect フレームペイロード方式）
- [x] `timingSafeEqual` の長さチェック修正 → コミット `e95befe` で対応済み

### 対応不要と判断（調査済み・続き）
- [x] ~~Gemini API キーのローテーション~~ → CF Access ポリシー「Allow Me」（Include: 1）で本人のみアクセス可。第三者の閲覧なし。DEBUG_ROUTES=false で今後の露出もなし

### 完了済み（2026-02-12）
- [x] レートリミット追加（`/_admin/*`: 20 req/min、`/debug/*`: 10 req/min、`src/middleware/rate-limit.ts`）
- [x] `allowInsecureAuth` を条件分岐（CF Access 設定済み or ゲートウェイトークン設定時のみ `true`、`src/gateway/env.ts` + `start-openclaw.sh`）

### 未対応（手動操作が必要）

#### R2 バケットのアクセス権限を最小限に設定
現在の `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` のスコープを確認し、最小権限に設定する。

**最小要件:**
- **Permission**: Object Read & Write
- **Scope**: `moltbot-data` バケットのみ（Specific bucket）
- **不要な権限**: Admin、List All Buckets、Delete（sync は additive のみ）

**手順（Cloudflare Dashboard）:**
1. Dashboard > R2 Object Storage > Manage R2 API Tokens
2. 既存トークンを確認し、スコープが広すぎる場合は新規作成:
   - Token name: `moltbot-r2-readwrite`
   - Permissions: `Object Read & Write`
   - Specify bucket: `moltbot-data`
3. 新トークンの Access Key ID / Secret Access Key を取得
4. Dashboard > Workers & Pages > moltbot-sandbox > Settings > Variables and Secrets
   - `R2_ACCESS_KEY_ID` を新しい値に更新
   - `R2_SECRET_ACCESS_KEY` を新しい値に更新
5. デプロイ後、R2 バックアップ（5分 cron）が正常動作するか確認

#### GitHub リポジトリを private にする
**手順:**
1. https://github.com/TK7tk/moltworker > Settings > General
2. Danger Zone > Change repository visibility > Make private
3. GitHub Actions の Deploy ワークフローは `CLOUDFLARE_API_TOKEN` シークレットを使用するため、private リポジトリでもそのまま動作する

---

## 基本設定 TODO

### チャンネル連携
- [ ] Discord 連携（`DISCORD_BOT_TOKEN` 設定、Discord Developer Portal でボット作成）
- [ ] Telegram 連携（`TELEGRAM_BOT_TOKEN` 設定、BotFather でボット作成）
- [ ] Slack 連携（`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` 設定、Slack App 作成）

### スキル設定
- [ ] カスタムスキルの追加（`skills/` ディレクトリに配置 → Dockerfile でコンテナにコピー）
- [ ] 現在は `cloudflare-browser` スキルのみ
- [ ] OpenClaw 公式スキルマーケットから追加検討（https://docs.openclaw.ai/skills）

### ワークスペースカスタマイズ
- [ ] `IDENTITY.md` 設定（ボットの名前・性格・役割の定義）
- [ ] `USER.md` 設定（ユーザー情報、ボットに知っておいてほしいこと）
- [ ] `MEMORY.md` 設定（ボットの長期記憶の初期データ）
- [ ] 上記ファイルは `/root/clawd/` に配置、R2 バックアップで永続化

### LLM / モデル設定
- [ ] モデル変更検討（現在: `gemini-3-flash-preview`、上位モデルや別プロバイダー）
- [ ] AI Gateway 経由のログ・分析活用（トークン使用量の監視）
- [ ] コスト最適化（`SANDBOX_SLEEP_AFTER` でコンテナ自動スリープ設定）

### 運用
- [ ] R2 バックアップの動作確認（5分ごとの cron sync が正常か）
- [ ] GitHub リポジトリを private に変更
- [ ] CDP（ブラウザ自動化）の設定（`CDP_SECRET` + `WORKER_URL`）

---

## デプロイ手順
```bash
# 1. git push origin main
# 2. GitHub Actions → Deploy → Run workflow（手動実行、workflow_dispatch）
# 3. Test ワークフローのE2E失敗は上流テスト起因 → 無視可

# wrangler tail でリアルタイムログ確認（CF Accessの影響を受けない）
npx wrangler tail --format pretty

# ブラウザアクセス時の注意
# - CF Access 認証が必要（初回はログイン画面が出る）
# - curl ではCF Accessにブロックされる → ブラウザ経由でのみ確認可能
```

## ローカルリポジトリ注意事項
- リモート origin は `https://github.com/TK7tk/moltworker.git`（フォーク先）
- `.gitignore` 等の一部ファイルがフォーク側で削除されている（unstaged deleted として表示される）
- `node_modules/` と `.claude/` は未追跡（コミット不要）
- gh CLI 未インストール（GitHub Actions の確認はブラウザで実施）

## 参考
- [OpenClaw Issue #9900: openai-completions 空レスポンスバグ](https://github.com/openclaw/openclaw/issues/9900)
- [OpenClaw Model Providers ドキュメント](https://docs.openclaw.ai/concepts/model-providers)
- [Google AI Gemini モデル一覧](https://ai.google.dev/gemini-api/docs/models)
- [Google AI OpenAI互換エンドポイント](https://ai.google.dev/gemini-api/docs/openai)
