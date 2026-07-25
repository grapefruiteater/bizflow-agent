# AgentCore Code Interpreter

## 現在の状態

AWS管理のAgentCore Code Interpreter `aws.codeinterpreter.v1`を、BizFlow Runtimeの読み取り専用分析ツールとして使用するソース、IAM Policy、公開スクリプト、ローカルテストを実装済みです。2026-07-22にRuntime実行ロールの`UseManagedCodeInterpreter`権限をFoundation Stackへdeployし、Runtime Version 5で実呼び出しを確認しました。利用者別長期Memoryを追加したRuntime Version 8への更新時にもCode Interpreter自動スモークテストが成功しています。

AgentCoreコンソールからVersion 5へPythonによる1から100までの整数の二乗和を依頼し、期待値`338350`を得ました。CloudWatch Logsの`bizflow.code_interpreter Code Interpreter analysis completed`も確認したため、ツール選択、Python実行、結果取得、セッション終了まで実環境検証済みです。

専用Code Interpreterリソースは作成しません。AWSが提供する管理済みSystem Code Interpreterを使用し、追加の業務データアクセス権限や公開ネットワークを持たせません。

## 処理フロー

```text
利用者
  ↓
AgentCore Runtime / Strands Agent
  ├─ Gateway: 問い合わせと社内ルールを読み取る
  ├─ analyze_request_data: 主要指標をLambdaで決定的に計算する
  └─ analyze_business_data_with_code_interpreter
       ↓ Start session
     AWS管理SandboxでPythonを実行
       ↓ text result
     セッションを必ずStop
```

Code InterpreterはS3やDynamoDBを直接読みません。Gatewayまたは利用者から取得済みのデータだけを、モデルがPythonコードへ含めて計算します。このため、業務データの取得権限とコード実行権限を分離できます。

## Runtimeツール

Strands Agentには`analyze_business_data_with_code_interpreter`を追加します。

- 複数件の集計、割合、傾向、クロス集計、検算に使用する。
- Pythonだけを使用する。
- コードは最大16,000文字、説明は最大500文字に制限する。
- 出力は最大20,000文字に制限する。
- サービス例外やPythonエラーの内部詳細を利用者へ公開しない。
- 1回のツール呼び出しごとに新しい隔離セッションを作成し、成功・失敗にかかわらず停止する。
- resource IDは`aws.codeinterpreter.v1`だけを許可する。

既存の`analyze_request_data`は削除しません。期限超過や緊急度などの主要判定はLambdaの決定的結果を優先し、Code Interpreterは追加集計と検算を担当します。

## IAM

Runtime実行ロールには管理済みCode Interpreter ARNだけを対象に、次の権限を追加します。

- `bedrock-agentcore:StartCodeInterpreterSession`
- `bedrock-agentcore:StopCodeInterpreterSession`
- `bedrock-agentcore:GetCodeInterpreterSession`
- `bedrock-agentcore:ListCodeInterpreterSessions`
- `bedrock-agentcore:InvokeCodeInterpreter`

対象ARNは次の形式です。

```text
arn:aws:bedrock-agentcore:<region>:aws:code-interpreter/*
```

`CreateCodeInterpreter`と`DeleteCodeInterpreter`は許可しません。

## Runtime設定

Code Interpreterは明示的に有効化したRuntime Versionだけで使用できます。

```text
BIZFLOW_CODE_INTERPRETER_ID=aws.codeinterpreter.v1
```

`publish-agentcore.ps1`では次のスイッチを指定します。

```text
-EnableCodeInterpreter
```

カスタムCode Interpreter IDは現在の公開ワークフローで拒否します。

## AWS反映順序

1. 完了: Code Interpreterのソース変更をGitへコミットする。Runtime公開前には、この状態更新を含む文書差分もコミットしてworktreeをcleanにする。
2. 完了: Foundation Stackのdiffで`UseManagedCodeInterpreter` IAM statementだけが追加されることを確認する。
3. 完了: Foundation StackへIAM差分を反映する。
4. 完了: `publish-agentcore.ps1`のdry-runへ`-EnableReadTools -EnableCodeInterpreter`を指定する。
5. 完了: `-Execute`でRuntime Version 5を作成する。
6. 完了: `READY`後、明示確認して`PROD`をVersion 5へ切り替える。
7. 完了: Python計算と読み取り専用応答契約を確認する。
8. 完了: CloudWatch LogsでCode Interpreterの完了ログを確認する。

