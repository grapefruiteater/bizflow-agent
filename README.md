# BizFlow Agent

Amazon Bedrock AgentCore Runtimeで動作するBizFlowエージェントのコンテナ、テスト、公開スクリプトを管理するリポジトリです。

開発はWindows 11ネイティブ、PowerShell、Docker DesktopのLinux containersモードを前提とし、WSLは使用しません。

AWS基盤は、以前のアプリやCDKスタックで作成したリソースを再利用しません。今回のBizFlowアプリ専用スタックとして新規作成します。初期構築だけCDKを使い、通常のエージェント更新ではCDKを実行せず、ARM64コンテナイメージのbuild、ECRへのpush、Runtimeバージョン作成、`PROD` Endpoint切り替えを個別に行います。AgentCoreが自動更新する`DEFAULT`は本番トラフィックに使用しません。

## 現在の状態

2026-07-25時点では、AgentCore Runtime Version 8がAWSの`PROD` Endpointで稼働しています。RuntimeはAmazon Nova 2 Lite、AgentCore Gatewayの読み取り専用4ツール、AWS管理Code Interpreter、session短期Memory、Cognito利用者別User Preference Memoryを使用できます。通常呼び出し、Code Interpreter、短期Memoryの2ターン保存・再取得、別conversationでの長期設定取得、構造化提案を検証済みです。Gateway Write targetの2段階廃止もAWSへ反映し、`tools/list`が読み取り専用4ツールだけを返すことを確認しました。Next.js Web/BFFもECS/Fargateへdeploy済みで、Cognitoログイン、利用者別Memory、承認カード、承認、タスク登録、監査履歴までのAWS E2Eを再確認済みです。

| 項目 | 状態 |
|---|---|
| AgentCore Runtime | Version 8を`PROD`へ反映・検証済み |
| Runtimeイメージ | GitコミットSHAタグ、ECR digest固定 |
| Bedrockモデル | `jp.amazon.nova-2-lite-v1:0` |
| Gateway読み取りツール | 4ツールをRuntimeへ接続済み |
| Gateway書き込みツール | Phase 2をAWS反映・検証済み。Write targetとGateway用schemaから削除 |
| S3・DynamoDB・Lambda・Gateway | `BizFlowAgentToolsStack`としてdeploy済み |
| Web BFF用Lambda直接呼び出し | 2026-07-24にTools Stackへ反映済み |
| CloudWatch Logs | `PROD`の呼び出しログを確認済み |
| 承認バックエンドLambda | AWSへdeploy・動作確認済み |
| Code Interpreter | Runtime Version 8の自動スモークテスト成功 |
| AgentCore Memory | Version 8でsession短期MemoryとCognito利用者別User PreferenceをAWS E2E検証済み |
| Next.js Web/BFF | ECS/Fargateへdeploy済み。Cognitoログインから監査履歴までのAWS E2Eを検証済み |
| Web Foundation | 2026-07-23にECR、VPC、Cognito、ALB、Route 53、WAF、ECS ClusterをAWSへdeploy・確認済み |
| Web Service / ECS Fargate | AWSへdeploy済み。Cognitoグループ認可とRuntime/Lambda呼び出し権限を修正し、承認者E2Eを検証済み |
| 構造化提案・承認カード連携 | Runtime/Webへ反映し、AWS Web E2Eを検証済み |
| 登録済みタスク数の永続表示 | ローカル実装済み・AWS反映前。DynamoDB GSIをBFF専用操作で集計 |

現在のAgentCore Gateway公開面は読み取り専用です。モデルは`get_business_requests`、`analyze_request_data`、`search_company_rules`、`get_task_status`を選択できます。`create_business_task`はGateway schemaとtargetから削除し、Cognito認証済みWeb/BFFが承認内容を再検証した場合だけWrite Lambdaを直接呼び出します。承認されていない書き込みをモデルの判断だけで実行することはありません。

## Runtimeの実装範囲

AgentCore Runtimeが要求する次のHTTP Endpointを実装しています。

- `GET /ping`
- `POST /invocations`
- ホスト：`0.0.0.0`
- ポート：`8080`
- コンテナ：`linux/arm64`

`POST /invocations` はStrands AgentsとAmazon Bedrockモデルを使う、読み取り専用の業務分析へ接続されています。自由文に加え、構造化された問い合わせ一覧を受け取り、期限超過・緊急・24時間以内期限をPython側で決定的に判定できます。LLMはその判定結果と問い合わせIDを根拠に、要約と対応案を作成します。

