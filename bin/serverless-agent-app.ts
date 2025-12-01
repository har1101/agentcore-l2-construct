#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
// import { AgentCoreGatewayAndRuntimeStack } from '../lib/no-use-stack';
import { GatewayWithSelfCognitoStack } from '../lib/gateway-with-self-cognito-stack';

const app = new cdk.App();

// cdk.jsonのcontextから読み込み
const config = app.node.tryGetContext('agentCoreConfig') as {
	providerName: string;
	gatewayName: string;
  apiKeyName: string;
};

if (!config?.providerName || !config?.gatewayName || !config?.apiKeyName) {
	throw new Error('cdk.jsonのagentCoreConfigにproviderNameとgatewayNameとapiKeyNameを設定してください');
}

// new AgentCoreGatewayAndRuntimeStack(app, 'AgentCoreGatewayAndRuntimeStack', {
// 	providerName: config.providerName,
// 	gatewayName: config.gatewayName,
// });

new GatewayWithSelfCognitoStack(app, 'GatewayWithSelfCognitoStack', {
  providerName: config.providerName,
  gatewayName: config.gatewayName,
  apiKeyName: config.apiKeyName,
});
