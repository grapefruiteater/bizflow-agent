# BizFlow Agent ポートフォリオMVP

## コンセプト

自然言語で依頼すると、社内データとルールを調査・分析して必要な対応を提案し、利用者が承認した内容だけを業務システムへ登録するAIエージェントです。

特定業界の固有処理をAgent本体へ埋め込まず、データとツールの契約を差し替えられる構成にします。今回の画面とデモは問い合わせ管理に絞り、営業、カスタマーサポート、総務、プロジェクト管理、経営企画、個人事業主などへ展開できる設計を示します。

## 実装状態

| 段階 | 状態 | 内容 |
|---|---|---|
| AgentCore Runtime | AWSで稼働済み | Version 8、Nova 2 Lite、Gateway読み取りツール、Code Interpreter、短期・利用者別長期Memory、構造化提案 |
| 架空業務データ | ローカル実装済み | 個人情報を含まないCSVとMarkdownの社内ルール |
| Lambda業務ツール | CDK・ローカル実装済み | Gateway読み取り4ツール、BFF専用書き込み処理、S3/DynamoDB adapter、読み取り・書き込み関数の分離 |
| Human-in-the-loop境界 | AWSへ反映・検証済み | DynamoDBで未承認拒否、承認後改変拒否、重複登録防止、監査記録 |
| S3・DynamoDB・Lambda・Gateway | AWSへdeploy済み | 2026-07-22に初期反映、2026-07-24にWeb BFF直接呼び出し形式を更新 |
| Runtimeからのツール選択 | AWSへ反映済み | Version 6でSigV4 MCP clientから4つの読み取りツールだけを公開 |
| 承認バックエンドLambda | AWSへdeploy・検証済み | Gatewayから分離し、承認要求・承認・却下・状態取得を処理 |
| Code Interpreter | AWSへ反映・検証済み | Version 6への更新時も自動スモークテスト成功 |
| AgentCore Memory | AWSへ反映・E2E検証済み | session短期MemoryとCognito利用者別User PreferenceをVersion 8で確認 |
| Next.js Web/BFF | AWSへdeploy・E2E検証済み | ダッシュボード、Agentチャット、承認カード、タスク登録、履歴画面 |
| Web Foundation | AWSへdeploy済み | Web用ECR、2 AZのVPC、Cognito、ALB、Route 53、WAF、ECS ClusterとOutputsを確認済み |
| Web Service / Fargate | AWSへdeploy・E2E検証済み | ARM64イメージ、private subnet、Cognito認証Listener Rule、最小権限Task Role |
| 構造化提案・カード連携 | AWSへ反映・E2E検証済み | RuntimeのPydantic契約、BFF再検証、候補選択、承認カード自動反映 |

構成図 [`bizflow_agent_architecture.drawio`](../bizflow_agent_architecture.drawio) は完成形の目標構成です。現在動いているリソースと目標構成を混同しないよう、上表を実装状況の基準とします。

## 架空データ

ポートフォリオでは外部データセットを転載せず、著作権、個人情報、利用条件を気にせずGitHubへ公開できる合成データを使用します。

- [`business_requests.csv`](../lambdas/business_tools/data/business_requests.csv)
- [`company_rules.md`](../lambdas/business_tools/data/company_rules.md)

CSVには契約、障害、請求、総務、注文、申請の問い合わせを含めています。デモ基準日は`2026-07-13`、取得期間は`2026-07-10`から`2026-07-13`に固定すると、同じ分析結果を繰り返し説明できます。

期待される主な判定は次のとおりです。

- `REQ-002`: 期限超過かつ緊急度high
- `REQ-003`: 未対応かつ緊急度high、請求ルール対象
- `REQ-005`: 対応中かつ緊急度high、障害ルール対象
- `REQ-008`: 未対応かつ緊急度high

## 5つの業務操作

AgentCore Gatewayへ登録する4つの読み取りツール定義は [`tool-schema.json`](../lambdas/business_tools/tool-schema.json) にあります。GatewayのLambda targetが渡す`bedrockAgentCoreToolName`を使い、共通のLambda handlerから各処理へ振り分けます。5つ目の`create_business_task`はGatewayへ公開せず、Cognito認証済みWeb/BFFだけがWrite Lambdaを直接呼び出します。AWS上では同じコードを読み取り専用Lambdaと書き込み専用Lambdaへ分け、`BIZFLOW_ALLOWED_TOOLS`とIAM Policyの両方で境界を作ります。

