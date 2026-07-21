# BizFlow AgentCore Runtime デプロイ手順

## 方針

開いている `bizflow-agent` リポジトリをそのまま使用します。スクリプトは自身の配置場所からリポジトリルートを解決するため、絶対パスをソースコードへ埋め込みません。

開発・デプロイ環境は次の構成です。

- Windows 11ネイティブ
- VS Code Codex拡張機能
- PowerShell
- Docker DesktopのLinux containersモード
- Windows版AWS CLI v2
- IAM Identity CenterのSSOプロファイル
- WSLは使用しない

以前のアプリやCDKスタックで作成したAWSリソースは再利用しません。今回のBizFlowアプリ専用CDKスタックとしてECR、IAMロール、ログ、ネットワーク設定、初期AgentCore Runtime、`PROD` Endpointを新規作成します。通常のアプリ更新では `cdk deploy` を実行せず、Dockerイメージのbuild/push、`UpdateAgentRuntime`、`PROD` Endpoint更新を使用します。サービス管理の`DEFAULT` Endpointは常に最新Versionを指すため、本番トラフィックには使用しません。

> 現在のRuntimeはStrands AgentsとAmazon Bedrockモデルを使う読み取り専用分析まで実装しています。入力外のAWSデータは参照せず、タスク登録などの書き込みツールはまだ実装していません。

## BizFlow専用AWS基盤の新規作成

### 現在の状態

CDKソースは `infra` に実装済みです。初期Foundation、Runtime Version 1、サービス管理`DEFAULT`に加え、Version 1を参照する明示昇格用`PROD` Endpointのデプロイ完了をAWSコンソールで確認済みです。以後のアプリ更新ではCDKを使わず、公開スクリプトで新Versionを作成して`PROD`へ昇格します。

`config/cdk-outputs.json` はBizFlow専用スタックの実環境Outputsです。環境固有情報を含むためGit管理せず、Runtime Stackをdeployしたときだけ更新します。形式例は `config/agentcore.example.json` に保持します。

### スタック分割

初期RuntimeはECR上のコンテナイメージを必要とします。空のECR作成とRuntime作成を一度に行わず、次の2スタックに分けます。

#### `BizFlowAgentFoundationStack`

- BizFlow専用ECRリポジトリ
  - `imageTagMutability: IMMUTABLE`
  - `imageScanOnPush: true`
- BizFlow専用AgentCore Runtime実行IAMロール
  - 専用ECRからのpull
  - AgentCore Runtimeログ、X-Rayトレース、CloudWatchメトリクスの送信
  - 同一RegionのBedrock foundation modelおよび同一Accountのinference profile呼び出し
- Runtime作成時に使う `PUBLIC` の `networkConfiguration`

他アプリのECR、IAMロール、VPC、セキュリティグループ、ロググループは参照しません。

#### `BizFlowAgentRuntimeStack`

- 初回イメージのdigest URIを参照する初期AgentCore Runtime
- Runtime作成時にAgentCoreが自動作成する初期Versionと `DEFAULT` Runtime Endpoint
- 初期Versionを明示参照する `PROD` Runtime Endpoint
- AgentCore標準名 `/aws/bedrock-agentcore/runtimes/<runtime-id>-<endpoint-name>` のEndpoint別ロググループ（30日保持、Retain）
- 通常更新スクリプトへ渡すCDK Outputs

初期構築では `AWS::BedrockAgentCore::Runtime` と、名前が `PROD` の `AWS::BedrockAgentCore::RuntimeEndpoint` をCDK/CloudFormation管理します。AgentCoreはRuntime作成時に初期Versionと `DEFAULT` Endpointを自動作成するため、`DEFAULT`はCloudFormationで重複作成しません。

### 初期構築の実行順序

以下は実装済みCDKを使う実行例です。この作業では実行していません。AWS変更操作なので、実行前に対象Account・Regionと作成リソースを確認し、明示的に承認してください。

#### 0. ローカルでCDKコードを検証する

Node.js 20以上を使用します。

```powershell
node --version
npm ci
npm run build
npm test
```

`npm run build` と `npm test` はAWSへ接続せず、TypeScriptの型と生成予定リソースの定義を検証します。

#### 1. 接続先を確認する

