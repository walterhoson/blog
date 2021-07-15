---
title: RocketMQ 通信机制
description: 主要分析 RocketMQ 消息的协议设计、编解码，以及通信机制
toc: true
authors: 
    - WayneShen
tags: 
    - Middleware
    - RocketMQ
categories: 
    - Middleware
series: [RocketMQ]
date: '2021-07-03T15:21:+08:00'
lastmod: '2021-07-03T15:33:10+08:00'
draft: false
---

</br>

主要分析 RocketMQ 消息的协议设计、编解码，以及通信机制

<!--more-->

## 通信机制

RocketMQ 集群主要包括 NameServer、Broker(Master/Slave)、Producer、Consumer 4 个角色，基本通信流程如下：

1. Broker 启动后需要完成一次将自己注册至 NameServer 的操作；随后每隔 30s 定时向 NameServer 上报 Topic 路由信息。
2. Producer 作为客户端发送消息时，需要根据消息的 Topic 从本地缓存的 `TopicPublishInfoTable` 获取路由信息。如果没有则更新路由信息会从 NameServer 上重新拉取，同时 Producer 会默认每隔 30s 向 NameServer 拉取一次路由信息。
3. Producer 根据 2 中获取的路由信息选择一个队列（`MessageQueue`）进行消息发送；Broker 作为消息的接收者接收消息并落盘存储。
4. Consumer 根据 2 中获取的路由信息，并在完成客户端的负载均衡后，选择其中的某一个或某几个消息队列来拉取消息并进行消费。

从 1-3 中可以看出在消息生产者，Broker 和 NameServer 之间都会发生通信（此处只说了 MQ 的部分通信），因此如何设计一个良好的网络通信模块在 MQ 中至关重要，它将决定 RocketMQ 集群整体的消息传输能力与最终的性能。

`rocketmq-remoting` 模块是 RocketMQ 消息队列中负责网络通信的模块，它几乎被其他所有需要网络通信的模块（诸如 `rocketmq-client`、`rocketmq-broker`、`rocketmq-namesrv`）所依赖和引用。

为了实现客户端与服务器之间高效的数据请求与接收，RocketMQ 消息队列自定义了通信协议并在 Netty 的基础之上扩展了通信模块。

### Remoting 通信类结构

![img](../../../assets/RocketMQ通信机制/rocketmq_design_3.png)

### 协议设计与编解码

在 Client 和 Server 之间完成一次消息发送时，需要对发送的消息进行一个协议约定，因此就有必要自定义 RocketMQ 的消息协议。同时，为了**高效地在网络中传输消息**和**对收到的消息读取**，就需要对消息进行编解码。

在 RocketMQ 中，`RemotingCommand` 这个类在消息传输过程中对所有数据内容的封装，不但包含了所有的数据结构，还包含了编码解码操作。

| Header 字段 | 类型         | Request 说明                                                  | Response 说明                             |
| ---------- | ------------ | ------------------------------------------------------------ | ---------------------------------------- |
| code       | int          | 请求操作码，应答方根据不同的请求码进行不同的业务处理         | 应答响应码。0 表示成功，非 0 则表示各种错误 |
| language   | LanguageCode | 请求方实现的语言                                             | 应答方实现的语言                         |
| version    | int          | 请求方程序的版本                                             | 应答方程序的版本                         |
| opaque     | int          | 相当于 reqeustId，在同一个连接上的不同请求标识码，与响应消息中的相对应 | 应答不做修改直接返回                     |
| flag       | int          | 区分是普通 RPC 还是 onewayRPC 得标志                             | 区分是普通 RPC 还是 onewayRPC 得标志         |
| remark     | String       | 传输自定义文本信息                                           | 传输自定义文本信息                       |
| extFields  | HashMap      | 请求自定义扩展信息                                           | 响应自定义扩展信息                       |

![img](../../../assets/RocketMQ通信机制/rocketmq_design_4.png)

可见传输内容主要可以分为以下 4 部分：

1. 消息长度：总长度，四个字节存储，占用一个 int 类型；
2. 序列化类型&消息头长度：同样占用一个 int 类型，第一个字节表示序列化类型，后面三个字节表示消息头长度；
3. 消息头数据：经过序列化后的消息头数据；
4. 消息主体数据：消息主体的二进制字节数据内容；

### 消息的通信方式和流程

在 RocketMQ 消息队列中支持通信的方式主要有同步 (sync)、异步 (async)、单向 (oneway) 三种。

其中 oneway 通信模式相对简单，只发送请求不等待应答，而发送请求在客户端实现层面仅仅是一个 os 系统调用的开销，即将数据写入客户端的 socket 缓冲区，此过程耗时通常在微秒级。

一般用在发送心跳包场景下，或对可靠性要求不高的日志收集类应用，无需关注其 Response。

此处主要介绍异步通信流程。

![img](../../../assets/RocketMQ通信机制/rocketmq_design_5.png)

### Reactor 多线程设计

RocketMQ 的 RPC 通信采用 Netty 组件作为底层通信库，同样也遵循了 Reactor 多线程模型，同时又在这之上做了一些扩展和优化。

![img](../../../assets/RocketMQ通信机制/rocketmq_design_6.png)

上面的框图中可以大致了解 RocketMQ 中 NettyRemotingServer 的 Reactor 多线程模型。

一个 Reactor 主线程（eventLoopGroupBoss，即为上面的 1）负责监听 TCP 网络连接请求，建立好连接，创建 SocketChannel，并注册到 selector 上。RocketMQ 的源码中会自动根据 OS 的类型选择 NIO 和 Epoll（也可以通过参数配置）, 然后监听真正的网络数据。

拿到网络数据后，再丢给 Worker 线程池（eventLoopGroupSelector，即为上面的“N”，源码中默认设置为 3），在真正执行业务逻辑之前需要进行 SSL 验证、编解码、空闲检查、网络连接管理，这些工作交给 defaultEventExecutorGroup（即为上面的“M1”，源码中默认设置为 8）去做。

而处理业务操作放在业务线程池中执行，根据 RomotingCommand 的业务请求码 code 去 processorTable 这个本地缓存变量中找到对应的 processor，然后封装成 task 任务后，提交给对应的业务 processor 处理线程池来执行（sendMessageExecutor，以发送消息为例，即为上面的 “M2”）。

从入口到业务逻辑的几个步骤中线程池一直再增加，这跟每一步逻辑复杂性相关，越复杂，需要的并发通道越宽。

| 线程数 | 线程名                         | 线程具体说明            |
| ------ | ------------------------------ | ----------------------- |
| 1      | NettyBoss_%d                   | Reactor 主线程          |
| N      | NettyServerEPOLLSelector*%d*%d | Reactor 线程池          |
| M1     | NettyServerCodecThread_%d      | Worker 线程池            |
| M2     | RemotingExecutorThread_%d      | 业务 processor 处理线程池 |

## 参考资料

[RocketMQ 设计](https://github.com/apache/rocketmq/blob/master/docs/cn/design.md) 