文章の`response`に加えて`output_contract_version: "1.0"`と最大5件の`proposed_actions`を返します。各提案は問い合わせID、担当者、期限、対応内容、理由、参照ルールIDをPydanticで検証します。Web BFFはこの契約を再検証し、正常な提案だけを承認カードへ自動反映します。候補が複数ある場合は選択でき、提案がない場合は固定の初期値を表示しません。この経路はAWS Web E2Eまで確認済みです。入力形式と判定規則は [`docs/business-analysis.md`](docs/business-analysis.md) を参照してください。

Runtime環境変数`BIZFLOW_GATEWAY_URL`は`config/tools-outputs.json`から公開スクリプトが設定し、ソースへ固定しません。Gateway未設定時は呼び出し元が渡した情報だけを分析するモードへ戻せます。タスク登録、データ更新、承認、外部送信はRuntimeから実行しません。

架空の問い合わせCSV、社内ルール、AgentCore Gatewayの読み取り4ツール、BFF専用のタスク登録処理、S3/DynamoDB adapter、読み取り・書き込みLambdaを分離した`BizFlowAgentToolsStack`はAWSへdeploy済みです。2026-07-25には旧Write targetを削除し、Gatewayの生の`tools/list`が4ツールだけを返すこと、問い合わせ取得・集計・ルール検索、Webからの承認・タスク登録・監査履歴を再確認しました。

Web/BFFだけが呼び出す承認バックエンドLambdaもAWSへdeploy済みです。承認要求、状態確認、承認、DynamoDB監査履歴が正常に機能することを確認しました。このLambdaはAgentCore Gateway targetには登録せず、モデルから到達できない境界を維持しています。Next.js BFFはこの承認を取得してから承認内容をWrite Lambdaへ渡すため、モデル自身へ書き込みツールを公開しません。Web実装は [`docs/web-application.md`](docs/web-application.md)、承認契約は [`docs/approval-workflow.md`](docs/approval-workflow.md) を参照してください。

AWS管理の`aws.codeinterpreter.v1`を使うCode Interpreter分析ツールはRuntime Version 8でも有効です。Version 5で1から100までの整数の二乗和`338350`とCloudWatch Logsの完了ログを確認し、Version 8への更新時にも自動スモークテストが成功しました。既存の`analyze_request_data`は決定的なフォールバックとして残しています。詳細は [`docs/code-interpreter.md`](docs/code-interpreter.md) を参照してください。

同一Runtime session ID内の短期Memoryと、Cognito利用者別の長期User Preference MemoryはRuntime Version 8へ反映済みです。BFFは検証済みCognito identityから生の`sub`を含まないuser IDを導出し、AgentCoreの`runtimeUserId`でRuntimeへ渡します。User Preference strategyは`/users/{actorId}/preferences/`で利用者を分離し、user IDがない直接呼び出しでは長期抽出を行いません。別conversationでの設定取得と利用者分離をWeb E2Eで確認済みです。詳細は [`docs/memory.md`](docs/memory.md)、ポートフォリオ全体は [`docs/portfolio-mvp.md`](docs/portfolio-mvp.md)、ツール基盤は [`docs/tools-infrastructure.md`](docs/tools-infrastructure.md) を参照してください。

採用モデルはAmazon Nova 2 LiteのJP地理推論profileです。

- Runtime `ModelId`: `jp.amazon.nova-2-lite-v1:0`
- Foundation model: `amazon.nova-2-lite-v1:0`
- Source Region: `ap-northeast-1`
- Destination Regions: `ap-northeast-1`, `ap-northeast-3`

## ファイル構成