```powershell
$AwsProfile = "<BizFlow用SSOプロファイル>"
$AwsRegion = "ap-northeast-1"
$AwsAccountId = "<BizFlowを作成するAWS Account ID>"

aws sso login --profile $AwsProfile
aws sts get-caller-identity --profile $AwsProfile --region $AwsRegion
```

root ARNでは実行しません。以前のアプリを構築したProfile・Accountを自動的に流用せず、BizFlowの配置先として承認されたAccountとRegionを明示します。

#### 2. CDK bootstrapを確認する

対象Account/Regionが未bootstrapの場合だけ実行します。

```powershell
npx cdk bootstrap "aws://$AwsAccountId/$AwsRegion" `
  --profile $AwsProfile
```

CDK bootstrapリソースはCDKのデプロイ基盤であり、BizFlow RuntimeのECRやIAMロールではありません。アプリ用リソースは必ず専用スタックで作ります。

#### 3. Foundationを新規作成する

```powershell
npx cdk deploy BizFlowAgentFoundationStack `
  --profile $AwsProfile `
  --outputs-file .\config\foundation-outputs.json
```

このdeployで他スタックをimportせず、BizFlow専用ECR、IAMロール、Runtimeのログ・メトリクス・トレース送信権限、`PUBLIC`ネットワーク設定を新規作成します。Foundation Outputsには最低限、次を出力します。

- `EcrRepositoryUri`
- `AgentRuntimeExecutionRoleArn`
- `AgentRuntimeNetworkConfiguration`

ロググループ名にはRuntime IDが必要なため、実際のロググループはRuntime Stackで作成します。Foundation StackはRuntimeがログ・メトリクス・トレースを出力するためのIAM権限を作成します。

#### 4. 初回ARM64イメージを専用ECRへpushする

Git worktreeをcleanにしてコミットした後、その完全なSHAをタグに使います。

```powershell
$GitSha = git rev-parse HEAD
$FoundationOutputs = Get-Content .\config\foundation-outputs.json -Raw | ConvertFrom-Json
$EcrUri = $FoundationOutputs.BizFlowAgentFoundationStack.EcrRepositoryUri
$Registry = $EcrUri.Split('/')[0]

aws ecr get-login-password --profile $AwsProfile --region $AwsRegion |
  docker login --username AWS --password-stdin $Registry

docker buildx build `
  --platform linux/arm64 `
  --file .\agents\bizflow\Dockerfile `
  --tag "${EcrUri}:$GitSha" `
  --push `
  .\agents\bizflow
```

push後、ECRからdigestを取得し、Runtimeがタグではなく `repository@sha256:...` を参照するようにします。

```powershell
$RepositoryName = $EcrUri.Substring($EcrUri.IndexOf('/') + 1)
$Digest = aws ecr describe-images `
  --repository-name $RepositoryName `
  --image-ids "imageTag=$GitSha" `
  --query "imageDetails[0].imageDigest" `
  --output text `
  --profile $AwsProfile `
  --region $AwsRegion

```

`$Digest` は `sha256:` から始まる64桁のdigestです。Runtime Stackはこのdigestと専用ECR URIを内部で結合します。

#### 5. 初期Runtimeを新規作成する

CDK実装では `agentImageDigest` と `bedrockModelId` contextをRuntime Stackへ渡します。ECR URI全体を入力させないことで、Foundation Stackが作成した専用ECRだけを参照します。モデルIDは、対象リージョンで利用でき、Runtime実行ロールが呼び出せるものを明示します。

```powershell
npx cdk deploy BizFlowAgentRuntimeStack `
  --context "environment=dev" `
  --context "agentImageDigest=$Digest" `
  --context "bedrockModelId=<Bedrockモデルまたはinference-profile-ID>" `
  --profile $AwsProfile `
  --outputs-file .\config\cdk-outputs.json
