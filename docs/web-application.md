# BizFlow Web / BFF

## 現在の状態

Next.jsのダッシュボード、Agentチャット、承認カード、タスク登録、承認履歴画面と、それらをAWSへ配置する2つのCDK Stackを実装済みです。ローカルテスト、Next.js本番ビルド、`linux/arm64` Docker build、ローカルコンテナのヘルスチェック、CDKテストと`--no-lookups` synthまで完了しています。

2026-07-23に`BizFlowWebFoundationStack`をAWSへdeployし、Web用ECR、VPC、Cognito、ALB、Route 53 Alias、WAF、ECS Cluster、Outputsを確認済みです。2026-07-24にはTools StackへWeb BFF用のRead/Write Lambda直接呼び出し形式を反映し、`BizFlowWebServiceStack`もdeployしました。Cognitoログイン、ダッシュボード、Agent分析のAWS E2Eを確認済みです。既にAWSで稼働しているRuntime Version 6とMemory StackへWeb関連deployによる変更は加えていません。

ALBの`x-amzn-oidc-data`はCognito ID tokenではなくUserInfo由来のclaimsであり、`cognito:groups`を認可元として期待できません。BFFは`x-amzn-oidc-accesstoken`をCognito User Poolとapp clientに対して署名検証し、access tokenの`sub`とALB identityの一致を確認してから`cognito:groups`を評価します。この修正はローカルテストと本番ビルドまで完了しており、次のWeb Service更新でAWSへ反映します。

## 構成

```text
Browser
  -> HTTPS Application Load Balancer
     -> Cognito authenticate-cognito
     -> private subnetのECS Fargate / Next.js BFF
        -> AgentCore Runtime PROD Endpoint
        -> Read Tools Lambda
        -> Approval Workflow Lambda
        -> Write Tools Lambda（承認済み内容だけ）
```

`BizFlowWebFoundationStack`は次を作成します。

- Git SHAタグとdigest固定で使用する、タグ変更禁止・scan-on-push有効のWeb用ECR
- 2 Availability Zone、public/private subnet、NAT Gateway 1台の専用VPC
- ECS Cluster
- Cognito User Pool、app client、managed login domain
- `BizFlowUsers`と`BizFlowApprovers`グループ
- HTTPS Application Load Balancer、Route 53 Alias、AWS WAF
- Web Service Stackが再利用するIDsとARNsのOutputs

`BizFlowWebServiceStack`はFoundation Stackと既存Runtime/Tools Outputsを設定ファイルから読み、次を作成します。

- `linux/arm64`、0.5 vCPU、1 GiBのFargate Task Definition
- private subnet、public IPなし、desired count 1のECS Service
- ALBからポート3000だけを許可するSecurity Group
- `/api/health`を使うTarget Group
- Cognito認証後だけforwardするHTTPS Listener Rule
- CPU使用率による1から3タスクのAuto Scaling
- 30日保持のCloudWatch Logs
- GuardDuty Runtime Monitoringが注入するAWS管理サイドカーを取得するための、読み取り専用ECR権限をTask Execution Roleへ付与

FoundationとServiceを分けるため、空のECRしかない段階でECS Serviceを作りません。Foundationを一度作成し、WebイメージをECRへpushしてdigestを取得してからServiceを追加します。通常のWeb更新ではFoundationをdeployしません。

GuardDutyの自動エージェント設定が有効なアカウントでは、Fargate起動時に別AWSアカウントのECRからRuntime Monitoringサイドカーが注入されます。Webイメージ用リポジトリだけに限定したpull権限ではこのサイドカーを取得できないため、Task Execution Roleには`ecr:BatchCheckLayerAvailability`、`ecr:GetDownloadUrlForLayer`、`ecr:BatchGetImage`を読み取り専用で許可します。アプリケーション用Task RoleのAgentCore/Lambda権限とは分離しています。