```text
bizflow-agent/
├── agents/
│   ├── __init__.py
│   └── bizflow/
│       ├── __init__.py
│       ├── analysis_output.py
│       ├── app.py
│       ├── bizflow_agent.py
│       ├── business_data.py
│       ├── code_interpreter_tools.py
│       ├── conversation_memory.py
│       ├── gateway_tools.py
│       ├── Dockerfile
│       ├── .dockerignore
│       ├── requirements.txt
│       └── requirements-dev.txt
├── config/
│   ├── agentcore.example.json
│   ├── memory-outputs.example.json
│   ├── tools-outputs.example.json
│   └── cdk-outputs.json          # BizFlow専用CDKが実行時に生成
├── docs/
│   ├── approval-workflow.md
│   ├── business-analysis.md
│   ├── code-interpreter.md
│   ├── memory.md
│   ├── portfolio-mvp.md
│   ├── tools-infrastructure.md
│   └── deployment.md
├── infra/
│   ├── bin/
│   │   └── bizflow-agent.ts
│   ├── lib/
│   │   ├── foundation-stack.ts
│   │   ├── memory-stack.ts
│   │   ├── runtime-stack.ts
│   │   └── tools-stack.ts
│   └── test/
│       ├── foundation-stack.test.ts
│       ├── memory-stack.test.ts
│       ├── runtime-stack.test.ts
│       └── tools-stack.test.ts
├── lambdas/
│   ├── approval_workflow/
│   │   ├── __init__.py
│   │   └── lambda_function.py
│   └── business_tools/
│       ├── data/
│       │   ├── business_requests.csv
│       │   └── company_rules.md
│       ├── aws_adapters.py
│       ├── lambda_function.py
│       ├── service.py
│       └── tool-schema.json
├── scripts/
│   ├── demo-business-tools.py
│   ├── publish-agentcore.ps1
│   ├── smoke-test-agentcore.ps1
│   ├── smoke-test-gateway.ps1
│   └── smoke_test_gateway.py
├── tests/
│   ├── approval_workflow/
│   │   ├── __init__.py
│   │   └── test_lambda_function.py
│   ├── runtime/
│   │   ├── test_analysis_output.py
│   │   ├── test_bizflow_agent.py
│   │   ├── test_business_data.py
│   │   ├── test_code_interpreter_tools.py
│   │   ├── test_conversation_memory.py
│   │   └── test_endpoints.py
│   └── tools/
│       ├── test_aws_adapters.py
│       └── test_business_tools.py
├── .gitignore
├── cdk.json
├── jest.config.js
├── package.json
├── package-lock.json
├── tsconfig.json
├── bizflow_agent_architecture.drawio
├── プロンプト.txt
└── README.md
```

## 各ファイルの説明

### Runtime・コンテナ

| ファイル | 説明 |
|---|---|
| `agents/__init__.py` | `agents` をPythonパッケージとして扱うための初期化ファイルです。 |
| `agents/bizflow/__init__.py` | BizFlow Runtimeパッケージの初期化ファイルです。 |
| `agents/bizflow/analysis_output.py` | Agent分析結果と承認候補のPydantic契約です。件数、長さ、日付、ルールID、問い合わせIDの重複を検証します。 |
| `agents/bizflow/app.py` | FastAPIによるAgentCore HTTP Runtimeです。`/ping`、`/invocations`、自由文・構造化業務データの入力検証、構造化提案の応答契約、Runtime session/user IDヘッダーの検証、内部エラーのマスキングを実装しています。 |
| `agents/bizflow/bizflow_agent.py` | Strands Agent、Bedrockモデル設定、読み取り専用システムプロンプト、`AgentAnalysis`構造化出力を実装します。Gateway設定時だけ4つの読み取りツールを公開し、書き込みツールを除外します。ローカルコンテナ検証専用の決定的な`local-test` providerも含みます。 |
| `agents/bizflow/business_data.py` | 問い合わせスナップショットを検証し、期限超過・緊急・24時間以内期限を`as_of`基準で決定的に計算します。計算結果と根拠データをLLM向けコンテキストへ変換します。 |
| `agents/bizflow/code_interpreter_tools.py` | AWS管理のCode Interpreterを1回の分析ごとに開始・停止し、ビジネスデータのPython集計・検算だけをStrandsツールとして公開します。入力・出力長、resource ID、エラー情報を制限します。 |
| `agents/bizflow/conversation_memory.py` | AgentCore短期Memoryから最大5ターンを取得し、信頼済みWeb利用者ではUser Preferenceを最大3件取得・抽出します。本文の自己申告IDは使用せず、session fallback、namespace、履歴・保存サイズ、エラー情報を制限します。 |
| `agents/bizflow/gateway_tools.py` | AgentCore GatewayへSigV4で接続し、明示allow-listに含まれるMCPツールだけを読み込むclientを構築します。 |
| `agents/bizflow/Dockerfile` | Python 3.12ベースのRuntimeイメージを作成します。ポート8080を公開し、非rootユーザー `app` でUvicornを起動します。 |
| `agents/bizflow/.dockerignore` | Git情報、仮想環境、テスト、ドキュメント、ローカル設定などをDocker build contextから除外します。 |
| `agents/bizflow/requirements.txt` | Runtimeで必要なFastAPI、Uvicorn、Strands Agents、MCP、AgentCore Code Interpreter client、SigV4用AWS SDKの固定バージョンを定義します。 |
| `agents/bizflow/requirements-dev.txt` | Runtime依存関係に加え、pytestとHTTPテスト用パッケージを定義します。 |

### 設定・公開

