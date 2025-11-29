#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AgentCoreGatewayAndRuntimeStack } from '../lib/agentcore-gateway-runtime-stack';

const app = new cdk.App();

// cdk.jsonのcontextから読み込み
const config = app.node.tryGetContext('agentCoreConfig') as {
	providerName: string;
	gatewayName: string;
};

if (!config?.providerName || !config?.gatewayName) {
	throw new Error('cdk.jsonのagentCoreConfigにproviderNameとgatewayNameを設定してください');
}

new AgentCoreGatewayAndRuntimeStack(app, 'AgentCoreGatewayAndRuntimeStack', {
	providerName: config.providerName,
	gatewayName: config.gatewayName,
});
