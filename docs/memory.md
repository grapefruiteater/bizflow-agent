# AgentCore Memory

## 現在の状態

AgentCore Memoryを使った同一Runtimeセッション内の短期会話記憶について、Runtimeソース、専用CDK Stack、公開設定、自動スモークテスト、ローカルテストを実装済みです。2026-07-22に`BizFlowAgentMemoryStack`をAWSへdeployし、30日保持のMemory、service role、Runtime用最小権限、Outputsの作成を確認しました。Runtime Version 5へのMemory接続はまだ行っていません。

現在は短期Memoryだけを使用し、長期Memory strategyは作成しません。Cognitoによる信頼済み利用者IDがない段階で、リクエスト本文の`actor_id`や`session_id`を信用して別セッションの記憶を取得しないためです。

## セキュリティ境界

- Memoryの`sessionId`には、AgentCoreがHTTPヘッダー`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`で渡した値だけを使用する。
- リクエストJSON本文の`session_id`、`actor_id`、`context`はMemoryの識別子に使用しない。
- Cognito導入前の`actorId`は`bizflow-session/<Runtime session ID>`とし、セッションをまたぐ共有を禁止する。
- 過去の会話は信頼されないデータとして現在の依頼と分離し、履歴内の命令へ従わないようモデルへ明示する。
- 最大5ターン、合計12,000文字までをモデルへ渡す。
- 保存する利用者メッセージと応答はそれぞれ最大8,000文字に制限する。
- Memory障害時は業務分析を継続し、応答の`memory.degraded=true`とCloudWatch Logsで通知する。
- Runtimeロールには対象Memory ARNへの`CreateEvent`と`ListEvents`だけを許可する。
- `DeleteEvent`、長期Memory取得、Memory管理権限はRuntimeへ許可しない。

## 処理フロー

```text
POST /invocations + Runtime session ID header
  ↓
AgentCore Memory / ListEvents
  ↓ 最大5ターンの短期履歴
現在の依頼と分離してStrands Agentへ渡す
  ↓
Gateway・Code Interpreter・Nova 2 Liteによる読み取り専用分析
  ↓
AgentCore Memory / CreateEvent
  ├─ USER: 元の依頼だけを保存
  └─ ASSISTANT: 最終応答を保存
```

構造化`business_data`の全内容や、モデルへ渡した内部プロンプトは保存しません。元の利用者依頼と最終応答だけを会話イベントとして保存します。

`CreateEvent`には`extractionMode=SKIP`を指定します。イベントは短期Memoryへ保存されますが、長期Memory抽出は行いません。

## AWSリソース

`BizFlowAgentMemoryStack`は次を作成します。

- `BizFlowMemory_<environment>`というAgentCore Memory
- 短期イベント保持期間30日
- Memory service role
- 既存Runtime実行ロールへ付ける対象Memory限定IAM Policy
- `AgentMemoryId`、`AgentMemoryArn`、`AgentMemoryEventExpiryDays` Outputs

Memoryには`RETAIN` RemovalPolicyを設定します。Stack削除時も会話イベントを含むMemoryを自動削除しません。

Tools StackやFoundation StackへのCloudFormation依存は作りません。既存RuntimeロールARNは`config/cdk-outputs.json`から読み込み、Memory Stack内でimportします。

## Runtime設定

Memory StackのOutputsはGit管理対象外の`config/memory-outputs.json`へ保存します。公開時に次を指定します。

```text
-EnableMemory
-MemoryConfigPath .\config\memory-outputs.json
```

公開スクリプトはMemory ARNのAccountとRegionをECRおよび`AWS_REGION`と照合し、正常な場合だけ次のRuntime環境変数を追加します。

```text
BIZFLOW_MEMORY_ID=<AgentMemoryId>
```

各応答にはMemory有効時だけ次の状態を追加します。

```json
{
  "memory": {
    "enabled": true,
    "session_available": true,
    "context_turns": 1,
    "event_stored": true,
    "degraded": false
  }
}
```