| ファイル | 説明 |
|---|---|
| `config/agentcore.example.json` | BizFlow専用CDK Outputsまたは環境別設定ファイルの形式例です。値は例示用であり、そのまま使用しません。 |
| `config/memory-outputs.example.json` | Memory Stack Outputsの形式例です。実環境の`memory-outputs.json`はGit管理しません。 |
| `config/tools-outputs.example.json` | Tools Stack Outputsの形式例です。実環境の`tools-outputs.json`はGit管理しません。 |
| `config/web-foundation-outputs.example.json` | Web Foundation Stack Outputsの形式例です。実環境のOutputsはGit管理しません。 |
| `config/web-service-outputs.example.json` | Web Service Stack Outputsの形式例です。イメージdigestとService情報を記録します。 |
| `config/cdk-outputs.json` | BizFlow専用スタックのdeploy後に生成する環境固有ファイルです。Git管理せず、公開スクリプトの入力として使用します。 |
| `scripts/publish-agentcore.ps1` | Git SHAタグによるARM64イメージ公開とAgentCore Runtime更新を行います。デフォルトはdry-runで、`-Execute` 指定時のみbuild/pushとRuntime更新へ進みます。 |
| `scripts/smoke-test-agentcore.ps1` | ローカルコンテナまたはAgentCore上の`PROD` Endpointを検証します。リモートではEndpoint状態・liveVersion・実呼び出しを確認します。 |
| `scripts/smoke-test-gateway.ps1` / `smoke_test_gateway.py` | IAM Identity Center profileでGatewayへSigV4接続し、`tools/list`が読み取り専用4ツールだけを返すことと、3つの読み取りツールの実行を検証します。 |
| `scripts/demo-business-tools.py` | AWSへ接続せず、問い合わせ取得、集計、ルール検索、未承認拒否、承認、タスク登録、状態確認を順番に再現します。 |
| `docs/business-analysis.md` | 構造化された問い合わせ分析の入力項目、決定的な判定規則、応答契約、リクエスト例を説明します。 |
| `docs/approval-workflow.md` | モデルから分離した承認バックエンドLambdaの操作契約、IAM境界、現在の反映状態を説明します。 |
| `docs/code-interpreter.md` | 管理済みCode Interpreterのセッション、IAM、Runtime接続、フォールバック、反映順序を説明します。 |
| `docs/memory.md` | session短期Memory、Cognito利用者別User Preference、IAM/namespace境界、反映順序、短期・長期E2Eを説明します。 |
| `docs/web-application.md` | Next.js画面、BFF API、Cognito/ALB認証、ECS/Fargate構成、承認境界、ローカル検証、AWS反映順序を説明します。 |
| `docs/portfolio-mvp.md` | ポートフォリオのシナリオ、4つのGateway読み取りツールとBFF専用書き込み処理、承認境界、今後のAWS実装順序を説明します。 |
| `docs/tools-infrastructure.md` | S3、DynamoDB、読み取り／書き込みLambda、AgentCore GatewayのCDK設計、IAM境界、Outputs、直接スモークテストとRuntime接続を説明します。 |
| `docs/deployment.md` | Windowsネイティブ環境の準備、CDK Outputs契約、dry-run、公開、ヘルスチェック、デプロイ記録、ロールバックの詳細手順です。 |

### ポートフォリオ用モックツール

| ファイル | 説明 |
|---|---|
| `lambdas/business_tools/data/business_requests.csv` | 契約、障害、請求、総務、注文、申請を含む、GitHub公開可能な架空問い合わせデータです。 |
| `lambdas/business_tools/data/company_rules.md` | 障害、期限超過、請求、契約、個人情報に関する架空の社内対応ルールです。 |
| `lambdas/business_tools/tool-schema.json` | AgentCore GatewayのRead Lambda targetへ登録する4つの読み取りツールの入力schemaです。 |
| `lambdas/business_tools/aws_adapters.py` | S3から合成データを読むadapterと、DynamoDBへ承認・タスク・監査イベントを永続化するadapterです。`entity_type` GSIをページングして登録済みタスク数も取得します。AWSクライアントはLambda環境変数がある場合だけ遅延生成します。 |
| `lambdas/business_tools/lambda_function.py` | GatewayまたはBFFの呼び出し元を判別し、許可された処理へ振り分けるLambda handlerです。全操作とGateway公開操作を別allow-listでfail-closedにし、BFF専用のダッシュボード集計とタスク登録をGatewayへ公開しません。 |
| `lambdas/business_tools/service.py` | CSV取得、決定的集計、ルール検索、承認検証、タスク登録・状態取得、監査イベントのドメイン処理と、ローカル用adapterを実装します。 |

### 承認バックエンド