```

Runtime StackはFoundation Stackの値を参照できますが、参照対象は今回作成した `BizFlowAgentFoundationStack` だけです。以前のプロジェクトのOutputsやARNは入力しません。

Runtime作成が成功すると、AgentCoreが初期Versionと `DEFAULT` Endpointを自動作成します。CDKは同じ初期Versionを指す`PROD` Endpointを追加します。

#### 6. Outputsと初期稼働を確認する

`config/cdk-outputs.json` に、次のBizFlow専用値が出力されていることを確認します。

- `EcrRepositoryUri`
- `AgentRuntimeId`
- `AgentRuntimeArn`
- `AgentRuntimeExecutionRoleArn`
- `AgentRuntimeNetworkConfiguration`
- `AgentRuntimeEndpointName`
- `AgentRuntimeEndpointArn`
- `RuntimeLogGroupName`
- `DefaultRuntimeLogGroupName`
- `InitialAgentImageDigest`
- `InitialAgentImageUri`
- `InitialBedrockModelId`

初期Runtimeと`PROD` Endpointが `READY` になり、`PROD`へのスモークテストに成功したら初期構築完了です。

### 初期構築後

以後のアプリ更新でFoundation StackやRuntime Stackをdeployしません。`config/cdk-outputs.json` は今回作成したBizFlow専用基盤を識別する設定として、`publish-agentcore.ps1` が読み取ります。

### 既存Version 1環境への`PROD`追加

`DEFAULT`だけを持つ旧版CDKで初期構築済みの場合は、現在の `InitialAgentImageDigest` を使ってRuntime Stackを一度だけ更新します。この変更は既存Runtimeを置き換えず、初期Versionを指す`PROD` Endpointとそのロググループを追加し、Outputsの `AgentRuntimeEndpointName` を `PROD` に更新するためのIaC変更です。実行前に `cdk diff` で差分を確認してください。

```powershell
$CurrentOutputs = Get-Content .\config\cdk-outputs.json -Raw | ConvertFrom-Json
$Digest = $CurrentOutputs.BizFlowAgentRuntimeStack.InitialAgentImageDigest

npx cdk diff BizFlowAgentRuntimeStack `
  --context "environment=dev" `
  --context "agentImageDigest=$Digest" `
  --context "bedrockModelId=<Bedrockモデルまたはinference-profile-ID>" `
  --profile $AwsProfile

npx cdk deploy BizFlowAgentRuntimeStack `
  --context "environment=dev" `
  --context "agentImageDigest=$Digest" `
  --context "bedrockModelId=<Bedrockモデルまたはinference-profile-ID>" `
  --profile $AwsProfile `
  --outputs-file .\config\cdk-outputs.json
```

この一度限りの移行が完了した後、通常更新ではCDKを実行しません。

## ディレクトリ構成

```text
agents/bizflow/
  app.py
  bizflow_agent.py
  Dockerfile
  .dockerignore
  requirements.txt
  requirements-dev.txt
config/
  agentcore.example.json
  foundation-outputs.json  # Foundation deploy時に生成
  cdk-outputs.json         # Runtime deploy時に生成
infra/
  bin/bizflow-agent.ts
  lib/foundation-stack.ts
  lib/runtime-stack.ts
  test/foundation-stack.test.ts
  test/runtime-stack.test.ts
scripts/
  publish-agentcore.ps1
  smoke-test-agentcore.ps1
tests/runtime/
  test_bizflow_agent.py
  test_endpoints.py
deployments/agentcore/
  <実行時に生成されるデプロイ記録>.json
cdk.json
package.json
package-lock.json
tsconfig.json
```

## 事前準備

PowerShellで各ツールが利用できることを確認します。

```powershell
git --version
node --version
npm --version
docker version
docker buildx version
aws --version
```

Docker DesktopはLinux containersモードで起動します。AgentCore Runtime用イメージは `linux/arm64` でbuildするため、x86-64版WindowsではDocker Desktopのクロスプラットフォームbuild機能を使用します。

AWS CLI v2には、少なくとも次の名前空間が必要です。

```powershell
aws bedrock-agentcore-control help
aws bedrock-agentcore help
```

IAM Identity Centerプロファイルを準備し、利用前にSSOログインします。

```powershell
aws configure sso --profile <SSOプロファイル名>
aws sso login --profile <SSOプロファイル名>
```

スクリプトは全AWS CLI呼び出しに `--profile` と `--region` を明示します。環境変数やdefault profileへの暗黙依存はしません。

## Pythonテスト