Foundation IAM変更とRuntime更新は別の変更として実行します。Code Interpreter用の新しいAWSリソースは作成しません。

## 機能確認

### 1. dry-run

まず通常更新をdry-runし、対象アカウント、ECR、Runtime、`PROD` Endpointを確認します。

```powershell
.\scripts\publish-agentcore.ps1 `
  -AWS_PROFILE <SSOプロファイル名> `
  -AWS_REGION ap-northeast-1 `
  -ModelId jp.amazon.nova-2-lite-v1:0 `
  -ConfigPath .\config\cdk-outputs.json `
  -StackName BizFlowAgentRuntimeStack `
  -EnableReadTools `
  -EnableCodeInterpreter `
  -ToolsConfigPath .\config\tools-outputs.json
```

次の表示を確認します。

- `Endpoint: PROD`
- `Read tools: True`
- `Code Interpreter: True`
- `Interpreter ID: aws.codeinterpreter.v1`
- `DRY RUN`で終了し、build、push、Runtime更新、Endpoint更新を実行していない

### 2. Runtime更新と自動スモークテスト

dry-runが正常なら、同じコマンドの最後へ`-Execute`を追加します。新Runtime Versionが`READY`になった後、表示された新バージョン番号を手入力した場合だけ`PROD`を切り替えます。

公開スクリプトは切り替え後、次の2種類を自動確認します。

1. Runtime応答契約が`status=success`、`execution_mode=READ_ONLY`、`write_operations_performed=false`であること。
2. Git SHAと新Runtime Versionから作った文字列のSHA-256を、`analyze_business_data_with_code_interpreter`のPythonで計算し、ローカルで計算した期待digestと応答が一致すること。

成功時は次を確認します。

- `Smoke test succeeded.`が2回表示される。
- 最終結果が`Deployment succeeded.`になる。
- `deployments/agentcore/*.json`の`status`が`SUCCEEDED`になる。
- 同じ記録の`smokeTest`と`codeInterpreterSmokeTest`がどちらも`PASSED`になる。
- `runtimeVersion`と`endpointLiveVersion`が同じ新バージョンになる。

### 3. CloudWatch Logs

`/aws/bedrock-agentcore/runtimes/<Runtime ID>-PROD`ロググループで、スモークテスト時刻付近の次のアプリケーションログを確認します。

```text
Starting Code Interpreter analysis
Code Interpreter analysis completed
```

CloudWatch Logs Insightsでは次のクエリで絞り込めます。

```text
fields @timestamp, @message
| filter @message like /Code Interpreter analysis/
| sort @timestamp desc
| limit 20
```

SHA-256一致だけでなく、この開始・完了ログも揃えば、LLMがCode Interpreterツールを選択し、セッションが正常終了したことを確認できます。エラー時は公開スクリプトが`FAILED`を記録し、`PROD`を旧バージョンへ戻すコマンドを表示します。

### 4. コンソールからの追加確認

AgentCoreコンソールの`PROD` Endpointへ、次のようにツール利用を明示したプロンプトを送ります。

```text
必ずanalyze_business_data_with_code_interpreterを呼び出し、Pythonで1から100までの整数の二乗和を計算してください。計算結果と、AgentCore Code Interpreterを使用したことを回答してください。
```

期待値は`338350`です。応答の値、実行時刻付近の開始・完了ログ、新Runtime Versionを合わせて確認します。値だけではツール利用の証明にならないため、CloudWatch Logsも確認します。

## ローカル検証

```powershell
.\.venv\Scripts\python.exe -m pytest .\tests\runtime\test_code_interpreter_tools.py -q
npm run build
npm test -- --runInBand
```

ローカルテストはfake session clientを使用し、AWS APIを呼び出しません。

## 制限事項

- 現時点ではテキスト出力だけをLLMへ返す。
- 画像やグラフのS3永続化、署名付きURL発行は未実装。
- Code Interpreterのセッションを利用者の会話間で再利用しない。
- 会話継続は後続のAgentCore短期Memoryで実装する。長期の利用者設定はCognito導入後に追加する。

## AWS公式資料

- [AgentCore Code Interpreter概要](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html)
- [StrandsからCode Interpreterを使用する](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-using-strands.html)
- [Code Interpreter sessionの開始](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-start-session.html)
- [Code Interpreterでコードを実行する](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-execute-code.html)
- [Code Interpreter sessionの終了](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-stop-session.html)
- [Code Interpreter resource管理](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-resource-management.html)
