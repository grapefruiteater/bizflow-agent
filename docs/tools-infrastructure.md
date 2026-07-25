# BizFlow 業務ツール基盤

## 現在の状態

`BizFlowAgentToolsStack`のCDKソース、Lambda処理、S3/DynamoDB adapter、ユニットテストは実装済みです。TypeScript型チェック、CDKテンプレートテスト、`--no-lookups`付きローカルsynthも成功しています。

S3、DynamoDB、読み取り／書き込みLambda、Gatewayは2026-07-22にAWSへdeploy済みで、環境別OutputsはGit管理対象外の`config/tools-outputs.json`へ保存されています。AgentCore Runtime Version 8にはGateway URLが設定され、`PROD` Endpointから4つの読み取りツールを利用できます。Gateway直接スモークテスト、Runtimeスモークテスト、CloudWatch Logsへの出力を確認済みです。

タスク登録はWeb/BFFからWrite Lambdaを直接呼び出す経路だけを使用します。Gateway経由の書き込みをLambdaでも拒否し、既存Write targetのDeletionPolicyを`Delete`へ変える第1段階はAWSへ反映・検証済みです。第2段階としてWrite targetとGateway用書き込みschemaをローカルソースから削除済みで、次のTools Stack更新後はGatewayの`tools/list`が読み取り専用4ツールだけになります。

Web BFFだけが呼び出す承認バックエンドLambdaもAWSへdeploy済みです。Outputsは9つとなり、`ApprovalWorkflowFunctionName`と`ApprovalWorkflowFunctionArn`が追加されています。承認要求・承認・DynamoDB監査履歴の実環境テストも完了しています。2026-07-24には、Next.js BFFからRead/Write Lambdaを直接呼び出す専用envelopeをTools Stackへ反映し、Web Serviceから分析、承認、タスク登録、監査履歴までのAWS E2Eを確認しました。

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
| Write Lambda | BFFからの`create_business_task`だけを処理 | DynamoDB `GetItem`/`PutItem`/`Query`/`UpdateItem`のみ。Gateway contextは拒否 |
| Approval Lambda | BFFから承認要求・承認・却下・状態取得を処理 | DynamoDB `GetItem`/`PutItem`/`Query`/`UpdateItem`のみ。Gateway非公開 |
| AgentCore Gateway | 読み取りLambdaを4つのMCPツールとして公開 | IAM認証、MCP `2025-06-18`。Write targetはローカルソースから削除済み |
| Runtime IAM Policy | importした既存RuntimeロールからGatewayを呼び出す | 対象Gateway ARNへの`bedrock-agentcore:InvokeGateway`のみ |
| CloudWatch Logs | Lambdaログ | 30日保持、Log Groupは削除時retain |

S3への初期データ配置にはCDK Bucket Deploymentを使うため、deploy時には一時的なassetとcustom-resource Lambda、IAMロール、AWS CLI Layerも作成されます。`prune=false`により、更新時にprefix内の既存オブジェクトを自動削除しません。

## ツール境界

Read Lambdaで許可するツールは次の4つです。

- `get_business_requests`
- `analyze_request_data`
- `search_company_rules`
- `get_task_status`

Write Lambdaでは`create_business_task`だけを許可します。`BIZFLOW_ALLOWED_TOOLS`が未設定なら全処理を拒否し、`BIZFLOW_ALLOW_GATEWAY_CONTEXT=false`によってGateway形式の呼び出しも拒否します。BFF envelope自体は認証情報ではなく、Web Task Roleの対象Lambda限定`lambda:InvokeFunction`が認可境界です。

## Gateway Write targetの安全な廃止

既存`BizFlowWriteTools` targetは当初`DeletionPolicy: Retain`で作成されました。そのままCDKテンプレートから削除すると、CloudFormation Stackから外れてもAgentCore Gateway上にtargetが残るため、次の2段階で廃止します。

1. 完了・AWS反映済み: targetを残したままDeletionPolicyを`Delete`へ変更し、Write Lambdaへ`BIZFLOW_ALLOW_GATEWAY_CONTEXT=false`を設定する。
2. ローカル実装済み・AWS反映前: 第1段階のStack更新完了後、targetをCDKテンプレートとGateway用schemaから削除する。

