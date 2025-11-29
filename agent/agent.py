import os
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient
from mcp.client.streamable_http import streamablehttp_client
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.identity.auth import requires_access_token
from typing import Dict, Any
from strands.types.content import ContentBlock

# エージェントアプリケーションの初期化
app = BedrockAgentCoreApp()


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

# アプリケーションのエントリーポイント
@app.entrypoint
async def get_time_and_slack_agent(payload: Dict[str, Any]):
    """
    AgentCore Gateway+Identityを用いてツールを実行するエージェント
    Lambdaツールからは現在時間を取得し、Slackツールを使ってメッセージを取得したり書き込んだりする
    """
    print("📋 エージェント起動")
    print(f"受信したペイロード: {payload}")

    # AgentCore Identityを使用してGatewayにアクセス
    gateway_url = os.environ.get("GATEWAY_URL")
    provider_name = os.environ.get("PROVIDER_NAME")
    cognito_scope = os.environ.get("COGNITO_SCOPE")

    if not gateway_url or not provider_name or not cognito_scope:
        raise ValueError("環境変数 GATEWAY_URL, PROVIDER_NAME, COGNITO_SCOPE が設定されていません")

    @requires_access_token(
        provider_name=provider_name,
        scopes=cognito_scope.split() if cognito_scope else [],
        auth_flow="M2M",
        force_authentication=False,
    )
    async def process_with_gateway(*, access_token: str) -> str:
        """
        Gatewayへのアクセストークンを取得し、MCPクライアントで処理
        """
        print(f"✅ アクセストークン取得成功")

        # MCPクライアントの作成（AgentCore Identity認証トークン付き）
        def create_streamable_http_transport():
            return streamablehttp_client(
                gateway_url, 
                headers={"Authorization": f"Bearer {access_token}"}
            )

        client = MCPClient(create_streamable_http_transport)
        print(f"✅ MCP Client初期化完了（AgentCore Identity認証）")

        try:
            with client:
                # ツールリストを取得
                tools = client.list_tools_sync()
                print(f"🛠️ 利用可能なツール: {[tool.tool_name for tool in tools]}")

                # Bedrockモデルとエージェントの初期化
                model = BedrockModel(
                    model_id="jp.anthropic.claude-haiku-4-5-20251001-v1:0",
                )

                agent = Agent(
                    model=model,
                    tools=tools,
                    system_prompt="""
                    あなたはいろんな地域の現在時刻をチェックしてそれをSlackに送信するエージェントです。
                    指定がない場合は日本の現在時刻を教えて下さい。Slackのチャンネルは指定がなければ、 #test-strands-agents チャンネルに送信してください。
                    """
                )
                print("✅ エージェント初期化完了！")

                # ユーザー入力を処理
                user_input = payload.get("prompt", "ラスベガスの現在時刻は？")
                print(f"💬 ユーザー入力: {user_input}")

                # エージェントで処理（内部でGatewayのツールを呼び出す）
                response = agent(user_input)

                # すべてのContentBlockを整形して表示
                contents = response.message['content']
                formatted_blocks = [format_content_block(block) for block in contents]
                for i, formatted in enumerate(formatted_blocks):
                    print(f"🤖 応答[{i}]: {formatted}")

                # テキストブロックのみを結合して返す
                result = '\n'.join(
                    block['text'] for block in contents if isinstance(block, dict) and 'text' in block
                )
                return result if result else formatted_blocks[-1] if formatted_blocks else ""

        except Exception as e:
            print(f"❌ エージェント処理エラー: {e}")
            return f"エラーが発生しました: {str(e)}"

    try:
        # AgentCore Identityを使用してアクセストークンを取得し、処理を実行
        return await process_with_gateway()  # type: ignore[call-arg]  # access_tokenはデコレーターが注入
    except Exception as e:
        print(f"❌ 認証エラー: {e}")
        return f"認証に失敗しました: {str(e)}"

if __name__ == "__main__":
    app.run()