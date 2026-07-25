# AgentCore Memory

## 現在の状態

同一Runtime session内の短期会話MemoryはAWSへ反映済みで、2ターンの保存・再取得まで確認済みです。

次の更新として、Cognitoで認証した利用者ごとの長期設定Memoryをローカル実装しました。Runtime、BFF、CDK、PowerShell、テストの変更は完了していますが、User Preference strategy、Runtime更新、Web更新はまだAWSへ反映していません。

| 機能 | 状態 |
|---|---|
| session単位の短期会話 | AWSで検証済み |
| Cognito利用者の信頼境界 | ローカル実装・検証済み |
| User Preference strategy | CDK差分確認前 |
| Runtimeの長期Memory取得・抽出 | ローカル実装・検証済み |
| Webからの利用者別E2E | AWS反映後に確認 |

## IDと権限の境界

Web利用時の識別子は次の経路で決めます。

```text
Cognito access token + ALB identity
  ↓ BFFで署名、User Pool、app client、sub一致を検証
cognito:<sub>
  ↓ SHA-256（生のsubはRuntimeへ渡さない）
bizflow-user-<64桁hex>
  ↓ InvokeAgentRuntime.runtimeUserId
X-Amzn-Bedrock-AgentCore-Runtime-User-Id
  ↓
AgentCore Memory actorId
```

- JSON本文の`actor_id`、`user_id`、`session_id`は識別子として信用しません。
- BFFだけに`InvokeAgentRuntimeForUser`を追加します。通常の`InvokeAgentRuntime`も引き続き必要です。
- Runtimeは`bizflow-user-<64桁hex>`以外のuser IDを`422`で拒否します。
- Runtime応答やログへ生のCognito `sub`、ハッシュ済みuser IDを出力しません。
- Web以外の直接呼び出しでuser IDがない場合は、`bizflow-session/<Runtime session ID>`をactorにする従来の短期Memoryへ戻ります。この経路では長期抽出を`SKIP`します。

これは、Cognitoを検証するBFFが利用者IDをAgentCoreへ委任する構成です。AgentCore Runtime自身がCognito tokenを再検証する構成ではありません。

## 短期Memoryと長期Memory

### 短期会話

- `sessionId`: AgentCoreのRuntime session IDヘッダー
- `actorId`: Webではハッシュ済み利用者ID、直接呼び出しではsession限定actor
- 最大5ターン
- モデルへ渡す履歴は合計12,000文字まで
- 保存する利用者メッセージと応答は各8,000文字まで

### 長期利用者設定

- strategy: `USER_PREFERENCE`
- namespace template: `/users/{actorId}/preferences/`
- 取得件数: 最大3件
- 1件2,000文字、合計4,000文字まで
- 取得した内容は信頼されない参考情報として現在の依頼と分離
- 検索queryには現在の依頼を使用

認証済みWeb呼び出しの`CreateEvent`では`extractionMode`を省略し、User Preference strategyによる非同期抽出を有効にします。user IDがない直接呼び出しでは`extractionMode=SKIP`を指定します。

抽出は非同期で、保存直後には検索できないことがあります。また、strategyが`ACTIVE`になる前の既存イベントは自動抽出されません。

会社共有Memoryはまだ追加しません。現在のCognito tokenには信頼できるtenant/company claimがないためです。将来`custom:tenant_id`などを検証できるようになってから、利用者namespaceとは別のIAM条件とnamespaceで設計します。

## Runtime処理

```text
POST /invocations
  + Runtime session ID
  + optional Runtime user ID
  ↓
ListEvents(actorId, sessionId)
  + user IDがある場合だけRetrieveMemoryRecords
  ↓
<short_term_memory> と <long_term_user_preferences> に分離
  ↓
現在の依頼とともに読み取り専用Agentへ渡す
  ↓
CreateEvent
  ├─ trusted user: 長期抽出を有効化
  └─ session fallback: extractionMode=SKIP
```

Memory障害時は業務分析を継続し、`memory.degraded=true`を返します。構造化`business_data`全体や内部プロンプトは保存せず、元の利用者依頼と最終応答だけをイベントへ保存します。

Runtime応答の例です。

```json
{
  "memory": {
    "enabled": true,
    "session_available": true,
    "user_scoped": true,
    "context_turns": 1,
    "preference_records": 2,
    "long_term_extraction_enabled": true,
    "event_stored": true,
    "degraded": false
  }
}
```

## Memory Stackの変更

`BizFlowAgentMemoryStack`は既存Memoryを維持したまま、次を追加・更新します。

- `BizFlowUserPreference` strategy
- `/users/{actorId}/preferences/` namespace template
- Runtimeロールの`RetrieveMemoryRecords`
- `bedrock-agentcore:namespace=/users/*/preferences/`というIAM条件
- namespace templateとstrategy typeのOutputs

`CreateEvent`と`ListEvents`は対象Memory ARNだけに限定します。`DeleteEvent`、`DeleteMemoryRecord`、`UpdateMemoryRecord`、Memory管理権限はRuntimeへ付与しません。Memoryには`RETAIN` RemovalPolicyを維持します。

Outputsは次の形式になります。

```json
{
  "AgentMemoryId": "BizFlowMemory_dev-...",
  "AgentMemoryArn": "arn:aws:bedrock-agentcore:...",
  "AgentMemoryEventExpiryDays": "30",
  "AgentMemoryUserPreferenceNamespaceTemplate": "/users/{actorId}/preferences/",
  "AgentMemoryLongTermStrategyType": "USER_PREFERENCE"
}
```

