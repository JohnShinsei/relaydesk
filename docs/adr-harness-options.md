# ADR: ネイティブ実行基盤への接続

状態: **方針決定・実装未着手** — 次の検証対象は Codex App Server の stdio 接続。第三者コードの部分再利用は未選定。確認日: 2026-10-12。

RelayDesk のプロジェクト整理、会話、タスク、メッセージ、承認画面、REST/SSE を残し、実行部分を薄い `EngineDriver` で接続する方針とする。新しいチャット製品への全面移行は行わない。Codex は公式 App Server を優先し、Claude は未改変の公式 CLI と本人による公式ログインの条件を確認する。ACP は後から交換できる接続方式として扱う。

現行の Codex CLI 0.162.1 / `gpt-6-astra` では、実応答、`turn.completed`、終了コード 0、HTTP/SSE への反映、再起動後の保存を確認済み。これは現在の制限付き `exec` 経路の結果であり、App Server、Claude、ACP、実際の微信、dot との接続を検証したものではない。実測の詳細は[検証記録](verification.md)を参照。

本比較に伴う第三者コード・ライブラリの導入は行っていない。実装済みの変更は公式 CLI のバージョン互換対応であり、以下の候補の調査を「統合済み」とは扱わない。

## 候補と今回の扱い

| 候補 | 確認できた接続面 | 今回の判断 |
|---|---|---|
| **Codex App Server** | 双方向 JSON-RPC、スレッドの開始・再開、ターンの中断、コマンド・ファイル変更の承認要求。 | 次の小さな実装で Mac 上の stdio 接続を検証する。CLI の制限設定をそのまま移せるとは仮定せず、採用バージョンの schema を確認する。[公式仕様](https://learn.chatgpt.com/docs/app-server) |
| **Happy CLI `cli-1.2.5`** | 旧 CLI の `codexAppServerClient.ts` に `thread/resume`、`turn/start`、`turn/interrupt` と承認コールバックがある。 | 実装の参考、または出典・著作権表示を保持した部分再利用の候補。新版の `happy-agent` とは別に評価する。まだ取り込んでいない。[対象ソース](https://github.com/slopus/happy/blob/cli-1.2.5/packages/happy-cli/src/codex/codexAppServerClient.ts)、[MIT](https://github.com/slopus/happy/blob/cli-1.2.5/LICENSE) |
| **ACP** | `session/new`・`session/prompt`・`session/update`・`session/request_permission`。履歴ロード等は能力の確認が必要。 | 将来の `EngineDriver` の交換先。プロトコルだけでは端末認証、VPS 転送、モデル利用資格は得られない。[セッション](https://agentclientprotocol.com/protocol/v1/session-setup)、[承認](https://agentclientprotocol.com/protocol/v1/tool-calls) |
| **HAPI `v0.30.7`** | React、Hub の SQLite、クライアント側 REST/SSE、CLI 側 Socket.IO。会話・承認・再開の API がある。 | 遠隔操作と復旧の参考候補。採用・インストール・コードコピーはしない。共通技術を使っていても RelayDesk とプロトコル互換ではない。[リリース](https://github.com/tiann/hapi/releases/tag/v0.30.7)、[構成](https://github.com/tiann/hapi/blob/v0.30.7/docs/guide/how-it-works.md)、[クライアント契約](https://github.com/tiann/hapi/blob/v0.30.7/docs/api/client-contract/index.md) |
| **CloudCLI / Claude Code UI `v1.37.4`** | 正式な公開リポジトリは `siteboon/claudecodeui`。Codex runtime は SDK の `startThread` / `resumeThread` / `runStreamed` を使い、exec では対話的な承認を処理できないと明記している。 | 今回必要なネイティブ承認の基盤にはしない。[runtime](https://github.com/siteboon/claudecodeui/blob/v1.37.4/server/modules/providers/list/codex/codex-runtime.provider.ts)、[依存関係](https://github.com/siteboon/claudecodeui/blob/v1.37.4/package.json) |

ACP の具体候補はコミュニティ実装の [`codex-acp v2.2.2`](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/README.md) と [`claude-agent-acp v0.89.1`](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.89.1/README.md)。前者は Codex App Server、後者は Claude Agent SDK を使用する。OpenAI / Anthropic が提供する公式 ACP アダプターとは表記しない。両者のライセンスは Apache-2.0。[Codex 側 LICENSE](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/LICENSE)、[Claude 側 LICENSE](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.89.1/LICENSE)

サンプルの安全方針は移植しない。特に `codex-acp` の [`simple-client`](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/examples/simple-client.ts) は `allow_once` を自動選択する。Happy の実行方針や `happy connect` による認証情報同期も今回の採用範囲に含めず、`never` と `danger-full-access` の組み合わせを承認付き実行の代用にしない。

## 既存コードを残せる範囲

| 対象 | 現在のファイル・インターフェース | 再利用と不足分 |
|---|---|---|
| 会話・メッセージ | [`Session` / `Message`](../shared/types.ts)、[`SessionStore`](../server/store.ts) | ローカル ID、本文、時刻、SQLite 保存を維持。現在はテキストのみで、ネイティブ会話 ID、ツール項目、添付の構造はない。 |
| タスク | [`TaskEngine`](../server/engine.ts) の `submit` / `cancel` / 状態遷移 | 一会話一実行、キャンセル待ち、保存失敗時の停止を維持。プロバイダーの終端イベントを共通状態へ変換する。 |
| 実行 | [`ExecutionAdapter.execute({ task, history, signal, emit })`](../shared/types.ts)、[`createAdapterRegistry`](../server/adapters.ts) | テキスト応答の橋渡しには使える。双方向承認にはイベント型と応答メソッドが必要。登録処理は現在 Codex 専用なので拡張する。 |
| 現行 Codex | [`createCodexAdapter`](../server/codex-adapter.ts)、[`server/index.ts`](../server/index.ts) | 固定した実行設定、時間・出力量の上限、診断の秘匿を参考にする。毎回 `exec --ephemeral` を起動し履歴を再送する方式で、ネイティブ会話の再開ではない。 |
| 承認 | [`Task.approval`](../shared/types.ts)、[`TaskEngine.approve`](../server/engine.ts) | 現在は `approval-demo` のみ。実 CLI の承認には使えず、実アダプターでは拒否される。 |
| REST/SSE・画面 | [`server/app.ts`](../server/app.ts)、[`client/App.tsx`](../client/App.tsx) | `/api/sessions`、タスク操作、会話の snapshot SSE と画面を維持。ネイティブイベントをサーバー側で変換する。現在の再接続は最新 snapshot の取得であり、外部イベントの再生処理ではない。 |
| プロジェクト・受信箱 | [`shared/inbox.ts`](../shared/inbox.ts)、[`InboxService`](../server/inbox.ts)、[`InboxStore`](../server/inbox-store.ts) | 原文を根拠にした複数プロジェクト関連付け、不可変の返信下書き、明示的な送信意図、冪等性、結果不明時の送信停止を維持。現在は固定の合成データで、汎用受信 API・AI 分類・実送信はない。 |

プロジェクトの型は現在、合成受信箱にある。AI 会話の `Session` / `Task` に `projectId` があると誤認しない。原文が複数プロジェクトに関わる関係を維持しつつ、実行先プロジェクトは別途明示する。

## 最小の追加境界: EngineDriver

以下は設計案であり、追加済みの API ではない。

1. **ID の対応表**: `projectId`、RelayDesk の `sessionId` / `taskId`、`driverId`、`machineId`、`vendorSessionId`、`vendorTurnId` を保存する。接続先と所有者も束縛し、別会話や別端末の ID を受け入れない。履歴の正本はネイティブ側、RelayDesk は表示用の写しとして扱う範囲を決める。
2. **開始・再開・イベント**: `start` / `resume` / `submit` / `subscribe` をドライバー内に置く。本文、ツール状態、承認要求、完了・失敗を型で分ける。外部イベント ID と接続世代を照合し、再接続時は状態を照会して重複反映を防ぐ。プロンプトは自動再送しない。
3. **一意な承認**: ローカル `approvalId` をネイティブの request ID・会話・ターン・項目 ID・操作内容・期限に結び付ける。認証された本人がプレビューした同じ操作へ `approve` / `deny` を返す。判断者、内容の版、時刻、判断、相手の解決通知を監査記録に残す。期限切れ・キャンセル・重複回答・再起動後の古い要求は許可せず、確認待ちが消えたことと操作成功を区別する。
4. **取消と結果不明**: `cancel` の送信と停止確認を分離する。Codex は対象ターンを中断し、その終端を待つ。共有 App Server を停止して別タスクを巻き込まない。時間切れや切断で停止を確認できなければ状態不明として隔離し、次の実行を止める。現行の `CodexStopUnconfirmedError` は汎用の終了結果へ置き換える。ACP でも取消通知だけでは完了せず、元の prompt 応答を確認する。[ACP の取消仕様](https://agentclientprotocol.com/protocol/v1/prompt-turn)

最初の変更は `server/index.ts` でのローカルドライバー生成、`server/adapters.ts` の登録、`shared/types.ts` と `TaskEngine` の必要最小限の拡張に限定する。既存の mock と制限付き exec は回帰確認用に残す。ブラウザーから実行ファイル、自由な CLI 引数、作業ディレクトリを指定する経路は追加しない。

受信箱は実行ドライバーから独立させる。将来の実送信では `MockInboxSender` の型・mock 限定ガード・模擬の送達確認を正式なコネクターに置き換える前に、アカウント／会話／メッセージのネイティブ ID による受信の正規化・重複排除と、提供元の送達証拠を実装する。分類、下書き作成、通常の会話は送信許可にならない。

## VPS とライセンスの境界

HAPI Hub はメッセージ本文を SQLite に保存する。`contentCodec.ts` は小さいデータを JSON テキスト、大きいデータを zstd 圧縮で保存する実装で、本文の暗号化ではない。Hub を VPS に置けば、その VPS は会話を読める信頼対象になる。通信の暗号化から「Hub は内容を見られない」とは結論できない。[保存実装](https://github.com/tiann/hapi/blob/v0.30.7/hub/src/store/contentCodec.ts)

Mac 上に実行と履歴を置き、自前の VPS を転送だけに使う案は引き続き検討する。TLS を終端する場所、端末認証、ログ、暗号化、バックアップと復旧を決めてから検証する。現在の `127.0.0.1`・Host/Origin 制限は遠隔利用の本人認証ではない。第三者トンネル、常駐サービス、公開ポートは本 ADR によって有効にならない。開発用 MacBook から将来の常用 Mac への移行も未検証。

RelayDesk 独自コードの [MIT](../LICENSE) は維持する。HAPI は [AGPL-3.0](https://github.com/tiann/hapi/blob/v0.30.7/LICENSE)、CloudCLI は [AGPL-3.0-or-later と追加条件](https://github.com/siteboon/claudecodeui/blob/v1.37.4/LICENSE)であり、MIT のコードとしてコピーしない。改変版の配布やネットワーク提供では該当条項を確認する。別プロセスの API 接続だから常に義務がなくなる、とも断定しない。Happy の部分再利用を行う場合も MIT の著作権・許諾表示を保持し、対象を別変更としてレビューする。

## 認証条件と次の検証

Codex の ChatGPT ログインと API キー課金は別経路であり、会員枠は汎用 API ではない。公式文書は既存のローカル／OSS アプリの app-server 認証継続に言及する一方、商用・ホスト型サービスへの利用を認めていない。そうした展開には正式な Sign in with ChatGPT の経路と適用条件を別途確認する。自前の VPS を挟むだけで条件を満たすとは扱わず、API キー課金への自動フォールバックもしない。[Codex 認証](https://learn.chatgpt.com/docs/auth)、[App Server 認証](https://learn.chatgpt.com/docs/app-server#auth-endpoints)

Claude は、未改変の公式バイナリを本人が公式フローで認証して使う条件と、第三者アプリが Agent SDK 経由で利用する条件を分ける。前者についても公式の提供条件を守り、資格情報を回収・転送しない。後者に Claude.ai ログインや会員枠を提供できると仮定しない。`--bare` は OAuth・キーチェーンを読まず、会員ログインを使う方法ではない。[Claude Code の条件](https://code.claude.com/docs/en/legal-and-compliance)、[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)、[bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)

次の独立した小ステップでは、Codex App Server での最小テキスト会話、承認要求の拒否と取消、切断後の照合と同じ会話への再開を、この順で限定した作業環境にて確認する。操作を実際に許可するテストは、対象と影響を示したうえで明示的に承認されたものだけに限る。許可待ちのタイムアウト、古い承認、重複イベント、保存失敗も検証対象とする。今回の CLI 成功から、これらの機能、Claude、微信の自動収集・返信、dot API、常時接続の信頼性まで確認済みとはしない。
