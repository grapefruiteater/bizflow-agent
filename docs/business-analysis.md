# 問い合わせ分析のデータ契約

## 目的と現在の範囲

BizFlow Agentは、呼び出し元が`POST /invocations`へ渡した問い合わせ一覧を読み取り専用で分析します。Runtimeは期限超過などの事実判定をPythonで決定的に計算し、その結果を根拠としてLLMが日本語の要約と提案を作成します。

現時点ではDynamoDB、S3、CRMなどからデータを取得せず、入力データの更新、タスク登録、承認、外部送信も行いません。会話履歴も保持しません。

## リクエスト例

`business_data`はトップレベル、または`input`の内側のどちらか一方に指定できます。

```json
{
  "prompt": "対応が必要な問い合わせを優先順位順に分析してください。",
  "business_data": {
    "as_of": "2026-07-21T10:00:00+09:00",
    "inquiries": [
      {
        "inquiry_id": "INQ-001",
        "summary": "納期確認への回答が期限を超過している",
        "received_at": "2026-07-19T09:00:00+09:00",
        "due_at": "2026-07-21T09:00:00+09:00",
        "priority": "URGENT",
        "status": "OPEN",
        "category": "納期"
      },
      {
        "inquiry_id": "INQ-002",
        "summary": "見積条件の確認待ち",
        "received_at": "2026-07-20T09:00:00+09:00",
        "due_at": "2026-07-22T09:00:00+09:00",
        "priority": "HIGH",
        "status": "IN_PROGRESS"
      }
    ],
    "rules": [
      "期限超過を最優先にする"
    ]
  }
}
```

`business_data`を省略した従来の`{"prompt":"..."}`形式も引き続き利用できます。その場合は構造化された事実判定を行わず、入力された自由文だけをLLMが分析します。

## 入力項目

| 項目 | 必須 | 制約 |
|---|---:|---|
| `as_of` | はい | 判定基準時刻。UTCオフセットを含むISO 8601日時。現在時刻を暗黙利用しません。 |
| `inquiries` | はい | 1～100件。`inquiry_id`はリクエスト内で一意。 |
| `inquiry_id` | はい | 1～64文字。英数字で始まり、英数字、`.`, `_`, `:`, `-`のみ。 |
| `summary` | はい | 1～500文字。 |
| `received_at` | はい | UTCオフセットを含む日時。`as_of`より後は不可。 |
| `due_at` | いいえ | UTCオフセットを含む日時。`received_at`より前は不可。 |
| `priority` | いいえ | `LOW`, `NORMAL`, `HIGH`, `URGENT`。省略時は`NORMAL`。 |
| `status` | いいえ | `OPEN`, `IN_PROGRESS`, `WAITING`, `CLOSED`。省略時は`OPEN`。 |
| `category` | いいえ | 1～500文字。 |
| `rules` | いいえ | 最大20件、各1～500文字。呼び出し元が提示する業務上の補足規則。 |

定義されていない追加フィールドは受け付けません。不正な入力にはHTTP 422を返し、エラー応答へ`summary`などの入力値を転載しません。

## 決定的な判定

`CLOSED`以外を対応中として、`as_of`を基準に次をPython側で計算します。

- 期限超過: 対応中かつ`due_at < as_of`
- 緊急: 対応中かつ`priority = URGENT`
- 24時間以内期限: 対応中かつ`as_of <= due_at <= as_of + 24時間`

完了済みの問い合わせは、期限や優先度の値にかかわらず上記リストへ含めません。LLMには計算済みフラグを変更しないこと、根拠として`inquiry_id`を示すことを指示します。

## 応答例

```json
{
  "response": "要約: INQ-001を最優先で確認してください。...",
  "status": "success",
  "execution_mode": "READ_ONLY",
  "write_operations_performed": false,
  "analysis_context": {
    "as_of": "2026-07-21T10:00:00+09:00",
    "total_inquiries": 2,
    "active_inquiries": 2,
    "overdue_inquiry_ids": ["INQ-001"],
    "urgent_inquiry_ids": ["INQ-001"],
    "due_within_24_hours_inquiry_ids": ["INQ-002"]
  }
}
```

`analysis_context`はRuntimeが計算した機械判定であり、`response`はそのコンテキストを使ったLLMの文章です。呼び出し側は重要な業務分岐にLLM文章ではなく`analysis_context`を利用できます。

## ローカル検証

次のテストはAWSへ接続しません。

```powershell
.\.venv\Scripts\python.exe -m pytest .\tests\runtime
```

境界条件は`tests/runtime/test_business_data.py`、HTTP契約は`tests/runtime/test_endpoints.py`で検証します。