| ツール | 種別 | 現在の実装 |
|---|---|---|
| `get_business_requests` | 読み取り | 指定期間と任意フィルターでCSVを取得 |
| `analyze_request_data` | 読み取り | 件数、カテゴリー、緊急度、状態、期限超過をPythonで決定的に集計 |
| `search_company_rules` | 読み取り | Markdownルールをキーワードで検索し、`RULE-xxx`を根拠として返す |
| `create_business_task` | 書き込み | バックエンドで承認を再検証し、承認内容と完全一致するタスクだけを登録 |
| `get_task_status` | 読み取り | 登録済みタスク、承認ID、承認者、状態、監査イベントを取得 |

`analyze_request_data`はLambda内の決定的集計として残します。新しい`analyze_business_data_with_code_interpreter`はGatewayまたは利用者から得たデータをAWS管理の隔離Sandboxで追加集計・検算します。現在はテキスト結果をLLMへ返す段階で、生成グラフのS3永続化は未実装です。

## Human-in-the-loop

`create_business_task`へ`approved=true`のような自己申告フラグは渡しません。承認カードを表示するWeb/BFFが、提案内容を承認ストアへ保存し、承認者の操作で状態を`APPROVED`へ変更します。書き込みLambdaは次をすべて満たした場合だけ登録します。

1. 承認IDが存在する。
2. 状態が`APPROVED`である。
3. 問い合わせID、担当者、期限、対応内容が承認時の提案と完全一致する。
4. 同じ承認・同じ内容のタスクが未登録である。

未承認は`APPROVAL_REQUIRED`、承認後にAgentが内容を変更した場合は`APPROVAL_MISMATCH`として拒否します。同じ操作を再送した場合は既存タスクを返すため、二重登録になりません。

承認依頼、承認または却下、タスク登録、未承認・不一致による登録拒否はactorと時刻を持つ監査イベントとして記録し、`get_task_status`から時系列で確認できます。

ローカルデモではメモリ保持の`MockWorkflowStore`を使います。Lambda環境では`DynamoWorkflowStore`へ切り替わり、承認、タスク、監査イベントを単一テーブルへ永続化します。

承認要求、承認、却下、状態取得を行うBFF向けLambdaはAWSへ反映済みで、DynamoDBの承認本体と監査イベントを確認済みです。このLambdaはGateway targetにしません。Next.js BFFはCognito identityからactorを決め、承認済み提案を再取得してWrite Lambdaへ渡します。AWS上でもCognito承認者による分析、承認、タスク登録、監査イベント3件のE2Eを確認済みです。

Agentは`proposed_actions`として問い合わせID、担当者、期限、対応内容、理由、参照ルールを構造化して返します。BFFは読み取り専用契約を再検証し、正常な候補だけを承認カードへ自動反映します。これによりAgentの文章をWebが解析したり、固定のカード初期値を使用したりしません。この経路はAWS Web E2Eまで確認済みです。

## 面接デモの完成フロー

1. Cognitoでログインする。
2. 「今週の問い合わせを分析し、緊急度が高く未対応の案件を抽出してください」と入力する。
3. Agentが`get_business_requests`を選択する。
4. Code Interpreterまたは`analyze_request_data`がCSVを集計する。
5. `search_company_rules`が障害、期限超過、請求のルールを返す。
6. Agentが担当者、期限、対応内容を提案する。
7. Webが承認カードを表示する。
8. 未承認状態での登録がLambdaに拒否されることを示す。
9. 利用者が承認する。
10. `create_business_task`が承認内容を再検証して登録する。
11. `get_task_status`と実行履歴画面で結果を確認する。

## 今後の実装順序

ツール基盤とWeb基盤のCDKソースはFoundationおよび通常のRuntime更新から分離しています。WebはFoundationとServiceをさらに分け、ECR作成、digest固定イメージ公開、ECS Service追加を段階的に行えるようにします。