リポジトリルートで仮想環境を作成します。

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --requirement .\agents\bizflow\requirements-dev.txt
python -m pytest .\tests\runtime
```

このテストはAWSへ接続しません。`GET /ping`、`POST /invocations`、入力検証、Runtime session ID、モデル設定、読み取り専用分析の依存注入をローカルで検証します。

## コンテナのローカル検証

`.dockerignore` を確実に適用するため、build contextには `agents/bizflow` を指定します。

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

別のPowerShellからローカルスモークテストを実行します。

```powershell
.\scripts\smoke-test-agentcore.ps1 -LocalBaseUrl http://127.0.0.1:8080
```

コンテナは `0.0.0.0:8080` で待ち受け、次の契約を提供します。

- `GET /ping` → HTTP 200、`{"status":"Healthy"}`
- `POST /invocations` → `{"prompt":"..."}` または `{"input":{"prompt":"..."}}`

`local-test` providerはAWSへ接続せず、HTTP・コンテナ契約だけを検証する専用モードです。公開スクリプトはRuntimeへ必ず `BIZFLOW_MODEL_PROVIDER=bedrock` を設定するため、AWS環境では使用しません。

## CDK Outputs・設定ファイル契約

`UpdateAgentRuntime` ではコンテナURIに加え、今回新規作成したBizFlow専用Runtimeの `roleArn` と `networkConfiguration` が必要です。これらをスクリプトやDockerイメージへ直接埋め込んではいけません。他アプリや以前のCDKスタックの値も使用しません。

スクリプトは以下のどちらかを読み込めます。

1. 次のキーを持つ正規化JSON
2. CDKの `--outputs-file` が生成した、スタック名をトップレベルキーに持つJSON

正規化JSONの形式は `config/agentcore.example.json` を参照してください。`config/cdk-outputs.json` はCDKが生成した実環境のOutputsであり、例示ファイルとは分けてGit管理対象外にします。

```json
{
  "EcrRepositoryUri": "<account>.dkr.ecr.<region>.amazonaws.com/bizflow-agent",
  "AgentRuntimeId": "<runtime-id>",
  "AgentRuntimeArn": "<runtime-arn>",
  "AgentRuntimeExecutionRoleArn": "<role-arn>",
  "AgentRuntimeNetworkConfiguration": {
    "networkMode": "PUBLIC"
  },
  "AgentRuntimeEndpointName": "PROD"
}
```

VPCモードの場合は、BizFlow専用Foundation Stackが新規作成した設定を出力します。

```json
{
  "networkMode": "VPC",
  "networkModeConfig": {
    "securityGroups": ["sg-..."],
    "subnets": ["subnet-...", "subnet-..."]
  }
}
```

CDK Outputsを複数スタック分含むファイルでは、公開時に `-StackName` を指定します。単一スタックであれば、`AgentRuntimeId` を持つ出力を自動選択します。

CDK側のECRリポジトリには次を実装しています。

```typescript
const repository = new ecr.Repository(this, "BizFlowAgentRepository", {
  repositoryName: `bizflow-agent-${environmentName}`,
  imageTagMutability: ecr.TagMutability.IMMUTABLE,
  imageScanOnPush: true,
  removalPolicy: RemovalPolicy.RETAIN,
});
```

Runtime Stackは `agentImageDigest` がない場合にはCDKアプリへ追加されません。`agentImageDigest` を指定した場合は `bedrockModelId` も必須です。このため、空のECRしかない段階ではFoundation Stackだけをdeployでき、初回イメージpush後にRuntime Stackを定義できます。通常更新ではこれらのcontextやCDKを使わず、`publish-agentcore.ps1` が保存済みOutputsを再利用します。

通常更新でCDK Outputsを取り直すために `cdk deploy` を実行してはいけません。今回のBizFlow専用初期構築で保存したoutputsファイル、またはそこから作成した承認済みの環境別設定ファイルを使用します。

## dry-run

公開スクリプトはデフォルトでdry-runです。

```powershell
.\scripts\publish-agentcore.ps1 `
  -AWS_PROFILE <SSOプロファイル名> `
  -AWS_REGION ap-northeast-1 `
  -ModelId <Bedrockモデルまたはinference-profile-ID> `
  -ConfigPath .\config\cdk-outputs.json `
  -StackName BizFlowAgentRuntimeStack
```

