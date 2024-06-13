import { Stack, Tags } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'

export interface AWSAccount {
    name: string,
    account_id: string
}
export enum subnetTypes {
    PUBLIC = "Public",
    PRIVATE = "Private",
    DATA = "Data",
}
export interface SubnetConfig {
    availabilityZone: string,
    ipAddress: string,
    mapPublicIpOnLaunch?: boolean
}
export interface NaclRule {
    ruleNumber: number,
    ruleAction: string,
    isIpV4Block: boolean,
    cidrBlock: string,
    protocol: string,
    startPort?: number,
    endPort?: number,
    icmp?: ec2.AclIcmp,
    direction: string
}

export interface VpcConfig {
    vpcName: string,
    ipAddresses: string,
    enable_per_az_nat_gateway: boolean,
    publicSubnets: SubnetConfig[],
    privateSubnets: SubnetConfig[],
    dataSubnets: SubnetConfig[],
    publicSubnetNACLs: NaclRule[],
    privateSubnetNACLs: NaclRule[],
    dataSubnetNACLs: NaclRule[]
}


export const getFullFilePath = (filePath: string, fileName: string): string => {
    const fullFilePath = path.join(__dirname, filePath) + fileName
    return fullFilePath
}

const getAccountIds = (filePath: string, fileName: string): AWSAccount[] => {
    try {
        const fileContents = fs.readFileSync(getFullFilePath(filePath, fileName), 'utf8')
        const data = yaml.load(fileContents) as AWSAccount[]
        return data
    } catch (e) {
        console.log(e)
        throw new Error('getAccountIds: Cannot read file')
    }
}

export const getAccountId = (accountName: string, filePath: string, fileName: string): string => {
    const accountIds = getAccountIds(filePath, fileName)
    const found = accountIds.find((item) => {
        return item.name === accountName
    })
    if (found == undefined) {
        throw new Error(`getAccountId: cannot get account id from account name ${accountName}`)
    }
    return found.account_id
}

export const getVPCConfig = (filePath: string, fileName: string): VpcConfig => {
    try {
        const fileContents = fs.readFileSync(getFullFilePath(filePath, fileName), 'utf8')
        const data = yaml.load(fileContents) as VpcConfig
        return data
    } catch (e) {
        console.log(e)
        throw new Error('getVPCConfig: Cannot read file')
    }
}



/**
 * 
 * @param protocol: protocal would be in the list ["6" (TCP), "17" (UDP), "1" (ICMP), "58" (ICMP-v6) or "-1" ("All protocol")] 
 * @param startPort 
 * @param endPort 
 * @returns
 * https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.AclTraffic.html
 * https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.AclTrafficConfig.html
 * https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.AclIcmp.html
 */
export const createAclTraffic = (protocol: string, startPort?: number, endPort?: number, icmp?: ec2.AclIcmp): ec2.AclTraffic => {
    switch (protocol) {
        case '6': // TCP
            return ec2.AclTraffic.tcpPortRange(Number(startPort), Number(endPort))

        case '17': // UDP
            return ec2.AclTraffic.udpPortRange(Number(startPort), Number(endPort))
        //https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.AclIcmp.html  
        case '1': // ICMP
            return ec2.AclTraffic.icmp(icmp || { type: -1, code: -1 })

        case '53': // ICMPv6
            return ec2.AclTraffic.icmpv6(icmp || { type: -1, code: -1 })

        case '-1': // All traffic
            return ec2.AclTraffic.allTraffic()

        default:
            throw new Error("ACL protocol must be in list [1, 6, 17, 53 or -1]")
    }
}