第1段階の時点でGatewayからの書き込みはLambdaでも`GATEWAY_WRITE_DISABLED`として拒否されます。第2段階後は`tools/list`にも`create_business_task`が表示されません。Write Lambda、DynamoDB権限、Web Task Roleからの直接呼び出しは維持するため、承認済みタスク登録のWeb E2Eには影響しません。

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

承認要求と承認／却下を操作するLambda backend、およびBFFからRead/Write Lambdaを直接呼び出す入力形式はAWSへ反映済みです。Web Serviceと検証済みCognito access tokenによるclaims連携も実環境で確認済みです。Gatewayへ定義する4つの読み取りツールには、承認状態変更やタスク登録を含めません。

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
- `ApprovalWorkflowFunctionName`
- `ApprovalWorkflowFunctionArn`

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

Tools Stackの初回反映では、対象Account、Region、作成リソース、費用、既存RuntimeロールへのIAM Policy追加を確認しました。次の1〜10は完了しています。

1. IAM Identity Centerの対象SSO profileと`ap-northeast-1`を確認する。
2. `config/cdk-outputs.json`から`AgentRuntimeExecutionRoleArn`を取得する。
3. `BizFlowAgentToolsStack`だけを対象にCDK diffを取得する。
4. 差分がTools Stackだけであることを確認する。`BizFlowAgentFoundationStack`が依存Stackや変更対象として表示された場合は停止する。
5. 初回構築時は、S3、DynamoDB、2 Lambda、2 Gateway target、Gateway、ログ、Runtime roleへの`InvokeGateway`追加以外の差分がないことを確認する。
6. 差分をユーザーへ提示し、deployの明示承認を得る。
7. Tools Stackをdeployし、Outputsを`config/tools-outputs.json`へ保存する。
8. S3の2オブジェクト、DynamoDB設定、Lambda環境変数とIAM、Gateway target状態をAWSコンソールで確認する。
9. Gatewayの読み取りツールを直接スモークテストする。
10. Runtimeへはまず読み取りツールだけを接続し、新しいRuntime Versionを`READY`まで確認してから`PROD`へ昇格する。
11. 完了（ローカル）: Gatewayから分離した承認バックエンドLambda、IAM、Outputs、テストを追加する。
12. 完了: Tools Stackの差分が承認Lambda、ロググループ、IAM Policy、2 Outputsだけであることを確認する。
13. 完了: Tools Stackへ反映し、承認状態とDynamoDB監査履歴を確認する。
14. 完了: Code InterpreterをRuntime Version 5へ反映し、Python計算と完了ログを確認する。
15. 完了: AgentCore短期Memory用の独立StackとRuntime Version 6を反映し、2ターンの保存・再取得を確認する。
16. 完了: BFF用Lambda直接呼び出し形式をTools Stackへ反映する。
17. 完了: Web Serviceをdeployし、BFF Task Roleへ対象Runtimeと3つのLambdaだけのinvoke権限を付与する。
18. 完了: Web E2Eで未承認拒否、承認後登録、監査履歴を確認する。
19. 完了: Write LambdaのGateway context拒否とWrite targetのDeletionPolicy変更をAWSへ反映し、Gateway拒否とWeb E2Eを再確認する。
20. ローカル実装済み・AWS反映前: Write targetとGateway用書き込みschemaを削除し、Gatewayを読み取り専用4ツールへ限定する。

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

deploy済みGatewayのMCP初期化、`tools/list`、問い合わせ取得、決定的集計、社内ルール検索を次で確認します。IAM Identity CenterのSSO profileを明示し、root ARNは拒否します。`tools/list`に4つの読み取りツールだけが含まれ、`create_business_task`を含む予期しないツールがないことも検証します。`get_task_status`は作成済みtaskがないため呼び出しません。

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

`create_business_task`はGateway targetとschemaから削除し、MCP clientのallow-listとRuntime側の再フィルタも多層防御として維持します。4ツールのいずれかが欠ける場合は、その呼び出しを失敗させて不完全なツール構成を黙って使用しません。

通常更新では次の2引数を追加します。Gateway URLは`config/tools-outputs.json`から読み込み、ソースやスクリプトへ固定しません。

```text
-EnableReadTools -ToolsConfigPath .\config\tools-outputs.json
```

## 公式資料

- [AgentCore Gateway Lambda target](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html)
- [AgentCore Gatewayの基本概念](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-core-concepts.html)
- [AgentCore GatewayをMCP clientから使用する](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using.html)
- [AgentCore GatewayのIAM認証](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-inbound-auth.html)
