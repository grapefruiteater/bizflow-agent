# BizFlow 業務ツール基盤

## 現在の状態

`BizFlowAgentToolsStack`のCDKソース、Lambda処理、S3/DynamoDB adapter、ユニットテストは実装済みです。TypeScript型チェック、CDKテンプレートテスト、`--no-lookups`付きローカルsynthも成功しています。

このStackは2026-07-22にAWSへdeploy済みで、7つのOutputsはGit管理対象外の`config/tools-outputs.json`へ保存されています。現在稼働中のAgentCore Runtime VersionにはまだGateway URLを設定していないため、既存の`PROD` Endpointの動作は変わりません。Runtime接続ソースと直接スモークテストは追加済みですが、次のRuntime Versionを公開するまではAWS上で有効になりません。

CDKアプリでは`enableTools`の既定値を`false`にしています。次を明示した場合だけTools Stackをsynth対象に追加します。

```text
--context "enableTools=true"
```

既存RuntimeロールARNは、既定で`config/cdk-outputs.json`の`AgentRuntimeExecutionRoleArn`から自動取得します。別ファイルを使用する場合は`runtimeConfigPath`、CIなどでARNを直接渡す場合は`runtimeExecutionRoleArn` contextで上書きできます。

既存RuntimeロールはARNでimportします。Foundation Stackのconstructを直接参照せず、Tools StackにもFoundationへのdependencyを追加しません。このためTools Stackだけを指定したdiff/deployで、FoundationのIAM、ECR、Bedrock権限、Cross-Stack Exportが更新対象になることはありません。

## CDKで定義するリソース

| リソース | 目的 | 主な保護設定 |
|---|---|---|
| S3 Bucket | 合成`business_requests.csv`と`company_rules.md`を`portfolio-data/`へ配置 | Block Public Access、SSE-S3、TLS必須、versioning、削除時retain |
| DynamoDB Table | 承認、タスク、監査イベントを永続化 | On-demand、PITR、削除保護、暗号化、削除時retain |
| Read Lambda | 4つの読み取りツールを処理 | S3 `GetObject`、DynamoDB `GetItem`/`Query`のみ |
| Write Lambda | `create_business_task`だけを処理 | DynamoDB `GetItem`/`PutItem`/`Query`/`UpdateItem`のみ |
| AgentCore Gateway | LambdaをMCPツールとして公開 | IAM認証、MCP `2025-06-18`、2つのLambda target |
| Runtime IAM Policy | importした既存RuntimeロールからGatewayを呼び出す | 対象Gateway ARNへの`bedrock-agentcore:InvokeGateway`のみ |
| CloudWatch Logs | Lambdaログ | 30日保持、Log Groupは削除時retain |

S3への初期データ配置にはCDK Bucket Deploymentを使うため、deploy時には一時的なassetとcustom-resource Lambda、IAMロール、AWS CLI Layerも作成されます。`prune=false`により、更新時にprefix内の既存オブジェクトを自動削除しません。

## ツール境界

Read Lambdaで許可するツールは次の4つです。

- `get_business_requests`
- `analyze_request_data`
- `search_company_rules`
- `get_task_status`

Write Lambdaでは`create_business_task`だけを許可します。Gateway targetを分けるだけでなく、各関数の`BIZFLOW_ALLOWED_TOOLS`環境変数でも別targetのツール名を拒否し、IAM Policyでもデータ操作を分離します。

AgentCore GatewayのLambda targetは、呼び出すツール名をLambda contextの`bedrockAgentCoreToolName`へ設定します。handlerはtarget prefixを除いたツール名を検証してから処理を選択します。詳細は[AWS公式のLambda target手順](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html)を参照してください。

## DynamoDBデータモデル

Tableのpartition keyは`pk`、sort keyは`sk`です。

| エンティティ | `pk` | `sk` |
|---|---|---|
| 承認 | `APPROVAL#<approval_id>` | `APPROVAL` |
| 承認監査イベント | `APPROVAL#<approval_id>` | `EVENT#<ISO時刻>#<event_id>` |
| タスク | `TASK#<task_id>` | `TASK` |

承認対象の問い合わせID、担当者、期限、対応内容からhashを作り、書き込みLambdaで承認時のhashと再比較します。

- `PENDING`または`REJECTED`なら`APPROVAL_REQUIRED`
- 承認後に内容が変わった場合は`APPROVAL_MISMATCH`
- 同じ承認・同じ内容を再送した場合は既存タスクを返す
- 承認要求、承認／却下、登録、登録拒否を監査イベントへ記録する

承認要求と承認／却下を操作するWeb/BFF APIは次工程です。現時点でGatewayへ定義する5ツールには承認状態を変更するツールを含めません。

## Lambda adapterの選択

ローカル実行では、ファイルを読む`LocalFileDataRepository`とメモリ保持の`MockWorkflowStore`を使います。CDKで作成するLambdaには次の環境変数を設定し、S3/DynamoDB adapterへ自動で切り替えます。

| 環境変数 | 用途 |
|---|---|
| `BIZFLOW_DATA_BUCKET` | 合成データBucket名 |
| `BIZFLOW_REQUESTS_KEY` | CSV object key |
| `BIZFLOW_RULES_KEY` | Markdown object key |
| `BIZFLOW_WORKFLOW_TABLE` | DynamoDB Table名 |
| `BIZFLOW_ALLOWED_TOOLS` | 関数で許可するツール名のカンマ区切り一覧 |