公開スクリプトは新しい2つのOutputも検証し、Runtimeへ次を設定します。

```text
BIZFLOW_MEMORY_ID=<AgentMemoryId>
BIZFLOW_MEMORY_USER_PREFERENCE_NAMESPACE_TEMPLATE=/users/{actorId}/preferences/
```

## ローカル検証

AWSへ接続しないテストです。

```powershell
.\.venv\Scripts\python.exe -m pytest .\tests\runtime -q
npm test -- --runInBand
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
```

`tests/runtime/test_conversation_memory.py`では、利用者namespace分離、取得件数と文字数制限、未検証IDの拒否、user有無による長期抽出の切り替えをfake clientで確認します。

## AWS反映順序

以下はユーザーが差分を確認して実行する手順です。自動では実行しません。

### 1. Memory Stack

```powershell
$AwsProfile = "<SSOプロファイル名>"

npx cdk diff BizFlowAgentMemoryStack `
  --context "environment=dev" `
  --context "enableMemory=true" `
  --context "runtimeConfigPath=config/cdk-outputs.json" `
  --profile $AwsProfile
```

期待する主な差分は、既存Memoryへの`UserPreferenceMemoryStrategy`追加、Runtime IAM Policyへのnamespace限定`RetrieveMemoryRecords`追加、2つのOutput追加です。Memoryの置換、Foundation/Runtime/Toolsの変更、既存リソース削除が表示された場合はdeployしません。

差分が期待どおりなら、明示判断後にMemory Stackだけを更新します。

```powershell
npx cdk deploy BizFlowAgentMemoryStack `
  --context "environment=dev" `
  --context "enableMemory=true" `
  --context "runtimeConfigPath=config/cdk-outputs.json" `
  --profile $AwsProfile `
  --outputs-file .\config\memory-outputs.json
```

コンソールでMemoryと`BizFlowUserPreference` strategyが`ACTIVE`になったことを確認してから次へ進みます。

### 2. Runtime

変更をGitへcommitしてworktreeをcleanにした後、まずdry-runします。

```powershell
.\scripts\publish-agentcore.ps1 `
  -AWS_PROFILE $AwsProfile `
  -AWS_REGION ap-northeast-1 `
  -ModelId jp.amazon.nova-2-lite-v1:0 `
  -ConfigPath .\config\cdk-outputs.json `
  -StackName BizFlowAgentRuntimeStack `
  -EnableReadTools `
  -ToolsConfigPath .\config\tools-outputs.json `
  -EnableCodeInterpreter `
  -EnableMemory `
  -MemoryConfigPath .\config\memory-outputs.json
```

dry-runでMemory ID、`USER_PREFERENCE`、namespace templateが表示されることを確認します。問題がなければ、同じコマンドへ`-Execute`を追加し、Runtimeが`READY`になった後だけ`PROD`を更新します。

公開時の自動Memoryテストは、user IDを渡さない従来のsession内2ターンテストです。これにより直接呼び出しのfallbackを確認します。長期抽出は非同期なので、Web E2Eで別に確認します。

### 3. Web Service

新しいWebイメージを同じGit SHAでARM64 build/pushし、digestを取得します。そのdigestでService差分を確認します。

```powershell
npx cdk diff BizFlowWebServiceStack `
  --context "environment=dev" `
  --context "enableWebService=true" `
  --context "webImageDigest=$WebImageDigest" `
  --context "webFoundationConfigPath=config/web-foundation-outputs.json" `
  --context "runtimeConfigPath=config/cdk-outputs.json" `
  --context "toolsConfigPath=config/tools-outputs.json" `
  --profile $AwsProfile
```

期待する差分は、Web Task Roleへの`InvokeAgentRuntimeForUser`追加と、新しいdigestを使うTask Definition/Service更新です。権限のResourceは既存Runtime ARNと`PROD` Endpoint ARNだけで、`*`にしません。

### 4. Web E2E

1. Cognito利用者でログインする。
2. 「今後の回答は日本語を優先してください」のように明示的な設定を伝えて分析する。
3. 応答の表示が`設定 0件`でも、`event_stored=true`相当なら最初の保存は成功です。
4. strategyの非同期抽出を待つ。
5. ブラウザ開発者ツールで次を実行し、同じ利用者の新しいconversation IDへ切り替える。

```javascript
localStorage.removeItem("bizflow-conversation-id");
location.reload();
```

6. 「私の回答言語の設定を教えてください」と依頼する。
7. 画面が`設定 1件`以上を表示し、日本語優先を回答することを確認する。
8. CloudWatch Logsで`user_scoped=True`、`extraction=ENABLED`、`preferences=1`以上を確認する。ログへuser ID自体が出ていないことも確認する。
9. 別のCognito利用者では同じ設定を取得できないことを確認する。

長期MemoryだけをCLIで確認する場合、`smoke-test-agentcore.ps1`は`-RuntimeUserId bizflow-user-<64桁hex> -RequireMemory`を受け取れます。ただし、この値は任意に作らず、BFFと同じ導出規則で作った検証用IDだけを使います。

## AWS公式資料

- [InvokeAgentRuntime API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html)
- [Runtime security best practices](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html)
- [Long-term Memoryを有効化する](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-enabling-long-term-memory.html)
- [長期Memoryの保存と取得](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-saving-and-retrieving-insights.html)
- [Memoryのactor・session・namespace構成](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-organization.html)
