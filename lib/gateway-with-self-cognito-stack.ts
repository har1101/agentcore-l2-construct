import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { ContainerImageBuild } from 'deploy-time-build';

export interface GatewayWithSelfCognitoStackProps extends cdk.StackProps {
	providerName: string;
	gatewayName: string;
	apiKeyName: string;
}

export class GatewayWithSelfCognitoStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props: GatewayWithSelfCognitoStackProps) {
		super(scope, id, props);

		const { providerName, gatewayName, apiKeyName } = props;

		// ============Cognito自前構築（M2M認証用）============

		// 1. User Pool
		const userPool = new cognito.UserPool(this, 'GatewayUserPool', {
			userPoolName: `${gatewayName}-userpool`,
			selfSignUpEnabled: false,
		});

		// Cognitoドメイン（client_credentials フローのトークンエンドポイントに必要）
		userPool.addDomain('GatewayUserPoolDomain', {
			cognitoDomain: {
				domainPrefix: `${gatewayName}-${this.account}`,
			},
		});

		// 2. Resource Server + カスタムスコープ
		const invokeOAuthScope = new cognito.ResourceServerScope({
			scopeName: 'genesis-gateway:invoke',
			scopeDescription: 'Invoke AgentCore Gateway',
		});

		const resourceServer = userPool.addResourceServer('GatewayResourceServer', {
			identifier: gatewayName,
			scopes: [invokeOAuthScope],
		});

		const invokeScope = cognito.OAuthScope.resourceServer(
			resourceServer,
			invokeOAuthScope,
		);

		// 3. M2M用クライアント（client_credentials + secret）
		const m2mClient = userPool.addClient('GatewayM2MClient', {
			generateSecret: true,
			oAuth: {
				flows: { clientCredentials: true },
				scopes: [invokeScope],
			},
		});

		// 4. discoveryUrlの構築
		const discoveryUrl = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`;

		// カスタムスコープ（Identity設定で使用）
		// Cognitoでは「{Resource Server identifier}/{scopeName}」の形式になる
		const cognitoScope = `${resourceServer.userPoolResourceServerId}/${invokeOAuthScope.scopeName}`;

		// ============Cognito自前構築============

		// ============AgentCore Gateway============

		const gateway = new agentcore.Gateway(this, 'AgentCoreGateway', {
			gatewayName,
			description: 'Agents can access to Lambda functions and Slack workspace.',
			protocolConfiguration: new agentcore.McpProtocolConfiguration({
				instructions: 'Agents can access to Lambda functions and Slack workspace.',
				searchType: agentcore.McpGatewaySearchType.SEMANTIC,
				supportedVersions: [
					agentcore.MCPProtocolVersion.MCP_2025_06_18,
				],
			}),
			// 自前CognitoをCustom JWTとして使用
			authorizerConfiguration: agentcore.GatewayAuthorizer.usingCustomJwt({
				discoveryUrl,
				allowedClients: [m2mClient.userPoolClientId],
			}),
		});

		// GatewayサービスロールにOutbound認証権限を追加
		gateway.role.addToPrincipalPolicy(new iam.PolicyStatement({
			actions: [
				'bedrock-agentcore:GetWorkloadAccessToken',
				'bedrock-agentcore:GetResourceApiKey',
			],
			resources: [
				// Workload Identity Directory（ディレクトリ自体）
				`arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
				// Workload Identity（Gateway固有）
				`arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/${gatewayName}-*`,
				// Token Vault（ディレクトリ自体）
				`arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default`,
				// Token Vault（API Key Credential Provider）
				`arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default/apikeycredentialprovider/*`,
			],
		}));

		// GatewayサービスロールにSecrets Manager権限を追加（API Key取得用）
		// シークレット名: bedrock-agentcore-identity!default/apikey/<apiKeyName>-<id>
		gateway.role.addToPrincipalPolicy(new iam.PolicyStatement({
			actions: ['secretsmanager:GetSecretValue'],
			resources: [
				`arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!default/apikey/${apiKeyName}-*`,
			],
		}));

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

		// RuntimeのIAMロールにIdentity Token Vault へのアクセス権限を追加
		// GetResourceOauth2Token: Identity経由でOAuth2トークンを取得するために必要
		runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
			actions: ['bedrock-agentcore:GetResourceOauth2Token'],
			resources: [
				// Token Vault (ディレクトリ自体)
				`arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default`,
				// Token Vault (OAuth2 Credential Provider)
				`arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default/oauth2credentialprovider/${providerName}`,
				// Workload Identity Directory (ディレクトリ自体)
				`arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
				// Workload Identity Directory (Runtime自身のIdentity)
				`arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`,
			],
		}));

		// Secrets Manager へのアクセス権限（Cognito クライアントシークレット取得用）
		// シークレット名: bedrock-agentcore-identity!default/oauth2/<providerName>
		runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
			actions: ['secretsmanager:GetSecretValue'],
			resources: [
				`arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!default/oauth2/${providerName}-*`,
			],
		}));

		// Bedrock 基盤モデル・Inference Profile へのアクセス権限
		runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
			actions: [
				'bedrock:InvokeModel',
				'bedrock:InvokeModelWithResponseStream',
			],
			resources: [
				// 基盤モデル（東京・大阪）
				'arn:aws:bedrock:ap-northeast-1::foundation-model/*',
				'arn:aws:bedrock:ap-northeast-3::foundation-model/*',
				// Inference Profile（東京・大阪）
				`arn:aws:bedrock:ap-northeast-1:${this.account}:inference-profile/*`,
				`arn:aws:bedrock:ap-northeast-3:${this.account}:inference-profile/*`,
			],
		}));

		// ============AgentCore Runtime============

		new cdk.CfnOutput(this, 'AgentCoreRuntimeArn', {
			value: runtime.agentRuntimeArn,
		});

		new cdk.CfnOutput(this, 'ResourceCredentialProviderName', {
			value: providerName,
			description: 'Resource Credential Provider名（Identityコンソールで同名のProviderを作成する）',
		});

		// Cognito関連の出力（Identity設定時に必要）
		new cdk.CfnOutput(this, 'CognitoUserPoolId', {
			value: userPool.userPoolId,
			description: 'Cognito User Pool ID',
		});

		new cdk.CfnOutput(this, 'CognitoClientId', {
			value: m2mClient.userPoolClientId,
			description: 'M2MクライアントID（トークン取得時に使用）',
		});

		new cdk.CfnOutput(this, 'CognitoScope', {
			value: cognitoScope,
			description: 'カスタムスコープ（トークン取得時に使用）',
		});
	}
}
