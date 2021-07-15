---
title: RocketMQ 负载均衡机制
description: 主要分析 RocketMQ 的负载均衡的实现逻辑
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
lastmod: '2021-07-03T16:53:16+08:00'
draft: false
---

</br>

主要分析 RocketMQ 的负载均衡的实现逻辑。

<!--more-->

## 负载均衡

RocketMQ 中的负载均衡都在 Client 端完成，具体来说，主要可以分为 **Producer 端发送消息时的负载均**衡和 C**onsumer 端订阅消息的负载均衡**。

### Producer 的负载均衡

Producer 端在发送消息时，会先根据 Topic 找到指定的 TopicPublishInfo，在获取了 TopicPublishInfo 路由信息后，RocketMQ 的客户端在默认方式下 `selectOneMessageQueue()` 方法会从 TopicPublishInfo 中的 messageQueueList 中选择一个队列（MessageQueue）进行发送消息。默认采用轮训，以达到让消息平均落在不同的队列上。

具体的容错策略均在 MQFaultStrategy 这个类中定义。有一个 `sendLatencyFaultEnable` 开关变量，如果开启，在随机递增取模的基础上，再过滤掉 not available 的 Broker。所谓的"`latencyFaultTolerance`"，是指**对之前失败的，按一定的时间做退避**。例如，如果上次请求的 latency 超过 550Lms，就退避 3000Lms；超过 1000L，就退避 60000L；如果关闭，采用随机递增取模的方式选择一个队列（MessageQueue）来发送消息。

`latencyFaultTolerance` 机制是实现消息发送高可用的核心关键所在。

### Consumer 的负载均衡

在 RocketMQ 中，Consumer 端的两种消费模式（Push/Pull）都是基于拉模式来获取消息的，而在 Push 模式只是对 pull 模式的一种封装，其**本质实现为消息拉取线程在从服务器拉取到一批消息后，然后提交到消息消费线程池后，又“马不停蹄”的继续向服务器再次尝试拉取消息**。如果未拉取到消息，则延迟一下又继续拉取。

在两种基于拉模式的消费方式（Push/Pull）中，均需要 Consumer 端知道从 Broker 端的哪一个消息队列中去获取消息。因此，有必要在 Consumer 端来做负载均衡，即 Broker 端中多个 MessageQueue 分配给同一个 ConsumerGroup 中的哪些 Consumer 消费。

#### 集群模式

在集群消费模式下，每条消息只需要投递到订阅该 topic 的 ConsumerGroup 下的一个实例即可。RocketMQ 采用主动拉取的方式拉取并消费消息，在拉取时需要明确指定拉取哪一条 messageQueue。

而每当实例的数量有变更，都会触发一次所有实例的负载均衡，此时会按照 queue 的数量和实例的数量平均分配 queue 给每个实例。

默认的分配算法是 AllocateMessageQueueAveragely，如下图：

![img](../../../assets/RocketMQ负载均衡机制/consumer_loadbalance_1.png)

另外一种平均的算法是 AllocateMessageQueueAveragelyByCircle，平均分摊每一条 queue，只是以环状轮流分 queue 的形式，如下图：

![img](../../../assets/RocketMQ负载均衡机制/consumer_loadbalance_2.png)

需要注意的是，集群模式下，每个 queue 都是只允许分配一个实例，这是由于拉取哪些消息是 consumer 主动控制的，如果多个实例同时消费一个 queue 的消息就会导致同一个消息在不同的实例下被消费多次，所以算法上都是一个 queue 只分给一个 consumer 实例，一个 consumer 实例可以允许同时分到不同的 queue。

通过增加 consumer 实例去分摊 queue 的消费，可以起到水平扩展的消费能力的作用。而有实例下线的时候，会重新触发负载均衡，此时原来分配到的 queue 将分配到其他实例上继续消费。

但如果 consumer 实例的数量比 message queue 的总数量还多的话，多出来的 consumer 实例将无法分到 queue，也就无法消费到消息，也就无法起到分摊负载的作用了。所以**需要控制让 queue 的总数量大于等于 consumer 的数量**。

#### 广播模式

由于**广播模式下要求一条消息需要投递到一个消费组下面所有的消费者实例**，所以也就没有消息被分摊消费的说法。

在实现上，其中一个不同就是在 consumer 分配 queue 时，所有 consumer 都分到所有的 queue。

![img](../../../assets/RocketMQ负载均衡机制/consumer_loadbalance_3.png)

#### 心跳包发送

在 Consumer 启动后，它就会通过定时任务不断地向 RocketMQ 集群中的所有 Broker 实例发送心跳包（其中包含，消息消费分组名称、订阅关系集合、消息通信模式和客户端 id 的值等信息）。

