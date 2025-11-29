import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { ContainerImageBuild } from 'deploy-time-build';

export interface AgentCoreGatewayAndRuntimeStackProps extends cdk.StackProps {
	providerName: string;
	gatewayName: string;
}

export class AgentCoreGatewayAndRuntimeStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props: AgentCoreGatewayAndRuntimeStackProps) {
		super(scope, id, props);

		// ============AgentCore Gateway============

		const { providerName, gatewayName } = props;

		const gateway = new agentcore.Gateway(this, 'SlackGateway', {
			gatewayName,
			description: 'Agents can access to Slack workspace to get and write some messages.',
			protocolConfiguration: new agentcore.McpProtocolConfiguration({
				instructions: 'Agents can access to Slack workspace to get and write some messages.',
				searchType: agentcore.McpGatewaySearchType.SEMANTIC, // ツールのセマンティック検索有効化
				supportedVersions: [
					agentcore.MCPProtocolVersion.MCP_2025_03_26,
				],
			}),
			// authorizerConfigurationの設定を省略することで、Inbound Auth用Cognitoが自動で作成される
			// 実装例(JWT): authorizerConfiguration: agentcore.GatewayAuthorizer.usingCustomJwt()
			// 実装例(IAM): authorizerConfiguration: agentcore.GatewayAuthorizer.usingAwsIam()
		});

		// AgentCore Gatewayのターゲット登録のため、Lambda関数も作成する
		const toolFunction = new lambda.Function(this, 'ToolFunction', {
			runtime: lambda.Runtime.PYTHON_3_14,
			handler: 'gateway_target.lambda_handler',
			code: lambda.Code.fromAsset('lambda')
		});

		// ToolSchemaはinline / S3 / localAsset のいずれか
		const toolSchema = agentcore.ToolSchema.fromInline([
			{
				name: 'get-current-time',
				description: '指定されたタイムゾーンの現在時刻をISO 8601形式で返すツール',
				inputSchema: {
					type: agentcore.SchemaDefinitionType.OBJECT,
					properties: {
						timezone: {
							type: agentcore.SchemaDefinitionType.STRING,
							description: 'タイムゾーン（例: Asia/Tokyo, UTC, America/New_York）。デフォルトはAsia/Tokyo'
						}
					}
					// required: ['timezone'] とすれば必須パラメータにできるが今回は省略
				},
				outputSchema: {
					type: agentcore.SchemaDefinitionType.OBJECT,
					properties: {
						current_time: {
							type: agentcore.SchemaDefinitionType.STRING,
							description: 'ISO 8601形式の現在時刻'
						},
						timezone: {
							type: agentcore.SchemaDefinitionType.STRING,
							description: '使用したタイムゾーン'
						}
					}
				}
			}
		]);

		// AgentCore Gatewayのターゲット登録
		// 3rd Partyツールとの統合はCDK上では不可能。Lambda/MCP/OpenAPI/Smithyのみ対応
		// 最終的なツール名は「<gatewayTargetName>__<toolSchema.name>」の形
		// ここで言うと「lambda-function-target__get-current-time」
		const lambdaTarget = gateway.addLambdaTarget('LambdaTarget', {
			gatewayTargetName: 'lambda-function-target',
			description: 'Agents can get current time.',
			lambdaFunction: toolFunction,
			toolSchema: toolSchema
		});

		// GatewayのURLはAgentCore Runtimeの環境変数に設定する
		if (!gateway.gatewayUrl) {
			throw new Error('GatewayのURLが発行されていません')
		};
		const gatewayUrl: string = gateway.gatewayUrl;

		// Quick Createで自動作成されるCognitoのカスタムスコープ(3rd Partyとのターゲット統合を行うなら必要そう)
		const cognitoScope = `${gatewayName}/genesis-gateway:invoke`;

		// ============AgentCore Gateway============

		// ============AgentCore Runtime============

		// 「deploy-time-build」というL3 Constructを使ってCodeBuildプロジェクト構築~buildキックまで自動的に実施
		const agentcoreRuntimeImage = new ContainerImageBuild(this, 'AgentWithGatewayImage', {
			directory: './agent',
			platform: Platform.LINUX_ARM64,
		});

		// AgentCore Runtime(L2 Construct)
		const runtime = new agentcore.Runtime(this, 'AgentCoreRuntime', {
			runtimeName: 'StrandsAgentWithGateway',
			agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
				agentcoreRuntimeImage.repository,
				agentcoreRuntimeImage.imageTag
			),
			description: 'Gateway経由でツールを使えるStrands Agent',
			environmentVariables: {
				GATEWAY_URL: gatewayUrl,
				PROVIDER_NAME: providerName,
				COGNITO_SCOPE: cognitoScope,
			}
		});

		// ============AgentCore Runtime============

		new cdk.CfnOutput(this, 'AgentCoreRuntimeArn', {
			value: runtime.agentRuntimeArn,
		});

		new cdk.CfnOutput(this, 'ResourceCredentialProviderName', {
			value: providerName,
			description: 'Resource Credential Provider名（Identityコンソールで同名のProviderを作成する）',
		});
	}
}
