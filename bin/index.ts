#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VPCStack } from '../lib/vpc-stack';
import { getAccountId } from '../lib/utils';

//Environment variable for yaml file path and file name
const configFolder = '../config/'
const accountFileName = 'aws_account.yaml'

//Set up default value
const envName = process.env.ENVIRONMENT_NAME || 'kate'
const accountName = process.env.ACCOUNT_NAME || 'sandpit1'
const region = process.env.REGION || 'ap-southeast-2'

//Get aws account id
const accountId = getAccountId(accountName, configFolder, accountFileName)
const app = new cdk.App();
const vpcStack = new VPCStack(app, 'VpcStack', {
  stackName: `vpc-${envName}`,
  region: region,
  accountId: accountId,
  accountName: accountName,
  envName: envName,
  configFolder: configFolder
});

cdk.Tags.of(vpcStack).add('createdby', 'KateVu')
cdk.Tags.of(vpcStack).add('createdvia', 'AWS-CDK')
cdk.Tags.of(vpcStack).add('environment', envName)
cdk.Tags.of(vpcStack).add('repo', 'https://github.com/KateVu/aws-cdk-vpc')