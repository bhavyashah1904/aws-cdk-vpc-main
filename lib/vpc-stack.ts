import { Stack, StackProps, Tags } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { Construct } from 'constructs'
import { createNACLs, createPublicSubnet, createPrivateSubnet, createDataSubnet, getVPCConfig } from './utils';

interface VpcStackPros extends StackProps {
  region: string,
  accountId: string,
  accountName: string,
  envName: string,
  configFolder: string
}

/**
 * Create vpc with 3 subnets: public, private, and data
 * Create 3 nacls
 * Create route tables
 * Create IWG and NAT Gateway
 * Tag resource with list of tag
 */
export class VPCStack extends Stack {
  constructor(scope: Construct, id: string, props: VpcStackPros) {
    const updatedProps = {
      env: {
        region: props.region,
        account: props.accountId,
      },
      ...props
    }
    super(scope, id, updatedProps)

    const { region, accountName, configFolder } = props
    //Get fileConfigName: 
    const configFileName = `${accountName}-${region}.yaml`
    const vpcConfig = getVPCConfig(configFolder, configFileName)

    //Create vpc
    const vpc = new ec2.Vpc(this, 'vpc', {
      ipAddresses: ec2.IpAddresses.cidr(vpcConfig.ipAddresses),
      subnetConfiguration: [],
      vpcName: vpcConfig.vpcName,
      enableDnsHostnames: true,
      enableDnsSupport: true      
    })

    //Create iwg and attached to the vpc
    const igw = new ec2.CfnInternetGateway(this, 'InternetGateway', {
      tags: [{
        key: 'Name',
        value: `IGW-${vpcConfig.vpcName.toUpperCase()}`,
      }],
    })
    new ec2.CfnVPCGatewayAttachment(this, 'IGWAttachment', {
      vpcId: vpc.vpcId,
      internetGatewayId: igw.ref
    })

    //Create public nacls
    const publicNetworkNalcs = createNACLs(this, `ACL-Public-${vpcConfig.vpcName}`, vpc, vpcConfig.publicSubnetNACLs)
    //Create private nacls
    const privateNetworkNalcs = createNACLs(this, `ACL-Private-${vpcConfig.vpcName}`, vpc, vpcConfig.privateSubnetNACLs)
    //Create public nacls
    const dataNetworkNalcs = createNACLs(this, `ACL-Data-${vpcConfig.vpcName}`, vpc, vpcConfig.dataSubnetNACLs)


    //Create public route table
    const publicRouteTable = new ec2.CfnRouteTable(this, `PublicSubnetRouteTable`, {
      vpcId: vpc.vpcId
    })

    //and add route to iwg for PublicRoute table
    new ec2.CfnRoute(this, `PublicRoute`, {
      routeTableId: publicRouteTable.ref,
      gatewayId: igw.ref,
      destinationCidrBlock: '0.0.0.0/0'
    })
    Tags.of(publicRouteTable).add("Name", `RT-${vpcConfig.vpcName}-PUBLIC`)

    //Create data route table
    //Private route tables will be created in createPublicSubnet function since they need a route to nat gateways, and nat gateways will be created when created public subnets
    const dataRouteTable = new ec2.CfnRouteTable(this, `dataSubnetRouteTable`, {
      vpcId: vpc.vpcId
    })
    Tags.of(dataRouteTable).add("Name", `RT-${vpcConfig.vpcName}-DATA`)

    //Create public subnets and nat gateways
    //We have to separate public/private/data subnet here because the private will depend on the NAT gateway created in create Public subnets step
    //Update map listNATGateway using AZ
    let listNATGateway = new Map<string, ec2.CfnNatGateway>()
    //waitNATGateways is for handling race condition
    const waitNATGateways = (): boolean => {
      vpcConfig.publicSubnets.forEach((subnetConfig) => {
        createPublicSubnet(this, vpc.vpcId, vpcConfig, subnetConfig, publicRouteTable, listNATGateway, publicNetworkNalcs)
      })
      return true
    }

    //Create private subnets 
    if (waitNATGateways()) {
      vpcConfig.privateSubnets.forEach((subnetConfig) => {
        createPrivateSubnet(this, vpc.vpcId, vpcConfig.vpcName, subnetConfig, listNATGateway, privateNetworkNalcs)
      })
    }

    //Create data subnets
    vpcConfig.dataSubnets.forEach((subnetConfig) => {
      createDataSubnet(this, vpc.vpcId, vpcConfig.vpcName, subnetConfig, dataRouteTable, dataNetworkNalcs)
    })
  }
}