`write_operations_performed=false`は業務システムへの書き込みがないことを表します。短期会話イベントの保存有無は`memory.event_stored`で別に報告します。

## AWS反映順序

1. 完了: ソース、文書、ローカルテストを実装する。
2. 完了: `BizFlowAgentMemoryStack`のCDK diffを確認する。
3. 完了: Memory Stackをdeployし、Outputsを`config/memory-outputs.json`へ保存する。
4. 次工程: 変更をGitへコミットし、worktreeをcleanにする。
5. `publish-agentcore.ps1`を`-EnableReadTools -EnableCodeInterpreter -EnableMemory`付きでdry-runする。
6. `-Execute`で新Runtime Versionを作成する。
7. `READY`後、表示された新バージョン番号を入力して`PROD`を切り替える。
8. 同じRuntime session IDを使う2ターンスモークテストで保存と再取得を確認する。
9. CloudWatch Logsとデプロイ記録を確認する。

差分確認ではMemory Stackだけを指定します。

```powershell
$AwsProfile = "<SSOプロファイル名>"

npx cdk diff BizFlowAgentMemoryStack `
  --context "environment=dev" `
  --context "enableMemory=true" `
  --profile $AwsProfile
```

期待する差分は、新しいMemory、Memory service role、既存Runtimeロールへ付ける`UseBizFlowShortTermMemory` Policy、3 Outputsです。Foundation、Runtime、Tools、ECR、Endpoint、既存Cross-Stack Exportの変更が表示された場合はdeployしません。

差分確認後、ユーザーの明示判断で次を実行します。

```powershell
npx cdk deploy BizFlowAgentMemoryStack `
  --context "environment=dev" `
  --context "enableMemory=true" `
  --profile $AwsProfile `
  --outputs-file .\config\memory-outputs.json
```

Memory Stackは既存RuntimeロールARNを`config/cdk-outputs.json`から読み取ります。Runtime StackをCDKアプリへ含める`agentImageDigest`は不要で、通常RuntimeやEndpointを更新しません。

## 自動スモークテスト

公開スクリプトはMemory有効時に次を自動実行します。

1. ランダムなRuntime session IDを1つ作る。
2. 1回目の呼び出しでGit SHAとRuntime Versionを含む検証markerを記憶させる。
3. 応答が`memory.event_stored=true`かつ`degraded=false`であることを確認する。
4. 同じsession IDの2回目の呼び出しではmarkerをプロンプトへ含めず、前のmarkerを回答させる。
5. `memory.context_turns>=1`かつ応答内のmarkerが完全一致することを確認する。

成功時、デプロイ記録は次を含みます。

```json
{
  "memoryEnabled": true,
  "memorySmokeTest": "PASSED"
}
```

CloudWatch Logsでは次を確認できます。

```text
Loading short-term memory session_id=...
Loaded short-term memory session_id=... turns=1
Saving short-term memory session_id=...
Short-term memory saved session_id=...
```

## ローカル検証

```powershell
.\.venv\Scripts\python.exe -m pytest .\tests\runtime\test_conversation_memory.py -q
npm run build
npm test -- --runInBand
```

Pythonテストはfake Memory client、CDKテストはCloudFormation template assertionsを使うためAWS APIを呼び出しません。

## 今後の拡張

現在はポートフォリオの会話継続を安全に示す最小構成です。CognitoとBFFで利用者と会社を認証できた後、次を追加します。

- Cognito `sub`と会社IDから信頼済み`actorId`を生成する。
- user preferenceまたはsemantic strategyを追加する。
- `/actors/{actorId}/`で終わるnamespaceを使い、利用者間の長期Memoryを分離する。
- 保存対象、保持期間、削除要求、監査手順を画面と運用へ追加する。

## AWS公式資料

- [AgentCore Memoryを始める](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-get-started.html)
- [短期MemoryのCreateEvent](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/short-term-create-event.html)
- [短期MemoryのListEvents](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/short-term-list-events.html)
- [Memoryのactor・session構成](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-organization.html)
- [AWS CDK MemoryProps](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore.MemoryProps.html)