dry-runでも接続先、ECR設定、同一Git SHAタグの有無を確定するため、読み取り専用の `sts get-caller-identity`、`ecr describe-repositories`、`ecr batch-get-image` は実行します。それ以外のbuild、ECRログイン、push、Runtime更新、Endpoint更新は実行しません。

`ModelId` はソースやOutputsへ埋め込まず、公開ごとに明示します。対象リージョンで利用でき、Runtime実行ロールの `bedrock:InvokeModel` 対象に含まれるモデルIDまたはinference profile IDを指定してください。現在のFoundation Stackは同一リージョンのfoundation modelと、同一リージョン・同一Accountのinference profileを許可しています。別リージョンへルーティングするprofileを採用する場合は、先にIAM設計を見直す必要があります。

次の場合は処理を中止します。

- rootユーザーのARNで接続している
- SSO接続先アカウントとECRアカウントが異なる
- `AWS_REGION` とECRリージョンが異なる
- ECRが `IMMUTABLE` ではない、またはscan-on-pushが無効
- Git worktreeに未コミット変更がある
- GitコミットSHAを取得できない
- 同じGitコミットSHAのタグが不変ECRリポジトリに既に存在する（`-Execute`時）
- 必須のCDK Outputがない
- `networkConfiguration` が不正

Git worktreeをcleanにするのは、SHAタグと実際のコンテナ内容を必ず一致させるためです。イメージタグには完全な40文字のGitコミットSHAを使用し、`latest` は使用しません。

## 公開とRuntime更新

> **重要:** AgentCoreの `DEFAULT` Endpointは `UpdateAgentRuntime` による新Version作成時に自動で最新版へ移ります。本番トラフィックはVersion固定の`PROD` Endpointへ送り、公開スクリプトが明示確認後にだけ`PROD`を新Versionへ切り替えます。スクリプトは安全のため、Outputsが`DEFAULT`の状態での`-Execute`を拒否します。

dry-runの内容を確認した後、`-Execute` を付けます。

```powershell
.\scripts\publish-agentcore.ps1 `
  -AWS_PROFILE <SSOプロファイル名> `
  -AWS_REGION ap-northeast-1 `
  -ModelId <Bedrockモデルまたはinference-profile-ID> `
  -ConfigPath .\config\cdk-outputs.json `
  -StackName BizFlowAgentRuntimeStack `
  -Execute
```

実行順序は次のとおりです。

1. 接続先Account、ARN、Regionを表示する。
2. root ARNなら停止する。
3. GitコミットSHAをイメージタグにする。
4. ECRへログインする。
5. `docker buildx build --platform linux/arm64 --push` を実行する。
6. ECRからpush済みイメージのdigestを取得する。
7. 現在のEndpoint `liveVersion` をロールバック用に保存する。
8. `repository@sha256:...` を `containerConfiguration.containerUri` に指定する。
9. `BIZFLOW_MODEL_PROVIDER=bedrock`、`BIZFLOW_MODEL_ID`、`BIZFLOW_AWS_REGION` をRuntime環境変数へ設定する。
10. CDK Outputs由来のrole/network設定と `metadataConfiguration.requireMMDSV2=true` で `UpdateAgentRuntime` を実行する。
11. 新Runtimeバージョンを期限付きでポーリングする。
12. `READY` 後、新バージョン番号の手入力を要求する。
13. 入力が一致した場合だけ`PROD` Endpointを更新する。
14. Endpointが `READY` かつ `liveVersion` が新バージョンになるまで待つ。
15. `InvokeAgentRuntime` によるスモークテストを行う。
16. デプロイ記録とロールバックコマンドを表示する。

公開スクリプトはRuntimeの環境変数マップを上記3項目で管理します。将来、MemoryやGatewayなどの追加設定を環境変数で渡す場合は、その変数を公開スクリプトの `environmentVariables` に追加してから更新します。

`-Execute` を指定していても、Endpoint切り替え確認で別の値または空文字を入力すると、新Runtimeバージョンの作成までで停止します。`DEFAULT`はAgentCoreにより新Versionへ自動更新されますが、本番用`PROD`は旧Versionのまま維持されます。

## ヘルスチェックとスモークテスト