const createNatGateway = (stack: Stack, vpcConfig: VpcConfig, subnet: ec2.PublicSubnet, subnetConfig: SubnetConfig, listNATGateway: Map<string, ec2.CfnNatGateway>): ec2.CfnNatGateway => {
    const eip = new ec2.CfnEIP(stack, `NATGatewayEIP${subnetConfig.availabilityZone.toLowerCase()}`, {
        domain: "vpc"
    })

    const natGateway = new ec2.CfnNatGateway(stack, `NatGateway${subnetConfig.availabilityZone.toLowerCase()}`, {
        subnetId: subnet.subnetId,
        allocationId: eip.attrAllocationId,
        tags: [{
            key: 'Name',
            value: `NatGateway-${vpcConfig.vpcName.toUpperCase()}-${subnetConfig.availabilityZone.toLowerCase()}`,
        }],

    })
    listNATGateway.set(subnetConfig.availabilityZone.toLowerCase(), natGateway)
    return natGateway
}

/**
 * 
 * @param stack 
 * @param vpcid 
 * @param vpcName 
 * @param subnetConfig 
 * @param publicRouteTable 
 * @returns 
 */
export const createPublicSubnet = (stack: Stack, vpcid: string, vpcConfig: VpcConfig, subnetConfig: SubnetConfig, publicRouteTable: ec2.CfnRouteTable, listNATGateway: Map<string, ec2.CfnNatGateway>, nacls: ec2.NetworkAcl): ec2.Subnet => {
    const az = `${stack.region}${subnetConfig.availabilityZone.toLowerCase()}`

    const subnet = new ec2.PublicSubnet(stack, `${subnetTypes.PUBLIC}Subnet${subnetConfig.availabilityZone}`, {
        availabilityZone: az,
        cidrBlock: subnetConfig.ipAddress,
        vpcId: vpcid,
        mapPublicIpOnLaunch: subnetConfig.mapPublicIpOnLaunch || false
    })
    Tags.of(subnet).add('aws-cdk:subnet-type', ec2.SubnetType.PUBLIC)
    Tags.of(subnet).add('Name', `${vpcConfig.vpcName}-${subnetTypes.PUBLIC}Subnet${subnetConfig.availabilityZone}`)
    subnet.node.tryRemoveChild('RouteTableAssociation')
    subnet.node.tryRemoveChild('RouteTable')

    new ec2.CfnSubnetRouteTableAssociation(stack, `RouteAssociationPublic${az}Default`, {
        routeTableId: publicRouteTable.ref,
        subnetId: subnet.subnetId
    })

    if (vpcConfig.enable_per_az_nat_gateway || listNATGateway.size < 1) {
        createNatGateway(stack, vpcConfig, subnet, subnetConfig, listNATGateway)
    }

    nacls.associateWithSubnet(`PUBLIC_NACL-${subnetConfig.availabilityZone.toLowerCase()}`, {
        subnets: [subnet]
    })

    return subnet
}

/**
   * 
   * @param stack 
   * @param vpcid 
   * @param vpcName 
   * @param subnetConfig 
   * @returns 
   */