1. 完了: S3へ架空CSVと社内ルールを配置する構成。
2. 完了: DynamoDBへ承認、タスク、監査履歴を保存する構成とadapter。
3. 完了: 読み取り用と書き込み用の権限を分離したLambda。
4. 完了: AgentCore Gateway、読み取り／書き込みLambda、初期2 targetと5ツールのschema。
5. 完了: CDK diffを確認し、明示承認後にTools Stackをdeployする。
6. 完了: Gatewayを直接スモークテストし、読み取りツールだけをRuntime Version 4へ接続する。
7. 完了: BFF専用の承認要求・承認・却下・状態取得Lambdaを追加する。
8. 完了: Tools Stackへ承認Lambdaを反映し、承認状態と監査履歴を確認する。
9. 完了: 管理済みCode Interpreterのソースを実装し、Foundation IAM差分をdeployする。
10. 完了: Runtime Version 5へCode Interpreterを反映し、Python計算とCloudWatch Logsで実呼び出しを確認する。
11. 完了: 同一Runtime session内のAgentCore短期Memoryを実装する。
12. 完了: Memory StackとRuntime Version 6をAWSへ反映し、2ターンの保存・再取得を確認する。
13. 完了: Cognito、Next.js/BFF、ECS/Fargate、承認カードと実行履歴画面を追加する。
14. 完了: Web Foundation、Web Service、BFF用Lambda更新をdeployし、Cognitoログインからタスク登録・監査履歴までE2E検証する。
15. 完了: Agentの構造化提案、BFF契約検証、承認カード自動反映を追加する。
16. 完了: 構造化提案対応RuntimeとWebを更新し、承認・タスク登録までE2Eを再確認する。
17. 完了: Cognitoの信頼済み利用者IDを使うUser Preference strategyとBFF委任を追加する。
18. 完了: Memory Stack、Runtime Version 8、Web Serviceへ反映し、別conversationと別利用者で長期Memory分離をE2E確認する。
19. 完了・AWS反映済み: Write LambdaでGateway contextを拒否し、既存Write targetのDeletionPolicyを`Delete`へ変更する。
20. ローカル実装済み・AWS反映前: Gateway Write targetと書き込みtool schemaを削除し、4つの読み取りツールだけを公開する。
21. 信頼できるtenant claimを導入する場合だけ、会社共有Memoryを利用者Memoryと別namespaceで追加する。

Tools Stackのリソース、IAM境界、データモデル、Outputs、反映前確認は [`tools-infrastructure.md`](tools-infrastructure.md) にまとめています。

GatewayはLambdaやAPIをMCPツールとして公開でき、Code InterpreterはCSV、Excel、JSONなどの構造化データを隔離環境で処理できます。Memoryは会話の短期履歴と、利用者設定などの長期記憶に使用します。

## ローカルテスト

### シナリオデモ

問い合わせ取得から承認後のタスク登録までをAWSへ接続せず実行します。

```powershell
.\.venv\Scripts\python.exe .\scripts\demo-business-tools.py
```

出力では、同じ提案が`PENDING`の間は`APPROVAL_REQUIRED`で拒否され、承認後だけ`REGISTERED`になることを確認できます。

### 自動テスト

AWSへ接続せず、4つのGateway読み取りツール、BFF専用タスク登録、承認境界を検証します。

```powershell
.\.venv\Scripts\python.exe -m pytest .\tests\tools
```

Runtimeを含む全Pythonテストは次のとおりです。

```powershell
.\.venv\Scripts\python.exe -m pytest .\tests
```

CDKの型チェック、テンプレートテスト、Tools Stackのローカルsynthは次のとおりです。AWS CLIやAWS APIは使用しません。

```powershell
npm run build
npm test
npx cdk synth BizFlowAgentToolsStack `
  --context "environment=dev" `
  --context "enableTools=true" `
  --no-lookups
```

Web/BFFはAWSへ接続しないlocal demoで確認できます。

```powershell
Set-Location .\web
npm ci
npm run typecheck
npm test
npm run build
$env:BIZFLOW_LOCAL_DEMO = "true"
npm run dev
```

ブラウザで`http://127.0.0.1:3000`を開き、分析、承認、タスク登録、履歴検索を確認します。Web CDKとAWSへの段階的な反映順序は [`web-application.md`](web-application.md) に記載しています。

## AWS公式資料

- [AgentCore GatewayのLambda target](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html)
- [AgentCore Gatewayの基本概念](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-core-concepts.html)
- [AgentCore Code Interpreter](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html)
- [AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html)
- [Application Load BalancerのCognito認証](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)
- [AgentCore RuntimeをSDKから呼び出す](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html)
