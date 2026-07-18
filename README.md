# BizFlow Agent

Amazon Bedrock AgentCore Runtimeで動作するBizFlowエージェントのコンテナ、テスト、公開スクリプトを管理するリポジトリです。

開発はWindows 11ネイティブ、PowerShell、Docker DesktopのLinux containersモードを前提とし、WSLは使用しません。

AWS基盤は、以前のアプリやCDKスタックで作成したリソースを再利用しません。今回のBizFlowアプリ専用スタックとして新規作成します。初期構築だけCDKを使い、通常のエージェント更新ではCDKを実行せず、ARM64コンテナイメージのbuild、ECRへのpush、Runtimeバージョン作成、DEFAULT Endpoint切り替えを個別に行います。

## 現在の実装範囲

AgentCore Runtimeが要求する次のHTTP Endpointを実装しています。

- `GET /ping`
- `POST /invocations`
- ホスト：`0.0.0.0`
- ポート：`8080`
- コンテナ：`linux/arm64`

`agents/bizflow/app.py` の `handle_invocation()` は、HTTP・コンテナ・デプロイ経路を検証するための最小応答です。実際のStrands AgentsやBizFlow業務処理は、この関数へ接続してください。

## ファイル構成

```text
bizflow-agent/
├── agents/
│   ├── __init__.py
│   └── bizflow/
│       ├── __init__.py
│       ├── app.py
│       ├── Dockerfile
│       ├── .dockerignore
│       ├── requirements.txt
│       └── requirements-dev.txt
├── config/
│   ├── agentcore.example.json
│   └── cdk-outputs.json          # BizFlow専用CDKが実行時に生成
├── docs/
│   └── deployment.md
├── infra/
│   ├── bin/
│   │   └── bizflow-agent.ts
│   ├── lib/
│   │   ├── foundation-stack.ts
│   │   └── runtime-stack.ts
│   └── test/
│       ├── foundation-stack.test.ts
│       └── runtime-stack.test.ts
├── scripts/
│   ├── publish-agentcore.ps1
│   └── smoke-test-agentcore.ps1
├── tests/
│   └── runtime/
│       └── test_endpoints.py
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
| `agents/bizflow/app.py` | FastAPIによるAgentCore HTTP Runtimeです。`/ping`、`/invocations`、入力検証、Runtime session IDヘッダーの受け渡し、内部エラーのマスキングを実装しています。 |
| `agents/bizflow/Dockerfile` | Python 3.12ベースのRuntimeイメージを作成します。ポート8080を公開し、非rootユーザー `app` でUvicornを起動します。 |
| `agents/bizflow/.dockerignore` | Git情報、仮想環境、テスト、ドキュメント、ローカル設定などをDocker build contextから除外します。 |
| `agents/bizflow/requirements.txt` | Runtimeで必要なFastAPIとUvicornの固定バージョンを定義します。 |
| `agents/bizflow/requirements-dev.txt` | Runtime依存関係に加え、pytestとHTTPテスト用パッケージを定義します。 |

### 設定・公開

| ファイル | 説明 |
|---|---|
| `config/agentcore.example.json` | BizFlow専用CDK Outputsまたは環境別設定ファイルの形式例です。値は例示用であり、そのまま使用しません。 |
| `config/cdk-outputs.json` | BizFlow専用スタックの初期構築後に生成する環境固有ファイルです。現在入っている例示値はAWSリソースを示していないため、公開には使用できません。 |
| `scripts/publish-agentcore.ps1` | Git SHAタグによるARM64イメージ公開とAgentCore Runtime更新を行います。デフォルトはdry-runで、`-Execute` 指定時のみbuild/pushとRuntime更新へ進みます。 |
| `scripts/smoke-test-agentcore.ps1` | ローカルコンテナまたはAgentCore上のDEFAULT Endpointを検証します。リモートではEndpoint状態・liveVersion・実呼び出しを確認します。 |
| `docs/deployment.md` | Windowsネイティブ環境の準備、CDK Outputs契約、dry-run、公開、ヘルスチェック、デプロイ記録、ロールバックの詳細手順です。 |

### CDK基盤

| ファイル | 説明 |
|---|---|
| `infra/bin/bizflow-agent.ts` | CDKアプリのエントリーポイントです。常にFoundation Stackを定義し、`agentImageDigest` contextがある場合だけRuntime Stackも定義します。 |
| `infra/lib/foundation-stack.ts` | BizFlow専用ECR、AgentCore実行IAMロール、`PUBLIC`ネットワーク設定を作成します。ECRは不変タグ、push時scan、Retainを設定します。 |
| `infra/lib/runtime-stack.ts` | digest固定の初回コンテナからAgentCore Runtime、30日保持のRuntimeロググループ、通常更新用Outputsを作成します。`DEFAULT` EndpointはRuntime作成時にAgentCoreが自動作成します。 |
| `infra/test/foundation-stack.test.ts` | ECRとIAM、およびFoundation OutputsのCloudFormation定義を検証します。 |
| `infra/test/runtime-stack.test.ts` | Runtime、Endpoint、ログ、Outputsを検証し、タグや不正なdigestを拒否することを確認します。 |
| `package.json` / `package-lock.json` | Node.js/CDK依存関係を固定し、型チェックとCDKテストのコマンドを定義します。Node.js 20以上が必要です。 |
| `cdk.json` / `tsconfig.json` / `jest.config.js` | CDKエントリーポイント、TypeScript厳格設定、Jest設定です。 |

`publish-agentcore.ps1` には次の安全策があります。

- `AWS_PROFILE` と `AWS_REGION` を必須入力にする
- `sts get-caller-identity` で接続先を表示する
- root ARNを拒否する
- AWS AccountとECR URIのAccountが異なる場合に停止する
- ECRが `IMMUTABLE` かつscan-on-push有効であることを確認する
- dirty worktreeを拒否し、GitコミットSHAとコンテナ内容を一致させる
- `latest` タグを使わない
- Runtimeが `READY` になるまでEndpointを更新しない
- 新Runtimeバージョンの手入力後にだけDEFAULT Endpointを切り替える
- 旧バージョンへ戻すコマンドを最後に表示する

### テスト・補助ファイル

| ファイル | 説明 |
|---|---|
| `tests/runtime/test_endpoints.py` | `/ping`、`/invocations`、入力エラー、session ID、内部エラー応答をAWS接続なしで検証するpytestです。 |
| `.gitignore` | 仮想環境、Pythonキャッシュ、CDK成果物、環境別CDK Outputs、生成したデプロイ記録をGit管理対象から除外します。 |
| `bizflow_agent_architecture.drawio` | BizFlow AgentのAWS全体構成と処理フローを示すdraw.io構成図です。 |
| `プロンプト.txt` | 開発環境、コンテナ方式、イメージ管理、IaCと通常更新の分離方針を記録しています。 |

## AWS基盤のライフサイクル

### 初期構築

他プロジェクトのECR、IAMロール、VPC、AgentCore Runtime、Endpointは参照しません。BizFlow専用のリソースを次の順序で作成します。

1. `BizFlowAgentFoundationStack` を新規deployする。
   - BizFlow専用ECRリポジトリ
   - AgentCore Runtime実行IAMロール
   - Runtimeログ、メトリクス、トレースに必要なIAM権限
   - `PUBLIC`ネットワーク設定
2. 作成した専用ECRへ、最初の `linux/arm64` イメージをGit SHAタグでpushする。
3. push済みイメージのdigest URIを使い、`BizFlowAgentRuntimeStack` を新規deployする。
   - 初期AgentCore Runtime
   - Runtime作成時にAgentCoreが自動作成する初期Versionと`DEFAULT` Runtime Endpoint
   - AgentCore標準命名のCloudWatch Logsロググループ
   - 公開スクリプトが必要とするCDK Outputs
4. Outputsを `config/cdk-outputs.json` に保存する。
5. 初期RuntimeとDEFAULT Endpointのヘルスチェックを行う。

AgentCore Runtimeは、空のECRリポジトリだけでは作成できません。初回イメージが必要になるため、FoundationとRuntimeを段階分けします。Runtime StackにはECR URI全体ではなく `sha256:...` digestだけを渡し、今回のFoundation Stackが作成したECR URIとCDK内で結合します。別プロジェクトのECRを誤って参照できない設計です。

CDKソースとローカルテストは実装済みです。AWSリソースの作成は自動では始まりません。実行手順を確認し、対象Account・RegionへのAWS変更を明示的に承認した後で、`docs/deployment.md` の初期構築コマンドを利用します。

### 通常更新

初期構築後は、同じBizFlow専用Runtimeのバージョンだけを更新します。

1. Docker buildと専用ECRへのpush
2. `UpdateAgentRuntime` による新Runtimeバージョン作成
3. `READY` 待機
4. 明示確認後にDEFAULT Endpointを切り替え
5. スモークテスト

この段階では `cdk deploy` を実行しません。再利用するのは他アプリのAWS構成ではなく、今回新規作成したBizFlow専用スタックのOutputsです。

## ローカルテスト

### CDK

Node.js 20以上を使用します。

```powershell
npm ci
npm run build
npm test
```

これらはTypeScriptの型チェックとCloudFormationテンプレートのユニットテストであり、AWSリソースを変更しません。

### Pythonテスト

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --requirement .\agents\bizflow\requirements-dev.txt
python -m pytest .\tests\runtime\test_endpoints.py
```

### ARM64コンテナ

```powershell
docker buildx build `
  --platform linux/arm64 `
  --file .\agents\bizflow\Dockerfile `
  --tag bizflow-agent:local `
  --load `
  .\agents\bizflow

docker run --rm --platform linux/arm64 --publish 8080:8080 bizflow-agent:local
```

別のPowerShellでスモークテストを実行します。

```powershell
.\scripts\smoke-test-agentcore.ps1 -LocalBaseUrl http://127.0.0.1:8080
```

## 通常更新の公開前確認

BizFlow専用基盤の初期構築が完了した後、通常更新では最初にdry-runを実行します。

```powershell
.\scripts\publish-agentcore.ps1 `
  -AWS_PROFILE <SSOプロファイル名> `
  -AWS_REGION <AWSリージョン> `
  -ConfigPath .\config\cdk-outputs.json `
  -StackName BizFlowAgentRuntimeStack
```

`publish-agentcore.ps1` はAWS基盤を作成しません。初期基盤はBizFlow専用CDKスタックで新規作成し、通常更新時には `cdk deploy` を実行しません。詳細は [`docs/deployment.md`](docs/deployment.md) を参照してください。