Broker 端在收到 Consumer 的心跳消息后，会将它维护在 ConsumerManager 的本地缓存变量 - consumerTable，同时并将封装后的客户端网络通道信息保存在本地缓存变量 — channelInfoTable 中，为之后做 Consumer 端的负载均衡提供可以依据的元数据信息。

#### 实现负载均衡的核心类—RebalanceImpl

在 Consumer 实例的启动流程中的启动 MQClientInstance 实例部分，会完成负载均衡服务线程 — RebalanceService 的启动（每隔 20s 执行一次）。

通过查看源码发现，RebalanceService 线程的 `run()` 方法最终调用的是 RebalanceImpl 类的 `rebalanceByTopic()` 方法，该方法是实现 Consumer 端负载均衡的核心。这里，`rebalanceByTopic()` 方法会根据消费者通信类型为“广播模式”还是“集群模式”做不同的逻辑处理。

这里主要来看下集群模式下的主要处理流程：

1. 从 rebalanceImpl 实例的本地缓存变量 — topicSubscribeInfoTable 中，获取该 Topic 主题下的消息消费队列集合（mqSet）；

2. 以 topic 和 consumerGroup 为参数，调用 `mQClientFactory.findConsumerIdList()` 方法向 Broker 端发送获取该消费组下消费者 Id 列表的 RPC 通信请求（Broker 端基于前面 Consumer 端上报的心跳包数据而构建的 consumerTable 做出响应返回，业务请求码：GET_CONSUMER_LIST_BY_GROUP）；

3. 先对 Topic 下的消息消费队列、消费者 Id 排序，然后用消息队列分配策略算法（默认为：消息队列的平均分配算法），计算出待拉取的消息队列。这里的平均分配算法，类似于分页的算法，将所有 MessageQueue 排好序类似于记录，将所有消费端 Consumer 排好序类似页数，并求出每一页需要包含的平均 size 和每个页面记录的范围 range，最后遍历整个 range 而计算出当前 Consumer 端应该分配到的记录（这里即为：MessageQueue）。

![img](../../../assets/RocketMQ负载均衡机制/rocketmq_design_8.png)

4. 然后，调用 `updateProcessQueueTableInRebalance()` 方法，具体做法是，先将分配到的消息队列集合（mqSet）与 processQueueTable 做一个过滤比对。

![img](../../../assets/RocketMQ负载均衡机制/rocketmq_design_9.png)

- 上图中 processQueueTable 标注的红色部分，表示与分配到的消息队列集合 mqSet 互不包含。将这些队列设置 Dropped 属性为 true，然后查看这些队列是否可以移除出 processQueueTable 缓存变量，这里具体执行 `removeUnnecessaryMessageQueue()` 方法，即每隔 1s 查看是否可以获取当前消费处理队列的锁，拿到的话返回 true。若等待 1s 后，仍然拿不到当前消费处理队列的锁则返回 false。若返回 true，则从 processQueueTable 缓存变量中移除对应的 Entry；

- 上图中绿色部分，表示与分配到的消息队列集合 mqSet 的交集。判断该 ProcessQueue 是否已经过期了，在 Pull 模式的不用管，如果是 Push 模式，设置 Dropped 属性为 true，并调用 `removeUnnecessaryMessageQueue()` 方法，像上面一样尝试移除 Entry；

1. 最后，为过滤后的消息队列集合（mqSet）中的每个 MessageQueue 创建一个 ProcessQueue 对象并存入 RebalanceImpl 的 processQueueTable 队列中（其中调用 RebalanceImpl 实例的 `computePullFromWhere(MessageQueue mq)` 方法获取该 MessageQueue 对象的下一个进度消费值 offset，随后填充至接下来要创建的 pullRequest 对象属性中），并创建拉取请求对象 — pullRequest 添加到拉取列表 — pullRequestList 中，最后执行 `dispatchPullRequest()` 方法，将 Pull 消息的请求对象 PullRequest 依次放入 PullMessageService 服务线程的阻塞队列 pullRequestQueue 中，待该服务线程取出后向 Broker 端发起 Pull 消息的请求。其中，可以重点对比下，RebalancePushImpl 和 RebalancePullImpl 两个实现类的 dispatchPullRequest() 方法不同，RebalancePullImpl 类里面的该方法为空。

消息消费队列在同一消费组不同消费者之间的负载均衡，其核心设计理念是**在一个消息消费队列在同一时间只允许被同一消费组内的一个消费者消费，一个消息消费者能同时消费多个消息队列。**

## 参考资料

[RocketMQ 设计](https://github.com/apache/rocketmq/blob/master/docs/cn/design.md) 