ローカルでは `/ping` と `/invocations` を直接検査します。AgentCore上ではコンテナの `/ping` をAgentCore基盤が利用するため、外部テストでは以下をヘルス条件とします。

- Runtime Endpointの状態が `READY`
- `liveVersion` が期待する新バージョン
- `PROD` Endpointへの `InvokeAgentRuntime` が成功
- 応答が期待するJSON契約を満たす
  - `status=success`
  - 空でない `response`
  - `execution_mode=READ_ONLY`
  - `write_operations_performed=false`

公開処理から独立して再試験する場合は次のように実行します。

```powershell
.\scripts\smoke-test-agentcore.ps1 `
  -AWS_PROFILE <SSOプロファイル名> `
  -AWS_REGION ap-northeast-1 `
  -AgentRuntimeId <runtime-id> `
  -AgentRuntimeArn <runtime-arn> `
  -EndpointName PROD `
  -ExpectedRuntimeVersion <version>
```

## デプロイ記録

`-Execute` 実行時は `deployments/agentcore` にJSONを保存します。

記録内容には次を含みます。

- GitコミットSHAとイメージタグ
- ECRイメージURI、digest、digest URI
- AWS Account、Region、実行者ARN
- Bedrockモデルまたはinference profile ID
- Agent Runtime ID、ARN、新Runtimeバージョン
- Endpoint名、旧バージョン、新liveVersion
- スモークテスト結果
- 失敗理由
- ロールバックコマンド

認証情報やECRログインパスワードは記録しません。環境固有情報を誤ってコミットしないよう、生成JSONは `.gitignore` の対象です。必要な監査ストレージへ別途保管してください。

## ロールバック

公開スクリプトは、処理の最後に旧バージョンへ戻す完全なコマンドを表示します。スモークテスト失敗時に自動ロールバックは行いません。原因と影響を確認したうえで、表示されたコマンドを明示的に実行します。

形式は次のとおりです。

```powershell
aws bedrock-agentcore-control update-agent-runtime-endpoint `
  --agent-runtime-id "<runtime-id>" `
  --endpoint-name "PROD" `
  --agent-runtime-version "<旧version>" `
  --profile "<SSOプロファイル名>" `
  --region "<region>" `
  --no-cli-pager
```

ロールバック後もEndpointが `READY` かつ `liveVersion` が旧バージョンであることを確認し、スモークテストを再実行します。

## 障害時の確認

- `UpdateAgentRuntime` が失敗した場合: デプロイ記録の `failure` と対象Runtimeの失敗理由を確認する。
- Runtimeが `READY` にならない場合: AgentCore RuntimeのCloudWatch Logsでコンテナ起動、ポート8080、ARM64、IAM/ECR pull権限を確認する。
- Endpoint更新が失敗した場合: 旧 `liveVersion` が引き続き稼働しているか確認する。
- スモークテストが失敗した場合: ロールバックコマンドを利用できる状態を維持し、Runtimeログと呼び出し応答を確認する。
- 同じSHAタグが既に存在する場合: スクリプトはDocker build/push前に停止する。既存タグを上書きせず、変更をコミットして新しいGit SHAで公開する。初期Runtimeが既にそのイメージを使用しているだけなら、同じコミットを通常更新として再公開する必要はない。

## AWS公式仕様

- [AgentCore RuntimeをAgentCore CLIなしで構築する](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/getting-started-custom.html)
- [AgentCore Runtime HTTP protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)
- [AWS CDKのAgentCore Runtime construct](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore.CfnRuntime.html)
- [AWS::BedrockAgentCore::RuntimeEndpoint](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-runtimeendpoint.html)
- [AgentCore Runtime実行ロールの権限](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html)
- [AWS CLI v2 update-agent-runtime](https://docs.aws.amazon.com/cli/latest/reference/bedrock-agentcore-control/update-agent-runtime.html)
- [UpdateAgentRuntimeEndpoint API](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_UpdateAgentRuntimeEndpoint.html)
- [AWS CLI v2 invoke-agent-runtime](https://docs.aws.amazon.com/cli/latest/reference/bedrock-agentcore/invoke-agent-runtime.html)
- [Amazon ECRのタグ不変設定](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tag-mutability.html)