export const createPrivateSubnet = (stack: Stack, vpcid: string, vpcName: string, subnetConfig: SubnetConfig, listNATGateway: Map<string, ec2.CfnNatGateway>, nacls: ec2.NetworkAcl): ec2.Subnet => {
    const az = `${stack.region}${subnetConfig.availabilityZone.toLowerCase()}`
    const subnet = new ec2.PrivateSubnet(stack, `${subnetTypes.PRIVATE}Subnet${subnetConfig.availabilityZone}`, {
        availabilityZone: az,
        cidrBlock: subnetConfig.ipAddress,
        vpcId: vpcid,
        mapPublicIpOnLaunch: false
    })
    subnet.node.tryRemoveChild('RouteTableAssociation')
    subnet.node.tryRemoveChild('RouteTable')
    Tags.of(subnet).add('aws-cdk:subnet-type', ec2.SubnetType.PRIVATE_WITH_EGRESS)
    Tags.of(subnet).add('Name', `${vpcName}-${subnetTypes.PRIVATE}Subnet${subnetConfig.availabilityZone}`)

    const privateRouteTable = new ec2.CfnRouteTable(stack, `privateSubnetRouteTable${subnetConfig.availabilityZone.toLowerCase()}`, {
        vpcId: vpcid
    })
    let natGateWayId: string
    if (listNATGateway.has(subnetConfig.availabilityZone.toLowerCase())) {
        natGateWayId = listNATGateway.get(subnetConfig.availabilityZone.toLowerCase())?.ref || 'none'
    } else {
        const firstElement = listNATGateway.entries().next().value
        natGateWayId = firstElement[1]?.ref || 'none'
    }

    new ec2.CfnRoute(stack, `PrivateRoute${subnetConfig.availabilityZone.toLowerCase()}`, {
        routeTableId: privateRouteTable.ref,
        natGatewayId: natGateWayId,
        destinationCidrBlock: '0.0.0.0/0'
    })

    Tags.of(privateRouteTable).add("Name", `RT-${vpcName}-PRIVATE-${subnetConfig.availabilityZone.toLowerCase()}`)

    new ec2.CfnSubnetRouteTableAssociation(stack, `RouteAssociationPrivate${subnetConfig.availabilityZone.toLowerCase()}Default`, {
        routeTableId: privateRouteTable.ref,
        subnetId: subnet.subnetId
    })

    nacls.associateWithSubnet(`PRIVATE_NACL-${subnetConfig.availabilityZone.toLowerCase()}`, {
        subnets: [subnet]
    })
    return subnet
}

export const createDataSubnet = (stack: Stack, vpcid: string, vpcName: string, subnetConfig: SubnetConfig, dataRouteTable: ec2.CfnRouteTable, nacls: ec2.NetworkAcl): ec2.Subnet => {
    const az = `${stack.region}${subnetConfig.availabilityZone.toLowerCase()}`
    const subnet = new ec2.PrivateSubnet(stack, `${subnetTypes.DATA}Subnet${subnetConfig.availabilityZone}`, {
        availabilityZone: az,
        cidrBlock: subnetConfig.ipAddress,
        vpcId: vpcid,
        mapPublicIpOnLaunch: false
    })
    subnet.node.tryRemoveChild('RouteTableAssociation')
    subnet.node.tryRemoveChild('RouteTable')
    Tags.of(subnet).add('aws-cdk:subnet-type', ec2.SubnetType.PRIVATE_ISOLATED)
    Tags.of(subnet).add('Name', `${vpcName}-${subnetTypes.DATA}Subnet${subnetConfig.availabilityZone}`)

    new ec2.CfnSubnetRouteTableAssociation(stack, `RouteAssociationData${az}Default`, {
        routeTableId: dataRouteTable.ref,
        subnetId: subnet.subnetId
    })
    nacls.associateWithSubnet(`DATA_NACL-${subnetConfig.availabilityZone.toLowerCase()}`, {
        subnets: [subnet]
    })

    return subnet
}

export const createNACLs = (stack: Stack, name: string, vpc: ec2.Vpc, rules: NaclRule[]): ec2.NetworkAcl => {
    const networkAcl = new ec2.NetworkAcl(stack, name, {
        vpc: vpc,
        networkAclName: name,
    }
    )
    Tags.of(networkAcl).add('Name', name)
    rules.forEach((rule) => {
        const ruleAction = rule.ruleAction === "allow" ? ec2.Action.ALLOW : ec2.Action.DENY
        const direction = rule.direction === 'ingress' ? ec2.TrafficDirection.INGRESS : ec2.TrafficDirection.EGRESS
        networkAcl.addEntry(`${stack.stackName}-${rule.direction}-${rule.ruleNumber}`, {
            ruleNumber: rule.ruleNumber,
            traffic: createAclTraffic(rule.protocol, rule.startPort, rule.endPort, rule.icmp),
            cidr: rule.isIpV4Block ? ec2.AclCidr.ipv4(rule.cidrBlock) : ec2.AclCidr.ipv6(rule.cidrBlock),
            ruleAction: ruleAction,
            direction: direction
        })
    })

    return networkAcl
}
