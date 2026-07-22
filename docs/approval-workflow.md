# 承認バックエンド

## 現在の状態

承認要求、承認、却下、承認状態取得を扱うLambdaをAWSへdeploy済みです。承認要求、状態確認、承認、DynamoDBの承認本体と監査イベントが正常に記録されることを確認しています。

このLambdaはAgentCore Gateway targetへ登録しません。LLMへ承認権限を与えず、将来のNext.js BFFがCognitoで確認した利用者情報を`actor`として渡し、IAMでこの関数だけを呼び出す構成を想定しています。フロントエンド、Cognito、ECSは最後の工程で追加します。

## Lambda操作契約

Lambdaは次の4つの`operation`を受け取ります。

| operation | 用途 | 主な入力 |
|---|---|---|
| `request_approval` | タスク提案を`PENDING`として保存 | `actor`、`proposal` |
| `approve` | 未決定の承認要求を承認 | `actor`、`approval_id` |
| `reject` | 未決定の承認要求を却下 | `actor`、`approval_id` |
| `get_approval` | 承認状態と監査履歴を取得 | `actor`、`approval_id` |

承認要求の例です。

```json
{
  "operation": "request_approval",
  "actor": "portfolio-user",
  "proposal": {
    "request_id": "REQ-002",
    "assignee": "support-lead",
    "due_date": "2026-07-13",
    "action": "障害状況を確認して顧客へ一次回答する"
  }
}
```

承認の例です。

```json
{
  "operation": "approve",
  "actor": "team-manager",
  "approval_id": "APR-XXXXXXXXXXXX"
}
```

成功時は`ok: true`と承認情報・監査履歴を返します。入力不正、存在しない承認ID、決定済み承認の再決定は`ok: false`と安定したエラーコードを返し、内部例外の詳細は公開しません。

## セキュリティ境界

- AgentCore Gatewayには登録しない。
- Runtimeの読み取りツールallow-listへ追加しない。
- 承認Lambdaには対象DynamoDB Tableの`GetItem`、`PutItem`、`Query`、`UpdateItem`だけを許可する。
- `DeleteItem`と`Scan`は許可しない。
- Lambda Function URLや公開API Gatewayは作成しない。
- 将来のBFFロールへ対象関数ARNの`lambda:InvokeFunction`だけを許可する。
- BFF実装時はリクエスト本文の利用者名を信頼せず、Cognitoの検証済みclaimsから`actor`を設定する。

`create_business_task`を処理する書き込みLambdaは、DynamoDB内の承認状態と提案内容の完全一致を再検証します。そのため、承認Lambdaと書き込みLambdaを分離したままでも、未承認・改変済み・重複タスクを拒否できます。

## CDK Outputs

Tools Stackには次のOutputsが追加されています。

- `ApprovalWorkflowFunctionName`
- `ApprovalWorkflowFunctionArn`

Outputsは将来のBFF Stackから関数を参照し、最小権限のinvoke policyを作るために使用します。ARNをアプリケーションソースへ直接埋め込みません。

## ローカル検証

```powershell
.\.venv\Scripts\python.exe -m pytest .\tests\approval_workflow -q
npm run build
npm test -- --runInBand
```

これらはAWS CLIやAWS APIを使用せず、AWSリソースも変更しません。