| ファイル | 説明 |
|---|---|
| `lambdas/approval_workflow/__init__.py` | BFF向け承認Lambdaパッケージの初期化ファイルです。 |
| `lambdas/approval_workflow/lambda_function.py` | `request_approval`、`approve`、`reject`、`get_approval`を処理します。Gateway targetには登録せず、Next.js BFFのTask RoleからのLambda呼び出しだけを想定します。 |

### Web / BFF

| ファイル | 説明 |
|---|---|
| `web/src/app/page.tsx` / `components/workspace.tsx` | 問い合わせダッシュボード、Agentチャット、構造化された推奨アクションの選択・承認カード自動反映、承認・却下、承認後タスク登録を表示します。 |
| `web/src/app/history/page.tsx` / `components/history-view.tsx` | 承認IDから承認内容、承認者、作成タスク、監査イベントを確認する履歴画面です。 |
| `web/src/app/api/` | dashboard、AgentCore Runtime、承認、タスク登録、履歴、ヘルスチェックのBFF API Routesです。 |
| `web/src/lib/auth.ts` | ALB/Cognito identity、承認者グループ、CSRF headerを検証し、actorから分離したRuntime session IDと不透明なuser IDを導出します。 |
| `web/src/lib/backend.ts` / `contracts.ts` / `validation.ts` | AgentCore Runtimeへsession/user IDをAWS SDKの専用フィールドで渡し、3つのLambdaを呼び出します。Runtimeの構造化応答をBFF境界で検証し、承認済み提案だけを書き込み経路へ渡し、登録済みタスク数をRead Lambdaから取得します。 |
| `web/src/lib/demo-backend.ts` / `demo-data.ts` | AWSへ接続せず、架空データとメモリ内承認フローを動かすローカルデモbackendです。 |
| `web/Dockerfile` / `.dockerignore` | Next.js standalone出力を非rootユーザーで起動するFargate向けARM64対応イメージです。 |
| `web/tests/` | 認証境界、session/user ID分離、SDKへのuser ID受け渡し、構造化応答、不正な書き込み主張の拒否、承認カード反映、未承認拒否、承認後登録、冪等性をVitestで検証します。 |

### CDK基盤

| ファイル | 説明 |
|---|---|
| `infra/bin/bizflow-agent.ts` | CDKアプリのエントリーポイントです。Runtime、Tools、Memory、Web Foundation、Web Serviceを明示contextでだけ追加します。Web Serviceは各Stack Outputsを設定ファイルから読み、既存Stackとのcross-stack exportを作りません。 |
| `infra/lib/foundation-stack.ts` | BizFlow専用ECR、AgentCore実行IAMロール、`PUBLIC`ネットワーク設定を作成します。Bedrock権限を指定profile/modelへ限定し、AWS管理Code Interpreterにはセッション利用権限だけを付与します。 |
| `infra/lib/memory-stack.ts` | 30日保持のAgentCore Memory、利用者別User Preference strategy、既存Runtimeロールのイベント権限とnamespace限定取得権限を定義します。 |
| `infra/lib/runtime-stack.ts` | digest固定の初回コンテナからAgentCore Runtime、`PROD`カスタムEndpoint、Endpoint別の30日保持ロググループ、通常更新用Outputsを作成します。`DEFAULT` EndpointはRuntime作成時にAgentCoreが自動作成します。 |
| `infra/lib/tools-stack.ts` | 合成データ用S3、承認・タスク・監査用DynamoDB、タスク件数取得用GSI、読み取り／BFF書き込みLambda、承認Lambda、読み取り専用のIAM認証AgentCore Gateway、既存RuntimeロールのOutputs importを定義します。 |
| `infra/lib/web-foundation-stack.ts` | Web専用ECR、VPC、ECS Cluster、Cognito、HTTPS ALB、Route 53 Alias、WAFを定義します。 |
| `infra/lib/web-service-stack.ts` | digest固定ARM64イメージのFargate Service、最小権限Task Role、Target Group、Cognito認証Listener Ruleを定義します。 |
| `infra/test/foundation-stack.test.ts` | ECRとIAM、およびFoundation OutputsのCloudFormation定義を検証します。 |
| `infra/test/memory-stack.test.ts` | Memoryの保持期間、RETAIN、User Preference namespace、最小権限、Outputsを検証します。 |
| `infra/test/runtime-stack.test.ts` | Runtime、Endpoint、ログ、Outputsを検証し、タグや不正なdigestを拒否することを確認します。 |
| `infra/test/tools-stack.test.ts` | S3/DynamoDB保護、3つのLambdaの分離、最小権限、単一Read targetと4ツール、Write target非公開、Outputsを検証します。 |
| `infra/test/web-foundation-stack.test.ts` / `web-service-stack.test.ts` | Web基盤、認証、ネットワーク、IAM、digest固定、OutputsをCloudFormation template assertionsで検証します。 |
| `package.json` / `package-lock.json` | Node.js/CDK依存関係を固定し、型チェックとCDKテストのコマンドを定義します。Node.js 20以上が必要です。 |
| `cdk.json` / `tsconfig.json` / `jest.config.js` | CDKエントリーポイント、TypeScript厳格設定、Jest設定です。 |

