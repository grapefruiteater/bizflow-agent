# AgentCore Code Interpreter

## 現在の状態

AWS管理のAgentCore Code Interpreter `aws.codeinterpreter.v1`を、BizFlow Runtimeの読み取り専用分析ツールとして使用するソース、IAM Policy、公開スクリプト、ローカルテストを実装済みです。現在稼働中のRuntime Version 4にはまだ反映していません。

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

1. すべてのソース変更をGitへコミットする。
2. Foundation Stackのdiffで`UseManagedCodeInterpreter` IAM statementだけが追加されることを確認する。
3. Foundation StackへIAM差分を反映する。
4. `publish-agentcore.ps1`のdry-runへ`-EnableReadTools -EnableCodeInterpreter`を指定する。
5. `-Execute`で新Runtime Versionを作成する。
6. `READY`後、明示確認して`PROD`を新Versionへ切り替える。
7. 公開スクリプトがランダムな文字列のSHA-256をPythonで計算させ、期待digestとの一致を確認する。
8. CloudWatch LogsとAgentCore observabilityでセッション開始・完了を確認する。

Foundation IAM変更とRuntime更新は別の変更として実行します。Code Interpreter用の新しいAWSリソースは作成しません。

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
- 会話・利用者設定の保持はAgentCore Memoryの後続工程で実装する。

## AWS公式資料

- [AgentCore Code Interpreter概要](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html)
- [StrandsからCode Interpreterを使用する](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-using-strands.html)
- [Code Interpreter sessionの開始](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-start-session.html)
- [Code Interpreterでコードを実行する](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-execute-code.html)
- [Code Interpreter sessionの終了](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-stop-session.html)
- [Code Interpreter resource管理](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-resource-management.html)
