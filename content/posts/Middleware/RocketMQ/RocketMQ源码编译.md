---
title: RocketMQ 源码编译
description: 主要分析 RocketMQ 各个模块的含义，以及将源码进行编译运行
toc: true
authors: 
    - WayneShen
tags: 
    - Middleware
    - RocketMQ
categories: 
    - Middleware
series: [RocketMQ]
date: '2021-07-03T16:44:+08:00'
lastmod: '2022-08-06T16:53:16+08:00'
draft: false
---

</br>

主要分析 RocketMQ 各个模块的含义，以及将源码进行编译运行

## 源码模块

| 名称          | 作用                                         |
| ------------- | -------------------------------------------- |
| broker        | broker模块：c和p端消息存储逻辑               |
| client        | 客户端api：produce、consumer端 接受与发送api |
| common        | 公共组件：常量、基类、数据结构               |
| dev        | 开发者信息（非源代码）                |
| distribution  | 部署、运维相关zip包中的代码                  |
| tools         | 运维tools：命令行工具模块                    |
| store         | 存储模块：消息、索引、commitlog存储          |
| namesrv       | 服务管理模块：服务注册topic等信息存储        |
| remoting      | 远程通讯模块：netty+fastjson                 |
| logappender   | 日志适配模块                                 |
| example       | 实例代码                                    |
| filtersrv     | 消息过滤器模块                               |
| srvutil       | 辅助模块                                     |
| filter        | 过滤模块：消息过滤模块                       |
| style        | checkstyle 相关实现	|
| openmessaging | 兼容openmessaging分布式消息模块              |

## 编译运行

```shell
mvn -Prelease-all -DskipTests clean install -U
```

## 启动

### namesrv

设置 VM 参数

```shell
-Drocketmq.home.dir=/Users/wayneshen/Program/Github/rocketmq/distribution
-Duser.home=/Users/wayneshen/Program/Github/rocketmq/user.home
```

设置 program arguments

```SHELL
-n 127.0.0.1:9876
```

org.apache.rocketmq.namesrv.NamesrvStartup，启动

#### broker

设置 VM 参数

```shell
-Drocketmq.home.dir=/Users/wayneshen/Program/Github/rocketmq/distribution
-Duser.home=/Users/wayneshen/Program/Github/rocketmq/user.home
```

设置 program arguments

```SHELL
-n 127.0.0.1:9876 
-c /Users/wayneshen/Program/Github/rocketmq/distribution/conf/broker.conf
```

org.apache.rocketmq.broker.BrokerStartup，启动。

多网卡可能导致ip不对，修改 `rocketmq\distribution\conf\broker.conf` ，增加 `brokerIP1 = 127.0.0.1`

### 其他配置

broker.conf 中增加配置

```shell
brokerClusterName = DefaultCluster
brokerName = broker-a
brokerId = 0
# namesrvAddr 地址
namesrvAddr=127.0.0.1:9876
deleteWhen = 04
fileReservedTime = 48
brokerRole = ASYNC_MASTER
flushDiskType = ASYNC_FLUSH
autoCreateTopicEnable=true

# 存储路径
storePathRootDir=/Users/wayneshen/Program/Github/rocketmq/data/dataDir
# commitLog 路径
storePathCommitLog=/Users/wayneshen/Program/Github/rocketmq/data/dataDir/commitlog
# 消息队列存储路径
storePathConsumeQueue=/Users/wayneshen/Program/Github/rocketmq/data/dataDir/consumequeue
# 消息索引存储路径
storePathIndex=/Users/wayneshen/Program/Github/rocketmq/data/dataDir/index
# checkpoint 文件路径
storeCheckpoint=/Users/wayneshen/Program/Github/rocketmq/data/dataDir/checkpoint
# abort 文件存储路径
abortFile=/Users/wayneshen/Program/Github/rocketmq/data/dataDir/abort
```

## 问题分析

![image-20210601193953184](../../../assets/RocketMQ源码编译/image-20210601193953184.png)

可能原因：

1. Broker 模块不支持自动创建 topic，并且 topic 没有被手动创建过
2. Broker 模块没有正确连接到 Namesrv
3. 发送者没有连接到 Namesrv