`publish-agentcore.ps1` には次の安全策があります。

- `AWS_PROFILE` と `AWS_REGION` を必須入力にする
- 使用するBedrockモデルまたはinference profileのIDを `ModelId` として必須入力にし、Runtime環境変数へ渡す
- `sts get-caller-identity` で接続先を表示する
- root ARNを拒否する
- AWS AccountとECR URIのAccountが異なる場合に停止する
- ECRが `IMMUTABLE` かつscan-on-push有効であることを確認する
- dirty worktreeを拒否し、GitコミットSHAとコンテナ内容を一致させる
- `latest` タグを使わない
- 同じGit SHAタグがECRに既に存在する場合、immutableタグを再pushせず停止する
- 自動更新される`DEFAULT` Endpointでは`-Execute`を拒否し、明示昇格用のカスタムEndpointを要求する
- Runtimeが `READY` になるまでEndpointを更新しない
- 新Runtimeバージョンの手入力後にだけ`PROD` Endpointを切り替える
- Memory有効時はOutputsのMemory ID・ARN・Account・Region、User Preference strategy、namespace形式を検証する
- 同一Runtime session IDによる2ターンのMemory保存・再取得を自動検証する
- 旧バージョンへ戻すコマンドを最後に表示する

### テスト・補助ファイル

| ファイル | 説明 |
|---|---|
| `tests/runtime/test_analysis_output.py` | 構造化提案の直列化、重複ID、余分な項目、不正なルールIDの拒否を検証します。 |
| `tests/runtime/test_endpoints.py` | `/ping`、`/invocations`、構造化データと提案、入力エラー、session/user ID、Memory状態、内部エラー応答をAWS接続なしで検証するpytestです。 |
| `tests/runtime/test_bizflow_agent.py` | Runtime設定、ローカルテストprovider、依存注入した分析処理、空応答の拒否をAWS接続なしで検証するpytestです。 |
| `tests/runtime/test_gateway_tools.py` | Gateway URL制限、SigV4署名、読み取りツールallow-listと書き込みツール除外をAWS接続なしで検証します。 |
| `tests/runtime/test_business_data.py` | 期限超過などの業務判定と、タイムゾーン、重複ID、日時前後関係の境界条件を検証するpytestです。 |
| `tests/runtime/test_code_interpreter_tools.py` | 管理済みresource ID制限、セッション終了、実行パラメータ、出力処理、安全なエラー応答をAWS接続なしで検証します。 |
| `tests/runtime/test_conversation_memory.py` | session/user境界、利用者namespace分離、履歴・設定のサイズ制限、長期抽出切り替え、安全なエラー応答をfake clientで検証します。 |
| `tests/approval_workflow/test_lambda_function.py` | 承認要求、状態取得、承認、却下、二重決定拒否、安全なエラー応答をAWS接続なしで検証します。 |
| `tests/tools/test_business_tools.py` | Gatewayの読み取り4ツール、BFF専用タスク登録、架空データ分析、未承認拒否、承認後改変拒否、冪等性を検証します。 |
| `tests/tools/test_aws_adapters.py` | AWSへ接続せず、fake S3/DynamoDBでデータ読込、承認整合性、監査履歴、冪等性、GSIのページング件数取得を検証します。 |
| `web/tests/dashboard-backend.test.ts` | AWS SDKをmockし、ダッシュボードがBFF専用操作から永続タスク件数を取得し、不正な件数を拒否することを検証します。 |
| `.gitignore` | 仮想環境、Pythonキャッシュ、CDK成果物、環境別CDK Outputs、生成したデプロイ記録をGit管理対象から除外します。 |
| `bizflow_agent_architecture.drawio` | BizFlow AgentのAWS全体構成と処理フローを示すdraw.io構成図です。 |
| `プロンプト.txt` | 開発環境、コンテナ方式、イメージ管理、IaCと通常更新の分離方針を記録しています。 |

## AWS基盤のライフサイクル

### 初期構築

他プロジェクトのECR、IAMロール、VPC、AgentCore Runtime、Endpointは参照しません。BizFlow専用のリソースを次の順序で作成します。