AWSクライアントはこれらのAWS環境変数が設定された場合だけ遅延生成するため、ローカルテストはAWS認証やネットワーク接続を必要としません。

## CDK Outputs

Tools Stackは次を出力します。

- `BusinessDataBucketName`
- `WorkflowTableName`
- `BusinessToolsGatewayArn`
- `BusinessToolsGatewayId`
- `BusinessToolsGatewayUrl`
- `ReadToolsFunctionName`
- `WriteToolsFunctionName`

将来のRuntime接続とWeb/BFF構築では、値をソースコードへ埋め込まず、このOutputsまたは環境別設定から参照します。

## AWSへ接続しないローカル確認

リポジトリルートで次を実行します。

```powershell
npm run build
npm test
.\.venv\Scripts\python.exe -m pytest .\tests
npx cdk synth BizFlowAgentToolsStack `
  --context "environment=dev" `
  --context "enableTools=true" `
  --no-lookups
```

`cdk synth`はローカルでCloudFormation templateを生成するだけです。`--profile`は指定せず、AWS CLIやAWS APIも呼び出しません。

## AWSへ反映した手順と次工程

Tools Stackの初回反映では、対象Account、Region、作成リソース、費用、既存RuntimeロールへのIAM Policy追加を確認しました。次の1〜8は完了、9以降が次工程です。

1. IAM Identity Centerの対象SSO profileと`ap-northeast-1`を確認する。
2. `config/cdk-outputs.json`から`AgentRuntimeExecutionRoleArn`を取得する。
3. `BizFlowAgentToolsStack`だけを対象にCDK diffを取得する。
4. 差分がTools Stackだけであることを確認する。`BizFlowAgentFoundationStack`が依存Stackや変更対象として表示された場合は停止する。
5. S3、DynamoDB、2 Lambda、2 Gateway target、Gateway、ログ、Runtime roleへの`InvokeGateway`追加以外の差分がないことを確認する。
6. 差分をユーザーへ提示し、deployの明示承認を得る。
7. Tools Stackをdeployし、Outputsを`config/tools-outputs.json`へ保存する。
8. S3の2オブジェクト、DynamoDB設定、Lambda環境変数とIAM、Gateway target状態をAWSコンソールで確認する。
9. Gatewayの読み取りツールを直接スモークテストする。
10. Runtimeへはまず読み取りツールだけを接続し、新しいRuntime Versionを`READY`まで確認してから`PROD`へ昇格する。
11. Web/BFF承認APIを実装し、未承認拒否を確認してから書き込みツールを公開する。

新規環境で同じTools Stackを構築する場合のコマンド例です。

```powershell
$AwsProfile = "<SSOプロファイル名>"

npx cdk diff BizFlowAgentToolsStack `
  --context "environment=dev" `
  --context "enableTools=true" `
  --profile $AwsProfile

npx cdk deploy BizFlowAgentToolsStack `
  --context "environment=dev" `
  --context "enableTools=true" `
  --profile $AwsProfile `
  --outputs-file .\config\tools-outputs.json
```

通常のRuntimeコンテナ更新は引き続き`publish-agentcore.ps1`で行います。Tools Stackのdeployと、コンテナのbuild/push、`UpdateAgentRuntime`、`PROD` Endpoint更新は別の変更として扱います。

## Gateway直接スモークテスト

deploy済みGatewayのMCP初期化、`tools/list`、問い合わせ取得、決定的集計、社内ルール検索を次で確認します。IAM Identity CenterのSSO profileを明示し、root ARNは拒否します。`create_business_task`と`get_task_status`は呼び出しません。

```powershell
.\scripts\smoke-test-gateway.ps1 `
  -AWS_PROFILE <SSOプロファイル名> `
  -AWS_REGION ap-northeast-1 `
  -ToolsConfigPath .\config\tools-outputs.json
```

このスモークテストはAWSリソースを変更しませんが、STS、Gateway、Read Lambda、S3を実際に読み取ります。

## Runtimeへの読み取りツール接続

Runtimeは`BIZFLOW_GATEWAY_URL`が設定された場合だけGatewayへ接続します。MCP clientは全リクエストをservice名`bedrock-agentcore`でSigV4署名し、次の4ツールだけをモデルへ渡します。

- `get_business_requests`
- `analyze_request_data`
- `search_company_rules`
- `get_task_status`

`create_business_task`はMCP clientのallow-listで除外し、取得後にもRuntime側で再フィルタします。4ツールのいずれかが欠ける場合は、その呼び出しを失敗させて不完全なツール構成を黙って使用しません。

通常更新では次の2引数を追加します。Gateway URLは`config/tools-outputs.json`から読み込み、ソースやスクリプトへ固定しません。

```text
-EnableReadTools -ToolsConfigPath .\config\tools-outputs.json
```

## 公式資料

- [AgentCore Gateway Lambda target](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html)
- [AgentCore Gatewayの基本概念](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-core-concepts.html)
- [AgentCore GatewayをMCP clientから使用する](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using.html)
- [AgentCore GatewayのIAM認証](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-inbound-auth.html)