Next.js standalone serverは`HOSTNAME`を待受アドレスとして使用します。ECS実行時のタスクhostnameを待受アドレスにすると`127.0.0.1`のコンテナヘルスチェックへ応答できないため、Task Definitionで`HOSTNAME=0.0.0.0`と`PORT=3000`を明示します。これによりコンテナ内部のloopbackチェックとALBからのチェックの両方へ応答します。

Web Task Roleから3つの業務Lambdaを直接呼び出すIAM Resourceには、Lambda関数ARNの`function:関数名`形式を使用します。`function/関数名`では実際のLambda ARNと一致せず、`lambda:InvokeFunction`が`AccessDeniedException`になるため、CDKのARN形式を明示して回帰テストで固定しています。

`PROD` qualifierを指定するAgentCore呼び出しでは、Task RoleへRuntime ARNだけでなく`AgentRuntimeEndpointArn`も許可します。AgentCoreはRuntimeと指定Endpointの両方を階層的に認可するため、Endpoint ARNはRuntime Stack Outputsから取得し、ソースへ埋め込みません。

「今週」のような相対日付をモデルへ推測させないため、Web BFFは`BIZFLOW_DATA_START_DATE`、`BIZFLOW_DATA_END_DATE`、`BIZFLOW_ANALYSIS_AS_OF`をAgent向けプロンプトへ固定コンテキストとして付加します。ダッシュボードとAgentは同じ期間を参照し、日付設定が`YYYY-MM-DD`でなければモデルを呼ばずにエラーとします。

## Web画面

- `/`: 未対応、緊急、期限超過、登録済みタスクの件数、カテゴリー集計、緊急案件、Agentチャット、承認カード
- `/history`: 承認IDを指定した承認内容と監査イベントの確認
- `/api/health`: ALB/ECSのヘルスチェック
- `/api/dashboard`: 架空問い合わせの取得と決定的集計
- `/api/agent`: ダッシュボードと同じ固定分析期間を付加したAgentCore Runtimeの`PROD` Endpoint呼び出し
- `/api/approvals`: 承認要求
- `/api/approvals/{approvalId}`: 承認状態と監査履歴
- `/api/approvals/{approvalId}/decision`: 承認または却下
- `/api/approvals/{approvalId}/execute`: 承認ストアから提案を再取得し、同じ内容のタスクを登録

AWS接続時の登録済みタスク総数は、一覧取得用index/APIをまだ追加していないため、初期表示では`0`です。現在のブラウザセッションで登録した結果は画面へ反映します。永続的な件数表示は次の改善項目です。

## 認証と承認境界

- ALBがCognito認証を完了してからECSへrequestをforwardする。
- ECS TaskのSecurity GroupはALB Security Groupからのポート3000だけを許可する。
- BFFはALBが付加するCognito access tokenを署名・User Pool・app clientまで検証し、tokenの`sub`とALB identityが一致した利用者だけを受け入れる。
- `cognito:groups`は検証済みaccess tokenから読み取り、UserInfo由来の`x-amzn-oidc-data`を認可判断に使用しない。
- `approve`、`reject`、`execute`は`BizFlowApprovers`グループだけに許可する。
- state-changing APIは`x-bizflow-csrf: 1`ヘッダーを必須にする。
- AgentCore Runtime session IDは、認証済みactorとブラウザ内conversation IDからBFFがSHA-256で生成する。request本文に任意のRuntime session IDを指定させない。
- BFFのTask Roleは対象Runtimeと3つのLambdaだけを呼び出せる。
- BFFは承認済み提案をApproval Lambdaから再取得し、その完全な内容をWrite Lambdaへ渡す。
- Write Lambda/DynamoDBでも`APPROVED`状態、提案一致、冪等性を再検証する。
- RuntimeのMCP allow-listには引き続き`create_business_task`を含めない。

Lambdaへ渡す`source: bizflow-web-bff`はrequest形式の識別子であり、認証情報ではありません。Lambda直接呼び出しの認可境界はTask Roleの`lambda:InvokeFunction`です。Gatewayから呼ばれた場合は従来どおりGateway contextのツール名を優先します。