1. `BizFlowAgentFoundationStack` を新規deployする。
   - BizFlow専用ECRリポジトリ
   - AgentCore Runtime実行IAMロール
     - `jp.amazon.nova-2-lite-v1:0` profile
     - 東京・大阪の `amazon.nova-2-lite-v1:0`
   - Runtimeログ、メトリクス、トレースに必要なIAM権限
   - `PUBLIC`ネットワーク設定
2. 作成した専用ECRへ、最初の `linux/arm64` イメージをGit SHAタグでpushする。
3. push済みイメージのdigest URIと明示したBedrockモデルIDを使い、`BizFlowAgentRuntimeStack` を新規deployする。
   - 初期AgentCore Runtime
   - Runtime作成時にAgentCoreが自動作成する初期Versionと`DEFAULT` Runtime Endpoint
   - 初期Versionを指す`PROD`カスタムEndpoint
   - `DEFAULT`・`PROD`別のCloudWatch Logsロググループ
   - 公開スクリプトが必要とするCDK Outputs
4. Outputsを `config/cdk-outputs.json` に保存する。
5. 初期Runtimeと`PROD` Endpointのヘルスチェックを行う。

AgentCore Runtimeは、空のECRリポジトリだけでは作成できません。初回イメージが必要になるため、FoundationとRuntimeを段階分けします。Runtime StackにはECR URI全体ではなく `sha256:...` digestだけを渡し、今回のFoundation Stackが作成したECR URIとCDK内で結合します。別プロジェクトのECRを誤って参照できない設計です。

FoundationとRuntimeの初期構築、および`PROD` Endpointの動作確認は完了しています。上記は新規環境で再現する場合の順序です。

2026-07-22に、Runtime実行ロールへAWS管理Code Interpreterのセッション利用権限を追加するFoundation更新も完了しました。この更新では既存のECR、Runtime、Endpoint、Cross-Stack Exportを変更していません。

### 業務ツール基盤の追加

`BizFlowAgentToolsStack`はFoundationと通常のRuntime更新から分離しています。`enableTools=true`の場合だけ、合成データ用S3、承認・タスク・監査用DynamoDB、読み取り／書き込みLambda、承認バックエンドLambda、AgentCore GatewayをCDKアプリへ追加します。既存RuntimeロールARNは`config/cdk-outputs.json`から取得し、ソースへ埋め込みません。

S3、DynamoDB、Gateway、読み取り／書き込みLambda、承認バックエンドLambdaは2026-07-22にdeploy済みです。Outputsには`ApprovalWorkflowFunctionName`と`ApprovalWorkflowFunctionArn`も含まれます。承認要求・状態取得・承認・DynamoDB監査履歴の実環境テストも完了しています。環境固有OutputsはGit管理対象外の`config/tools-outputs.json`へ保存します。

### 短期Memoryと利用者別長期Memory

`BizFlowAgentMemoryStack`はFoundation、Tools、通常のRuntime更新から分離しています。30日保持の短期AgentCore Memory、Cognito利用者別User Preference strategy、namespace限定取得権限をAWSへ反映済みです。Memory IDとnamespaceはRuntime Version 8へ設定し、Webから別conversationで長期設定を取得できることを確認しました。

### 通常更新

初期構築後は、同じBizFlow専用Runtimeのバージョンだけを更新します。

1. Docker buildと専用ECRへのpush
2. `UpdateAgentRuntime` による新Runtimeバージョン作成
   - `BIZFLOW_MODEL_PROVIDER=bedrock`
   - `BIZFLOW_MODEL_ID=<明示したモデルまたはinference profile ID>`
   - `BIZFLOW_AWS_REGION=<明示したリージョン>`
   - `BIZFLOW_GATEWAY_URL=<Tools Stack OutputsのGateway URL>`（`-EnableReadTools`指定時だけ）
   - `BIZFLOW_CODE_INTERPRETER_ID=aws.codeinterpreter.v1`（`-EnableCodeInterpreter`指定時だけ）
   - `BIZFLOW_MEMORY_ID=<Memory Stack OutputsのMemory ID>`（`-EnableMemory`指定時だけ）
   - `BIZFLOW_MEMORY_USER_PREFERENCE_NAMESPACE_TEMPLATE=/users/{actorId}/preferences/`（`-EnableMemory`指定時だけ）
3. `READY` 待機
4. 明示確認後に`PROD` Endpointを切り替え
5. 通常スモークテスト、ランダムなSHA-256課題を使ったCode Interpreterスモークテスト、同じsession IDを使ったMemory保存・再取得スモークテスト

この段階では `cdk deploy` を実行しません。再利用するのは他アプリのAWS構成ではなく、今回新規作成したBizFlow専用スタックのOutputsです。

