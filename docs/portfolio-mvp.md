# BizFlow Agent ポートフォリオMVP

## コンセプト

自然言語で依頼すると、社内データとルールを調査・分析して必要な対応を提案し、利用者が承認した内容だけを業務システムへ登録するAIエージェントです。

特定業界の固有処理をAgent本体へ埋め込まず、データとツールの契約を差し替えられる構成にします。今回の画面とデモは問い合わせ管理に絞り、営業、カスタマーサポート、総務、プロジェクト管理、経営企画、個人事業主などへ展開できる設計を示します。

## 実装状態

| 段階 | 状態 | 内容 |
|---|---|---|
| AgentCore Runtime | AWSで稼働済み | Version 6、Nova 2 Lite、Gateway読み取りツール、Code Interpreter、短期Memory、`PROD` Endpoint確認済み |
| 架空業務データ | ローカル実装済み | 個人情報を含まないCSVとMarkdownの社内ルール |
| Lambda業務ツール | CDK・ローカル実装済み | Gateway Lambda target互換の5ツール、S3/DynamoDB adapter、読み取り・書き込み関数の分離 |
| Human-in-the-loop境界 | CDK・ローカル実装済み | DynamoDBで未承認拒否、承認後改変拒否、重複登録防止、監査記録 |
| S3・DynamoDB・Lambda・Gateway | AWSへdeploy済み | 2026-07-22にTools Stackを反映し、Outputsを環境別設定へ保存 |
| Runtimeからのツール選択 | AWSへ反映済み | Version 6でSigV4 MCP clientから4つの読み取りツールだけを公開 |
| 承認バックエンドLambda | AWSへdeploy・検証済み | Gatewayから分離し、承認要求・承認・却下・状態取得を処理 |
| Code Interpreter | AWSへ反映・検証済み | Version 6への更新時も自動スモークテスト成功 |
| AgentCore Memory | AWSへ反映・検証済み | Version 6で同一Runtime sessionの2ターン保存・再取得に成功。長期設定は認証後に追加 |
| Next.js・Fargate・Cognito | 未実装 | フロントエンドとECSは最後の工程で追加する |

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

## 5つのツール

AgentCore Gatewayへ登録するツール定義は [`tool-schema.json`](../lambdas/business_tools/tool-schema.json) にあります。GatewayのLambda targetが渡す`bedrockAgentCoreToolName`を使い、共通のLambda handlerから各処理へ振り分けます。AWS上では同じコードを読み取り専用Lambdaと書き込み専用Lambdaへ分け、`BIZFLOW_ALLOWED_TOOLS`とIAM Policyの両方で境界を作ります。

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

承認要求、承認、却下、状態取得を行うBFF向けLambdaはAWSへ反映済みで、DynamoDBの承認本体と監査イベントを確認済みです。このLambdaはGateway targetにせず、将来のBFFからのみ呼び出します。Web画面、Cognito認証、BFFの利用者claims連携は最後の工程で追加します。

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

ツール基盤のCDKソースはFoundationと通常のRuntime更新から分離し、`enableTools=true`の場合だけ定義します。既存RuntimeロールARNはOutputsから自動取得します。フロントエンドとECSは最後に追加し、それまでは業務処理、承認境界、分析機能を先に完成させます。

1. 完了: S3へ架空CSVと社内ルールを配置する構成。
2. 完了: DynamoDBへ承認、タスク、監査履歴を保存する構成とadapter。
3. 完了: 読み取り用と書き込み用の権限を分離したLambda。
4. 完了: AgentCore Gateway、2つのLambda target、5ツールのschema。
5. 完了: CDK diffを確認し、明示承認後にTools Stackをdeployする。
6. 完了: Gatewayを直接スモークテストし、読み取りツールだけをRuntime Version 4へ接続する。
7. 完了: BFF専用の承認要求・承認・却下・状態取得Lambdaを追加する。
8. 完了: Tools Stackへ承認Lambdaを反映し、承認状態と監査履歴を確認する。
9. 完了: 管理済みCode Interpreterのソースを実装し、Foundation IAM差分をdeployする。
10. 完了: Runtime Version 5へCode Interpreterを反映し、Python計算とCloudWatch Logsで実呼び出しを確認する。
11. 完了: 同一Runtime session内のAgentCore短期Memoryを実装する。
12. 完了: Memory StackとRuntime Version 6をAWSへ反映し、2ターンの保存・再取得を確認する。
13. 最後にCognito、Next.js/BFF、ECS/Fargate、承認カードと実行履歴画面を追加する。
14. Cognitoの信頼済み利用者・会社IDを使う長期Memory strategyを追加する。
15. Web承認フローのE2E検証後だけ、`create_business_task`をRuntimeの書き込み経路へ公開する。

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

AWSへ接続せず、5ツールと承認境界を検証します。

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

## AWS公式資料

- [AgentCore GatewayのLambda target](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html)
- [AgentCore Gatewayの基本概念](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-core-concepts.html)
- [AgentCore Code Interpreter](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html)
- [AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html)