## ローカル実行

ローカルデモはAWS SDKを呼びません。`web/.env.example`を参考に`BIZFLOW_LOCAL_DEMO=true`を設定します。

```powershell
Set-Location .\web
npm ci
$env:BIZFLOW_LOCAL_DEMO = "true"
npm run dev
```

ブラウザで`http://127.0.0.1:3000`を開きます。ローカル利用者は承認者グループを持つ固定のデモidentityで、承認・タスク・履歴はNext.jsプロセス内だけに保持されます。再起動すると消えます。

ローカル検証は次の順序です。

```powershell
Set-Location .\web
npm run typecheck
npm test
npm run build

Set-Location ..
docker buildx build `
  --platform linux/arm64 `
  --progress plain `
  --file .\web\Dockerfile `
  --tag bizflow-web:local `
  --load `
  .\web

docker run --rm --platform linux/arm64 `
  --env BIZFLOW_LOCAL_DEMO=true `
  --publish 3000:3000 `
  bizflow-web:local
```

別のPowerShellで`Invoke-RestMethod http://127.0.0.1:3000/api/health`を実行し、`status=healthy`を確認します。

## AWS反映前の入力

Foundationには既存の次の値が必要です。値をソースへ埋め込まず、CDK contextで指定します。

- Web FQDN。例: `bizflow.example.com`
- Route 53 public hosted zone nameとID
- 同じRegionに発行済みのACM certificate ARN
- 使用する2つのAvailability Zone

Serviceは次のGit管理外Outputsを読みます。

- `config/web-foundation-outputs.json`
- `config/cdk-outputs.json`
- `config/tools-outputs.json`

形式例は`config/web-foundation-outputs.example.json`と`config/web-service-outputs.example.json`です。

## AWS反映順序

以下はユーザーが対象Account、Region、差分と費用を確認した後に実行する手順です。この実装作業では実行していません。

1. `BizFlowWebFoundationStack`の`cdk diff`を確認する。
2. 明示判断後にFoundationだけをdeployし、Outputsを`config/web-foundation-outputs.json`へ保存する。
3. Git SHAをタグにしてWebイメージを`linux/arm64`でECRへpushする。
4. ECRからpush済みイメージのdigestを取得する。
5. `BizFlowWebServiceStack`の`cdk diff`を確認する。
6. 明示判断後にServiceだけをdeployし、Outputsを`config/web-service-outputs.json`へ保存する。
7. Cognitoへデモ利用者を作り、`BizFlowUsers`と必要に応じて`BizFlowApprovers`へ追加する。
8. HTTPS URLからログイン、分析、承認、登録、履歴をE2E確認する。

Foundationの差分確認例です。

```powershell
npx cdk diff BizFlowWebFoundationStack `
  --context "environment=dev" `
  --context "enableWebFoundation=true" `
  --context "webAvailabilityZones=ap-northeast-1a,ap-northeast-1c" `
  --context "webDomainName=<Web FQDN>" `
  --context "webHostedZoneName=<Hosted Zone名>" `
  --context "webHostedZoneId=<Hosted Zone ID>" `
  --context "webCertificateArn=<ACM certificate ARN>" `
  --profile $AwsProfile
```

Web Serviceの差分確認例です。`$WebImageDigest`は`sha256:`から始まるdigestを指定します。

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

NAT Gateway、Application Load Balancer、WAF、Fargate、Cognito、Route 53、CloudWatch Logsには利用料金が発生し得ます。ポートフォリオ利用後は、RETAIN設定したECR/User Poolとログ、DynamoDB/S3/Memoryを含め、削除方針と保存データを個別に確認します。

## 公式資料

- [Application Load BalancerのCognito認証](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)
- [AgentCore RuntimeをAWS SDKから呼び出す](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html)
- [InvokeAgentRuntime API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html)
- [ECSのネットワークセキュリティ](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-network.html)
- [Next.jsのself-hosting](https://nextjs.org/docs/app/guides/self-hosting)