## ローカルテスト

### CDK

Node.js 20以上を使用します。

```powershell
npm ci
npm run build
npm test
npx cdk synth BizFlowAgentToolsStack `
  --context "environment=dev" `
  --context "enableTools=true" `
  --no-lookups

npx cdk synth BizFlowAgentMemoryStack `
  --context "environment=dev" `
  --context "enableMemory=true" `
  --no-lookups
```

これらはTypeScriptの型チェック、CloudFormationテンプレートのユニットテスト、ローカルsynthであり、AWSリソースを変更しません。`enableTools`の既定値は`false`です。Tools Stackは既存ロールをARNでimportするため、Foundation Stackが依存Stackとして暗黙にdeployされることもありません。

### Pythonテスト

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --requirement .\agents\bizflow\requirements-dev.txt
python -m pytest .\tests
```

現在のローカル検証結果はPython `79 passed`、CDK/Jest `28 passed`、Web/Vitest `7 passed`、両TypeScript型チェック成功です。Next.js本番ビルドとWeb用`linux/arm64` Docker build、ローカルコンテナのヘルスチェックも成功しています。

### Web / BFF

```powershell
Set-Location .\web
npm ci
npm run typecheck
npm test
npm run build
$env:BIZFLOW_LOCAL_DEMO = "true"
npm run dev
```

ローカルデモはAWSへ接続しません。`http://127.0.0.1:3000`で、分析、承認要求、承認、タスク登録、履歴確認を実行できます。Web用CDKの構成、ARM64 Docker build、AWS反映前提は [`docs/web-application.md`](docs/web-application.md) を参照してください。

### ARM64コンテナ

```powershell
docker buildx build `
  --platform linux/arm64 `
  --file .\agents\bizflow\Dockerfile `
  --tag bizflow-agent:local `
  --load `
  .\agents\bizflow

docker run --rm --platform linux/arm64 `
  --env BIZFLOW_MODEL_PROVIDER=local-test `
  --publish 8080:8080 `
  bizflow-agent:local
```

別のPowerShellでスモークテストを実行します。

```powershell
.\scripts\smoke-test-agentcore.ps1 -LocalBaseUrl http://127.0.0.1:8080
```

## 通常更新の公開前確認

まず、deploy済みGatewayの読み取り経路を直接確認します。このコマンドはAWSリソースを変更せず、`tools/list`が読み取り専用4ツールだけを返すこと、問い合わせ取得、決定的集計、社内ルール検索を検証します。

```powershell
.\scripts\smoke-test-gateway.ps1 `
  -AWS_PROFILE <SSOプロファイル名> `
  -AWS_REGION ap-northeast-1 `
  -ToolsConfigPath .\config\tools-outputs.json
```

成功後、Gateway読み取り接続を含む通常更新のdry-runを実行します。

```powershell
.\scripts\publish-agentcore.ps1 `
  -AWS_PROFILE <SSOプロファイル名> `
  -AWS_REGION ap-northeast-1 `
  -ModelId jp.amazon.nova-2-lite-v1:0 `
  -ConfigPath .\config\cdk-outputs.json `
  -StackName BizFlowAgentRuntimeStack `
  -EnableReadTools `
  -EnableCodeInterpreter `
  -ToolsConfigPath .\config\tools-outputs.json `
  -EnableMemory `
  -MemoryConfigPath .\config\memory-outputs.json
```

`ModelId`は採用済みのJP地理推論profileを明示します。`-EnableCodeInterpreter`はRuntime環境変数へ`BIZFLOW_CODE_INTERPRETER_ID=aws.codeinterpreter.v1`、`-EnableMemory`はMemory IDとUser Preference namespace templateを追加します。dry-runではGateway、Code Interpreter、Memory strategyと設定値を表示します。Memory Stackのdeployとworktreeのコミット後、同じ引数へ`-Execute`を追加した場合だけイメージpushとRuntime更新を行います。具体的な確認順序は [`docs/deployment.md`](docs/deployment.md) と [`docs/memory.md`](docs/memory.md) に記載しています。

公開スクリプトは通常のRuntime確認とCode InterpreterのSHA-256検算に加え、Memory有効時は同一session IDの2回目の呼び出しで、プロンプトに含めていない検証markerを再回答できることを確認します。成功時だけデプロイ記録の`memorySmokeTest`を`PASSED`にします。

`publish-agentcore.ps1` はAWS基盤を作成しません。初期基盤はBizFlow専用CDKスタックで新規作成し、通常更新時には `cdk deploy` を実行しません。詳細は [`docs/deployment.md`](docs/deployment.md) を参照してください。
