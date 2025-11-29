# エラー履歴メモ

## 2025-11-25: SchemaDefinition使用エラー

### エラー内容
```
プロパティ 'SchemaDefinition' は型 'typeof import("/Users/har1101/Documents/DevContainer_Workspace/project/serverless-agent-app/node_modules/@aws-cdk/aws-bedrock-agentcore-alpha/lib/index")' に存在していません。'SchemaDefinitionType' ですか?ts(2551)
```

**ファイル**: `lib/agentcore-gateway-stack.ts:39, 42`

### 原因
`SchemaDefinition`は**インターフェース（interface）**であり、クラスや関数ではありません。そのため、以下の使い方は誤りです：

- ❌ `agentcore.SchemaDefinition({...})` - 関数として呼び出し
- ❌ `new agentcore.SchemaDefinition({...})` - クラスとしてインスタンス化

ただし、[AWS CDK API Reference](https://docs.aws.amazon.com/cdk/api/v2/python/aws_cdk.aws_bedrock_agentcore_alpha/README.html#gateway)上の実装例では以下のようにクラスかのような扱いで記載されています。

```typescript
tool_schema = agentcore.ToolSchema.from_inline([
    name="hello_world",
    description="A simple hello world tool",
    input_schema=agentcore.SchemaDefinition(
        type=agentcore.SchemaDefinitionType.OBJECT,
        properties={
            "name": agentcore.SchemaDefinition(
                type=agentcore.SchemaDefinitionType.STRING,
                description="The name to greet"
            )
        },
        required=["name"]
    )
])
```

### 対処法

`SchemaDefinition`は単なる型定義（インターフェース）なので、オブジェクトリテラル`{}`として定義する必要があります。

**誤った使い方:**

```typescript
inputSchema: agentcore.SchemaDefinition({
    type: agentcore.SchemaDefinitionType.OBJECT,
    properties: {
        name: new agentcore.SchemaDefinition({
            type: agentcore.SchemaDefinitionType.STRING,
            description: 'ユーザー名'
        })
    }
})
```

**正しい使い方:**

```typescript
inputSchema: {
    type: agentcore.SchemaDefinitionType.OBJECT,
    properties: {
        name: {
            type: agentcore.SchemaDefinitionType.STRING,
            description: 'ユーザー名'
        }
    }
}
```

### 参考情報

- `SchemaDefinition`: TypeScriptのインターフェース型（型定義のみ）
- `SchemaDefinitionType`: enum型（STRING, NUMBER, OBJECT, ARRAY, BOOLEAN, INTEGER）
- 型定義ファイル: `node_modules/@aws-cdk/aws-bedrock-agentcore-alpha/agentcore/gateway/targets/schema/tool-schema.d.ts:43-77`

### 参考ドキュメント

- [AWS CDK Bedrock AgentCore](https://docs.aws.amazon.com/cdk/api/v2/python/aws_cdk.aws_bedrock_agentcore_alpha/README.html#gateway)
- [Medium: Deploying an Agent with AWS AgentCore using CDK](https://pjcr.medium.com/deploying-an-agent-with-aws-agentcore-using-cdk-060b54af0237)

---

## 2025-11-26: ContainerImageBuild と AgentRuntimeArtifact の型不一致エラー

### エラー内容
```
型 'ContainerImageBuild' には 型 'AgentRuntimeArtifact' からの次のプロパティがありません: bind, _render ts(2739)
```

**ファイル**: `lib/agentcore-runtime-stack.ts:20`

### 原因

`deploy-time-build`パッケージの`ContainerImageBuild`と、`@aws-cdk/aws-bedrock-agentcore-alpha`の`AgentRuntimeArtifact`は**異なるインターフェース**を持っています。

#### ContainerImageBuild（deploy-time-build）
CodeBuildを使ってデプロイ時にコンテナをビルドしECRにプッシュするL3 Construct。以下のプロパティを公開：
- `repository: IRepository` - ECRリポジトリ
- `imageTag: string` - イメージタグ
- `imageUri: string` - 完全なイメージURI

#### AgentRuntimeArtifact（aws-bedrock-agentcore-alpha）

AgentCore Runtimeに渡すコンテナイメージ設定を表す**抽象クラス**。以下のメソッドが必要：

- `bind(scope, runtime)` - パーミッション設定などの副作用を処理
- `_render()` - CloudFormation用のプロパティを生成

`ContainerImageBuild`はこれらのメソッドを実装していないため、直接渡すと型エラーになります。

#### 補足: `bind`と`_render`とは？

AWS CDKでは、リソース間の依存関係やパーミッションを管理するために**抽象クラス**のパターンがよく使われます。

**`bind(scope, runtime)`メソッドの役割:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Runtime が作成されるとき                                        │
│                                                                 │
│  Runtime ──呼び出し──> AgentRuntimeArtifact.bind()              │
│                              │                                  │
│                              ▼                                  │
│                     「ECRリポジトリへの読み取り権限を                │
│                       RuntimeのIAMロールに付与する」              │
└─────────────────────────────────────────────────────────────────┘
```

- Runtimeがコンテナイメージを使うとき、ECRリポジトリからイメージをpullする権限が必要
- `bind()`が呼ばれると、必要なIAMポリシーが自動的に設定される
- 開発者が手動でパーミッションを書く必要がなくなる

**`_render()`メソッドの役割:**

```
┌─────────────────────────────────────────────────────────────────┐
│  CDK synth 実行時                                               │
│                                                                 │
│  AgentRuntimeArtifact._render()                                 │
│           │                                                     │
│           ▼                                                     │
│  {                                                              │
│    ContainerConfiguration: {                                    │
│      ContainerUri: "123456789.dkr.ecr.region.amazonaws.com/..." │
│    }                                                            │
│  }                                                              │
│           │                                                     │
│           ▼                                                     │
│  CloudFormationテンプレート (JSON/YAML) に変換                    │
└─────────────────────────────────────────────────────────────────┘
```

- CDKのコードをCloudFormationテンプレートに変換する処理
- `_render()`はCloudFormationが理解できる形式のオブジェクトを返す
- アンダースコア`_`は「内部メソッド（CDKフレームワークが呼び出す）」を意味する

**なぜ`fromEcrRepository()`を使うのか:**

`fromEcrRepository()`は、これらのメソッドを内部で実装済みの`AgentRuntimeArtifact`インスタンスを返します。つまり、開発者はECRリポジトリとタグを渡すだけで、残りの複雑な処理はCDKが自動で行ってくれます。

### 対処法

`AgentRuntimeArtifact.fromEcrRepository()`ファクトリメソッドを使って、`ContainerImageBuild`のプロパティを変換します。

**誤った使い方:**
```typescript
const agentcoreRuntimeImage = new ContainerImageBuild(this, 'Image', {
  directory: './assets',
  platform: Platform.LINUX_ARM64,
});

const runtime = new agentcore.Runtime(this, 'AgentCoreRuntime', {
  runtimeName: 'MyAgent',
  agentRuntimeArtifact: agentcoreRuntimeImage,  // ← エラー！
});
```

**正しい使い方:**
```typescript
const agentcoreRuntimeImage = new ContainerImageBuild(this, 'Image', {
  directory: './assets',
  platform: Platform.LINUX_ARM64,
});

const runtime = new agentcore.Runtime(this, 'AgentCoreRuntime', {
  runtimeName: 'MyAgent',
  agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
    agentcoreRuntimeImage.repository,  // ECRリポジトリを渡す
    agentcoreRuntimeImage.imageTag     // イメージタグを渡す
  ),
});
```

### なぜこの方法が必要か

1. **型の互換性**: `fromEcrRepository()`は内部で`bind()`と`_render()`を実装した`AgentRuntimeArtifact`のインスタンスを返す
2. **パーミッション管理**: `AgentRuntimeArtifact`の`bind()`メソッドがECRリポジトリへのアクセス権限を自動設定
3. **CloudFormation生成**: `_render()`メソッドが正しいCloudFormationプロパティを生成

### 参考情報

- 型定義ファイル:
  - `node_modules/@aws-cdk/aws-bedrock-agentcore-alpha/agentcore/runtime/runtime-artifact.d.ts`
  - `node_modules/deploy-time-build/lib/container-image-build.d.ts`

### 参考ドキュメント

- [Zenn: Amazon Bedrock AgentCore 完全入門（追記セクション）](https://zenn.dev/aws_japan/articles/088f2051eb6ab3#%E8%BF%BD%E8%A8%98)
- [AWS CDK AgentCore Runtime Docs](https://docs.aws.amazon.com/cdk/api/v2/python/aws_cdk.aws_bedrock_agentcore_alpha/README.html#agentcore-runtime)

---

## 2025-11-28: Gateway自動作成CognitoのカスタムスコープをCDKから取得できない

### 問題内容

`agentcore.Gateway()`で`authorizerConfiguration`を省略した場合、Inbound Auth用のCognitoが自動作成（Quick Create）されます。このCognitoにはカスタムスコープが設定されますが、**CDKから直接取得する方法がありません**。

**ファイル**: `lib/agentcore-gateway-stack.ts`

### 原因

Quick Createで自動作成されるCognito（UserPool / App Client / Resource Server）は、**AgentCoreサービス側で作成される**ため、CloudFormationスタックのリソースとしては現れません。

- L2の`Gateway`クラスには、UserPool IDやResource Server IdentifierやCustom Scopeを返す属性が存在しない
- `gateway.userPool`や`gateway.userPoolClient`プロパティは存在するが、Quick Create使用時は`undefined`

### 対処法

カスタムスコープは**固定パターン**で作成されるため、決め打ちで組み立てます。

**スコープのパターン:**
```
${gatewayName}/genesis-gateway:invoke
```

**実装例:**
```typescript
const gatewayName = 'slack-agentcore-gateway';

const gateway = new agentcore.Gateway(this, 'SlackGateway', {
    gatewayName,
    // ... その他の設定
    // authorizerConfigurationを省略 → Quick Create
});

// カスタムスコープを決め打ちで組み立て
const cognitoScope = `${gatewayName}/genesis-gateway:invoke`;

// Runtimeの環境変数に渡す
const runtime = new agentcore.Runtime(this, 'AgentCoreRuntime', {
    // ... その他の設定
    environmentVariables: {
        COGNITO_SCOPE: cognitoScope,
    }
});
```

### 注意事項

- このパターンはAWS側で変更される可能性があるため、リリースノートの監視を推奨
- より厳密な管理が必要な場合は、Cognitoを自前で作成して`authorizerConfiguration`に渡す方法もある

### 参考情報

- カスタムスコープは Cognito の UserPool → アプリケーションクライアント → ログインページ から確認可能
- Resource Server Identifier: `${gatewayName}/genesis-gateway`
- Scope名: `invoke`

### 参考ドキュメント

- [AWS Cognito リソースサーバー](https://docs.aws.amazon.com/ja_jp/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html)

---

## 2025-11-29: Strands Agent ContentBlockの型エラー

### エラー内容

```
型 "ContentBlock" の引数を、関数 "format_content_block" の型 "dict[Unknown, Unknown]" のパラメーター "block" に割り当てることはできません
"ContentBlock" は "dict[Unknown, Unknown]" に割り当てできません
```

**ファイル**: `agent/agent.py`

### 原因

Strands Agentの`response.message['content']`の各要素は`ContentBlock`型（TypedDict）です。関数の引数を`dict`として定義すると、Pylanceが型の不一致を検出します。

### 対処法

`strands.types.content`から`ContentBlock`型をインポートして使用します。

**修正前:**

```python
def format_content_block(block: dict) -> str:
    ...
```

**修正後:**

```python
from strands.types.content import ContentBlock

def format_content_block(block: ContentBlock) -> str:
    ...
```

### ContentBlockの種類

`ContentBlock`はTypedDictで、以下のキーのいずれかを持ちます（`total=False`なのですべてオプション）：

| キー | 型 | 説明 |
|---|---|---|
| `text` | `str` | テキストコンテント |
| `toolUse` | `ToolUse` | ツール呼び出し要求（name, toolUseId, input） |
| `toolResult` | `ToolResult` | ツール実行結果（toolUseId, status, content） |
| `image` | `ImageContent` | 画像コンテント |
| `document` | `DocumentContent` | ドキュメントコンテント |
| `reasoningContent` | `ReasoningContentBlock` | モデルの推論内容 |

### Strands Agentのレスポンス構造

`agent(user_input)`の戻り値は`AgentResult`型です：

```python
@dataclass
class AgentResult:
    stop_reason: StopReason  # "end_turn" | "tool_use" | "max_tokens" など
    message: Message         # 最後のメッセージ
    metrics: EventLoopMetrics
    state: Any
    interrupts: Sequence[Interrupt] | None
    structured_output: BaseModel | None
```

`Message`の構造：

```python
class Message(TypedDict):
    content: List[ContentBlock]  # コンテントブロックの配列
    role: Role                   # "user" | "assistant"
```

### ContentBlockの表示実装例

```python
from strands.types.content import ContentBlock

def format_content_block(block: ContentBlock) -> str:
    """ContentBlockを読みやすい文字列に変換"""
    if 'text' in block:
        return block['text']
    elif 'toolUse' in block:
        tool = block['toolUse']
        return f"[ツール呼出] {tool['name']} (入力: {tool.get('input', {})})"
    elif 'toolResult' in block:
        result = block['toolResult']
        status = result.get('status', 'unknown')
        content = result.get('content', [])
        content_str = ', '.join(
            c.get('text', c.get('json', str(c))) if isinstance(c, dict) else str(c)
            for c in content
        )
        return f"[ツール結果] {status}: {content_str}"
    elif 'reasoningContent' in block:
        reasoning = block['reasoningContent']
        text = reasoning.get('reasoningText', {}).get('text', '')
        return f"[推論] {text[:100]}..." if len(text) > 100 else f"[推論] {text}"
    else:
        return str(block)

# 使用例
response = agent(user_input)
contents = response.message['content']

# すべてのContentBlockを整形して表示
for i, block in enumerate(contents):
    print(f"応答[{i}]: {format_content_block(block)}")

# テキストブロックのみを結合して返す
result = '\n'.join(
    block['text'] for block in contents if 'text' in block
)
```

### 参考ドキュメント

- [Strands Agent Types API Reference](https://strandsagents.com/latest/documentation/docs/api-reference/types/)
