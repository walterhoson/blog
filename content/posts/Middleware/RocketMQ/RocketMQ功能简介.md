---
title: RocketMQ 功能简介
description: 主要分析 RocketMQ 的模块，以及部署架构。
toc: true
authors: 
    - WayneShen
tags: 
    - Middleware
    - RocketMQ
categories: 
    - Middleware
series: [RocketMQ]
date: '2021-07-03T11:40:+08:00'
lastmod: '2021-07-03T11:45:20+08:00'
draft: false
---

</br>
主要分析 RocketMQ 的模块，以及部署架构。

<!--more-->

## MQ 介绍

优点：应用解耦、异步、流量削峰、缓冲、数据分发、日志分析（kafka 居多）

缺点：

* 系统可用性降低。系统引入的外部依赖越多，系统稳定性越差。一旦 MQ 宕机，就会对业务造成影响。需要保证 MQ 的高可用。

* 系统复杂度提高。MQ 的加入大大增加了系统的复杂度，从同步远程调用，改为 MQ 异步调用。需要考虑消息重复消费、消息丢失、顺序性等问题。

* 一致性问题。下游消费者存在消费成功与否的差异，需要考虑如何保证数据处理的一致性。

## RocketMQ 模块分析

![img](../../../assets/RocketMQ功能简介/rocketmq_architecture_1.png)

RocketMQ 架构上主要分为四部分，如上图所示：

- Producer：消息发布的角色，支持分布式集群部署。Producer 通过 MQ 的负载均衡模块选择相应的 Broker 集群队列进行消息投递，投递的过程支持**快速失败**并且**低延迟**。

- Consumer：消息消费的角色，支持分布式集群部署。支持以 push 推，pull 拉两种模式对消息进行消费。同时也支持**集群方式**和**广播方式**的消费，它提供**实时消息订阅机制**，可以满足大多数用户的需求。

- NameServer：NameServer 是一个**非常简单的 Topic 路由注册中心**，其角色类似 Dubbo 中的 zookeeper，**支持 Broker 的动态注册与发现**。主要包括两个功能：

  - **Broker 管理**，NameServer 接受 Broker 集群的注册信息并保存下来作为**路由信息的基本数据**。然后**提供心跳检测机制**，检查 Broker 是否还存活；
  - **路由信息管理**，每个 NameServer 将保存**关于 Broker 集群的整个路由信息**和**用于客户端查询的队列信息**。然后 Producer 和 Conumser 通过 NameServer 就可以知道整个 Broker 集群的路由信息，从而进行消息的投递和消费。

  NameServer 通常也是集群部署，各实例间相互不进行信息通讯。Broker 是向每一台 NameServer 注册自己的路由信息，所以每一个 NameServer 实例上面都保存一份完整的路由信息。当某个 NameServer 因某种原因下线了，Broker 仍然可以向其它 NameServer 同步其路由信息，Producer、Consumer 仍可以动态感知 Broker 的路由的信息。

- BrokerServer：Broker 主要负责**消息的存储**、**投递**和**查询**以及**服务高可用保证**，为实现这些功能，Broker 包含以下几个重要子模块：

  - Remoting Module：整个 Broker 的实体，负责处理来自 clients 端的请求。
  - Client Manager：负责管理客户端 (Producer/Consumer) 和维护 Consumer 的 Topic 订阅信息
  - Store Service：提供方便简单的 API 接口处理消息存储到物理硬盘和查询功能。
  - HA Service：高可用服务，提供 Master Broker 和 Slave Broker 之间的数据同步功能。
  - Index Service：根据特定的 Message key 对投递到 Broker 的消息进行索引服务，以提供消息的快速查询。

## RocketMQ 部署架构

![img](../../../assets/RocketMQ功能简介/rocketmq_architecture_3.png)

### 网络部署特点

#### NameServer

NameServer 是一个几乎无状态节点，可集群部署，节点之间无任何信息同步。

#### Broker

Broker 部署相对复杂，Broker 分为 Master 与 Slave，一个 Master 可以对应多个 Slave，但一个 Slave 只能对应一个 Master；

Master 与 Slave 的对应关系通过指定相同的 BrokerName，不同的 BrokerId 来定义，BrokerId 为 0 表示 Master，非 0 表示 Slave。

Master 也可以部署多个。**每个 Broker 与 NameServer 集群中的所有节点建立长连接，定时注册 Topic 信息到所有 NameServer**。 

注意：当前 RocketMQ 版本在部署架构上支持一 Master 多 Slave，但只有 BrokerId=1 的从服务器才会参与消息的读负载。

#### Producer

Producer 与 NameServer 集群中的其中一个节点（随机选择）建立长连接，**定期从 NameServer 获取 Topic 路由信息**，并向提供 Topic 服务的 Master 建立长连接，且定时向 Master 发送心跳。

**Producer 完全无状态**，可集群部署。

#### Consumer

Consumer 与 NameServer 集群中的其中一个节点（随机选择）建立长连接，**定期从 NameServer 获取 Topic 路由信息**，并向提供 Topic 服务的 Master、Slave 建立长连接，且定时向 Master、Slave 发送心跳。

Consumer 可以从 Master 或 Slave 订阅消息，消费者在向 Master 拉取消息时，Master 服务器会根据拉取偏移量与最大偏移量的距离（判断是否读老消息，产生读 I/O），以及从服务器是否可读等因素建议下一次是从 Master 还是 Slave 拉取。

### 工作流程

结合部署架构图，描述集群工作流程：

- 启动 NameServer，NameServer 起来后监听端口，等待 Broker、Producer、Consumer 连上来，相当于一个路由控制中心。

- Broker 启动，跟所有的 NameServer 保持长连接，定时发送心跳包。心跳包中包含当前 Broker 信息 (IP+端口等）以及存储所有 Topic 信息。注册成功后，NameServer 集群中就有 Topic 跟 Broker 的映射关系。

- 收发消息前，先创建 Topic，创建 Topic 时需要指定该 Topic 要存储在哪些 Broker 上，也可以在发送消息时自动创建 Topic。

- Producer 发送消息，启动时先跟 NameServer 集群中的其中一台建立长连接，并从 NameServer 中获取当前发送的 Topic 存在哪些 Broker 上，轮询从队列列表中选择一个队列，然后与队列所在的 Broker 建立长连接从而向 Broker 发消息。

- Consumer 跟 Producer 类似，跟其中一台 NameServer 建立长连接，获取当前订阅 Topic 存在哪些 Broker 上，然后直接跟 Broker 建立连接通道，开始消费消息。

## 参考资料

[RocketMQ 架构设计](https://github.com/apache/rocketmq/blob/master/docs/cn/architecture.md) 
