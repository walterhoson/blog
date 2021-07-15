---
title: RocketMQ 消息简介
description: 主要分析 RocketMQ 的多种消息类型，以及消息的属性。
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

主要分析 RocketMQ 的多种消息类型，以及消息的属性。

<!--more-->

## 消息类型

### 顺序消息

消息有序是指可以**按照消息的发送顺序来消费**（FIFO）。RocketMQ 可以严格的保证消息有序，分为**分区有序**或**全局有序**。

在默认的情况下消息发送会采取 Round Robin 轮询方式把消息发送到不同的 queue（分区队列），而消费消息时从多个 queue 上拉取消息，这种情况发送和消费是不能保证顺序。但如果控制发送的顺序消息**只依次发送到同一个 queue 中，消费时只从这个 queue 上依次拉取，则就保证了顺序**。

当发送和消费参与的 queue 只有一个，则是全局有序，能保证指定的一个 Topic 下所有的消息都是按照先进先出的顺序进行发布和消费。控制全局有序，对于性能有损耗。

如果多个 queue 参与，则为分区有序，即相对每个 queue，消息都是有序的。

比如在下单场景下，一个订单的顺序是：创建、付款、推送、完成。使用全局有序，订单号相同的消息被先后发送到同一个队列中，消费时，同一个 orderId 获取到的肯定是同一个队列。

### 延迟消息

延迟队列（定时消息）是指**消息发送到 broker 后，不会立即被消费，等待特定时间投递给真正的 topic**。 

broker 有配置项 messageDelayLevel，默认值为 `1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m 20m 30m 1h 2h` 18 个 level。可以配置自定义 messageDelayLevel。并不支持自定义配置除这 18 个 level 之外的等级。

注意，messageDelayLevel 是 broker 的属性（在 MessageStoreConfig 下），不属于某个 topic。发消息时，设置 delayLevel 等级即可：``msg.setDelayLevel(level)``。level 有以下三种情况：

- level == 0，消息为非延迟消息
- 1 <= level <= maxLevel，消息延迟特定时间，例如 level==1，延迟 1s
- level > maxLevel，则 level == maxLevel，例如 level==20，延迟 2h

定时消息会暂存在名为 `SCHEDULE_TOPIC_XXXX`（XXXX 为固定的）的 topic 中，并根据 delayTimeLevel 存入特定的 queue（统称延迟队列），``queueId = delayTimeLevel – 1``，**即一个 queue 只存相同延迟的消息，保证具有相同发送延迟的消息能够顺序消费**。broker 会调度地消费 `SCHEDULE_TOPIC_XXXX`，将消息写入真实的 topic。

需要注意的是，定时消息在第一次写入和调度写入真实 topic 时都会计数，因此发送数量、tps 都会变高。

### 批量消息

批量发送消息能显著提高传递小消息的性能。

限制是这些批量消息应该有**相同的 topic**，**相同的 waitStoreMsgOK**，**且不能是延时消息**。此外，这一批消息的**总大小不应超过 4MB**。

### 事务消息

Transactional Message 是指**应用本地事务和发送消息操作可以被定义到全局事务中**，要么同时成功，要么同时失败。

RocketMQ 的事务消息提供类似 X/Open XA 的分布事务功能，通过事务消息能达到分布式事务的**最终一致**。

事务消息的大致方案，分为两个流程：正常事务消息的发送及提交、事务消息的补偿流程。

![rocketmq_transaction](../../../assets/RocketMQ消息简介/rocketmq_transaction.png)

#### 事务消息发送及提交

1. 发送消息（half 消息）；
2. 服务端响应消息写入结果；
3. 根据发送结果执行本地事务（如果写入失败，此时 half 消息对业务不可见，本地逻辑不执行）；
4. 根据本地事务状态执行 Commit 或者 Rollback（Commit 操作生成消息索引，消息对消费者可见）。

#### 事务补偿

1. 对没有 Commit/Rollback 的事务消息（pending 状态的消息），从服务端发起一次“回查”；
2. Producer 收到回查消息，检查回查消息对应的本地事务的状态；
3. 根据本地事务状态，重新 Commit 或 Rollback。

其中，补偿阶段用于解决消息 Commit 或 Rollback 发生超时或者失败的情况。

#### 事务消息状态

事务消息共有三种状态，提交状态、回滚状态、中间状态：

+ TransactionStatus.CommitTransaction: 提交事务，允许消费者消费此消息。
+ TransactionStatus.RollbackTransaction: 回滚事务，代表该消息将被删除，不允许被消费。
+ TransactionStatus.Unknown: 中间状态，代表需要检查消息队列来确定状态。

#### 实现逻辑

如果消息是 half 消息，RocketMQ 将备份原消息的主题与消息消费队列，然后改变主题为 `RMQ_SYS_TRANS_HALF_TOPIC` 。

由于消费组未订阅该主题，故消费端无法消费 half 类型的消息，然后 RocketMQ 会开启一个定时任务，从 Topic 为 `RMQ_SYS_TRANS_HALF_TOPIC` 中拉取消息进行消费，根据生产者组获取一个服务提供者发送回查事务状态请求，根据事务状态来决定是提交或回滚消息。

#### 使用方式

**创建事务性生产者**

使用 ``TransactionMQProducer``类创建生产者，并指定唯一的 `ProducerGroup`，同时设置事务消息监听者 ``TransactionListener``，然后就可以设置自定义线程池来处理这些检查请求。

执行本地事务后，需要根据执行结果对消息队列进行回复，回传事务状态。

**实现事务的监听接口**

当发送半消息成功时，使用 `executeLocalTransaction` 方法来执行本地事务。并返回三个事务状态之一。

通过 `checkLocalTranscation` 方法检查本地事务状态，并回应消息队列的检查请求。

#### 使用限制

1. 事务消息不支持延时消息和批量消息。
2. 为了避免单个消息被检查太多次而导致半队列消息累积，**默认将单个消息的检查次数限制为 15 次**，但用户可以通过 Broker 配置文件的 `transactionCheckMax` 参数来修改此限制。如果已经检查某条消息超过 N 次的话（ N = `transactionCheckMax` ） 则 Broker 将丢弃此消息，并在默认情况下同时打印错误日志。用户可以通过重写 ``AbstractTransactionCheckListener`` 类来修改这个行为。
3. 事务消息在特点时间后被检查，可以通过 Broker 配置文件中的参数 `transactionMsgTimeout` 来设置。当发送事务消息时，用户还可以通过设置用户属性 `CHECK_IMMUNITY_TIME_IN_SECONDS` 来改变这个限制，该参数优先于 `transactionMsgTimeout` 参数。
4. 事务性消息可能不止一次被检查或消费。
5. 提交给用户的目标主题消息可能会失败，目前这依日志的记录而定。它的高可用性通过 RocketMQ 本身的高可用性机制来保证，如果希望确保事务消息不丢失、并且事务完整性得到保证，建议使用同步的双重写入机制。
6. 事务消息的生产者 ID 不能与其他类型消息的生产者 ID 共享。与其他类型的消息不同，事务消息允许反向查询、MQ 服务器能通过它们的生产者 ID 查询到消费者。

## 消息重试

Consumer 消费消息失败后，要提供一种重试机制，令消息再消费一次。消费失败的依据一般有三个：返回 `Action.ReconsumeLater`、`null`、抛出 exception。

而 Consumer 消费消息失败通常可以认为有以下几种情况：

- 由于消息本身的原因，例如反序列化失败，消息数据本身无法处理（例如话费充值，当前消息的手机号被注销，无法充值）等。这种错误通常需要跳过这条消息，再消费其它消息，而这条失败的消息即使立刻重试消费，99%也不成功，所以最好提供一种定时重试机制，即过 10 秒后再重试。
- 由于依赖的下游应用服务不可用（例如 db 连接不可用，外系统网络不可达等）。遇到这种错误，即使跳过当前失败的消息，消费其他消息同样也会报错。这种情况建议应用 sleep 30s，再消费下一条消息，这样可以减轻 Broker 重试消息的压力。

RocketMQ 会为每个消费组都设置一个 Topic 名称为“ `%RETRY%+consumerGroup` ”的重试队列（需要注意的是，该 Topic 的重试队列是针对消费组，而不是针对每个 Topic 设置的），用于暂时保存因为各种异常而导致 Consumer 端无法消费的消息。

考虑到异常恢复需要一些时间，会为重试队列设置多个重试级别，每个重试级别都有与之对应的重新投递延时，重试次数越多投递延时就越大。RocketMQ 对于重试消息的处理是先保存至 Topic 名为“ `SCHEDULE_TOPIC_XXXX` ”的延迟队列中，后台定时任务按照对应的时间进行 Delay 后重新保存至“ `%RETRY%+consumerGroup` ”的重试队列中。

其实重试的逻辑就是，利用了延迟队列，按照其的 level 不断的重试，默认重试 16 次（若一直失败，则总耗时 4h46min），超过这个时间范围消息仍失败则将不再重试投递，进入死信队列。

需要注意的是，一条消息无论重试多少次，这些重试消息的 Message ID 不会改变。

### 顺序消息的重试

对于顺序消息，当消费者消费消息失败后，RocketMQ 会自动不断进行消息重试（每次间隔时间为 1 秒），这时，应用会出现消息消费被阻塞的情况。

因此，在使用顺序消息时，务必保证应用能够及时监控并处理消费失败的情况，避免阻塞现象的发生。

### 无序消息的重试

对于无序消息（普通、延时、事务消息），当消费者消费消息失败时，可以通过设置返回状态达到消息重试的结果。

无序消息的重试只针对集群消费方式生效；**广播方式不提供失败重试特性**，即消费失败后，失败消息不再重试，继续消费新的消息。

**自定义消息最大重试次数**

RocketMQ 允许 Consumer 启动时设置最大重试次数，重试时间间隔将按照如下策略：

- 最大重试次数小于等于 16 次，则重试时间间隔如上延迟队列描述。
- 最大重试次数大于 16 次，超过 16 次的重试时间间隔均为每次 2 小时。

```java
Properties properties = new Properties();
//配置对应 Group ID 的最大消息重试次数为 20 次
properties.put(PropertyKeyConst.MaxReconsumeTimes,"20");
Consumer consumer = ONSFactory.createConsumer(properties);
```

> 注意：

- 消息最大重试次数的设置对相同 Group ID 下的所有 Consumer 实例有效。
- 若只对相同 Group ID 下两个 Consumer 实例中的其中一个设置了 MaxReconsumeTimes，那么该配置对两个 Consumer 实例均生效。
- 配置采用覆盖的方式生效，即最后启动的 Consumer 实例会覆盖之前的启动实例的配置。

**获取重试次数**

可以通过消费的消息获取，``message.getReconsumeTimes()``。

## 消息重投

生产者在发送消息时，同步消息失败会重投，异步消息有重试，oneway 没有任何保证。消息重投保证消息尽可能发送成功、不丢失，但可能会造成消息重复，消息重复在 RocketMQ 中是无法避免的问题。

消息重复在一般情况下不会发生，当出现消息量大、网络抖动，消息重复就会是大概率事件。另外，生产者主动重发、consumer 负载变化也会导致重复消息。如下方法可以设置消息重试策略：

- retryTimesWhenSendFailed：同步发送失败重投次数，默认为 2，因此生产者会最多尝试发送 `retryTimesWhenSendFailed + 1` 次。不会选择上次失败的 broker，尝试向其他 broker 发送，最大程度保证消息不丢。超过重投次数，抛出异常，由客户端保证消息不丢。当出现 `RemotingException`、`MQClientException` 和部分 `MQBrokerException` 时会重投。
- retryTimesWhenSendAsyncFailed：异步发送失败重试次数，异步重试不会选择其他 broker，仅在同一个 broker 上做重试，不保证消息不丢。
- retryAnotherBrokerWhenNotStoreOK：消息刷盘（主或备）超时或 slave 不可用（返回状态非 SEND_OK），是否尝试发送到其他 broker，默认 false。十分重要消息可以开启。

## 回溯消费

指 Consumer 已经消费成功的消息，由于业务上需求需要重新消费，要支持此功能。

Broker 在向 Consumer 投递成功消息后，消息仍然需要保留。并且重新消费一般是按照时间维度，例如由于 Consumer 系统故障，恢复后需要重新消费 1 小时前的数据，那么 Broker 要提供一种机制，可以按照时间维度来回退消费进度。RocketMQ 支持按照时间回溯消费，时间维度精确到毫秒。

## 死信队列

死信队列用于处理无法被正常消费的消息。当一条消息初次消费失败，消息队列会自动进行消息重试；达到最大重试次数后，若消费依然失败，则表明消费者在正常情况下无法正确地消费该消息，此时，消息队列不会立刻将消息丢弃，而是将其发送到该消费者对应的特殊队列中。

RocketMQ 将这种正常情况下无法被消费的消息称为死信消息（Dead-Letter Message），将存储死信消息的特殊队列称为死信队列（Dead-Letter Queue）。

在 RocketMQ 中，可以通过使用 console 控制台对死信队列中的消息进行重发来使得消费者实例再次进行消费。

死信消息具有以下特性

+ 不会再被消费者正常消费。
+ 有效期与正常消息相同，均为 3 天，3 天后会被自动删除。因此，请在死信消息产生后的 3 天内及时处理。

死信队列具有以下特性：

+ 一个死信队列对应一个 Group ID， 而不是对应单个消费者实例。
+ 如果一个 Group ID 未产生死信消息，RocketMQ 不会为其创建相应的死信队列。
+ 一个死信队列包含了对应 Group ID 产生的所有死信消息，不论该消息属于哪个 Topic。

## 消息幂等

RocketMQ 消费者在接收到消息以后，有必要根据业务上的唯一 Key 对消息做幂等处理。

### 消费幂等的必要性

在互联网应用中，尤其在网络不稳定的情况下，RocketMQ 的消息有可能会出现重复，这个重复可以概括为以下情况：

- 发送时消息重复。**当一条消息已被成功发送到服务端并完成持久化，此时出现了网络闪断或生产者客户端宕机，导致服务端对生产者应答失败**。若此时生产者认为消息发送失败并尝试再次发送消息，消费者后续会收到两条内容相同并且 Message ID 也相同的消息。

- 投递时消息重复。消息消费的场景下，消息已投递到消费者并完成业务处理，当消费者客户端给服务端反馈应答时网络闪断。 为了保证消息至少被消费一次，RocketMQ 的服务端将在网络恢复后再次尝试投递之前已被处理过的消息，消费者后续会收到两条内容相同并且 Message ID 也相同的消息。

- 负载均衡时消息重复（包括但不限于网络抖动、Broker 重启以及订阅方应用重启）。当 Broker 或客户端重启、扩容或缩容时，会触发 Rebalance，此时消费者可能会收到重复消息。

### 处理方式

因为 Message ID 有可能出现冲突（重复）的情况，所以真正安全的幂等处理，不建议以 Message ID 作为处理依据。 

最好的方式是**以业务唯一标识作为幂等处理的关键依据**，而业务的唯一标识可以**通过消息 Key 进行设置**：

## 消息过滤

消费者可以根据 Tag 进行消息过滤，也支持自定义属性过滤。

![rocketmq_message](../../../assets/RocketMQ消息简介/rocketmq_design_7.png)

消息过滤目前是在 Broker 端实现的，优点是**减少了对于 Consumer 无用消息的网络传输**，缺点是增加了 Broker 的负担、且实现相对复杂。

主要支持如下 2 种的过滤方式

### Tag 过滤

Consumer 端在订阅消息时除了指定 Topic 还可以指定 TAG，若一个消息有多个 TAG，可以用 || 分隔。

其中，Consumer 端会将这个订阅请求构建成一个 SubscriptionData，发送一个 Pull 消息的请求给 Broker 端。Broker 端从 RocketMQ 的文件存储层 Store 读取数据之前，会用这些数据先构建一个 ``MessageFilter``，然后传给 Store。Store 从 ConsumeQueue 读取到一条记录后，会用它记录的消息 tag hash 值去做过滤，由于在服务端只是根据 hashcode 进行判断，无法精确对 tag 原始字符串进行过滤，故在消息消费端拉取到消息后，还需要对消息的原始 tag 字符串进行比对，如果不同，则丢弃该消息，不进行消息消费。

### SQL92 的过滤

与 Tag 过滤方式大致一样，只是在 Store 层的具体过滤过程不太一样，真正的 SQL expression 的构建和执行由 rocketmq-filter 模块负责的。每次过滤都去执行 SQL 表达式会影响效率，所以 RocketMQ 使用了 BloomFilter 避免了每次都去执行。SQL92 的表达式上下文为消息的属性。

只有使用 push 模式的消费者才能用使用 SQL92 标准的 sql 语句。

对于复杂场景，可以使用 SQL 表达式筛选消息，SQL 特性可以通过发送消息时的属性来进行计算。在 RocketMQ 定义的语法下，可以实现一些简单的逻辑。

发送消息时，通过 ``message.putUserProperty`` 来设置消息的属性；消费消息时，通过 ``MessageSelector.bySql`` 来使用 sql 筛选消息。

**SQL 基本语法**

RocketMQ 只定义了一些基本语法来支持这个特性。也可以很容易地扩展它。

* 数值比较，比如：**>，>=，<，<=，BETWEEN，=；**
* 字符比较，比如：**=，<>，IN；**
* **IS NULL** 或 **IS NOT NULL；**
* 逻辑符号 **AND，OR，NOT；**

常量支持类型为：

* 数值，比如：**123，3.1415；**
* 字符，比如：**'abc'，必须用单引号包裹起来；**
* **NULL**，特殊的常量
* 布尔值，**TRUE** 或 **FALSE**

## 消息流控

生产者流控，因为 broker 处理能力达到瓶颈；消费者流控，因为消费能力达到瓶颈。

### 生产者流控

- commitLog 文件被锁时间超过 `osPageCacheBusyTimeOutMills` 时，参数默认为 1000ms，返回流控。
- 若开启 ``transientStorePoolEnable == true``，且 broker 为异步刷盘的主机，且 transientStorePool 中资源不足，拒绝当前 send 请求，返回流控。
- broker 每隔 10ms 检查 send 请求队列头部请求的等待时间，如果超过 `waitTimeMillsInSendQueue`，默认 200ms，拒绝当前 send 请求，返回流控。
- broker 通过拒绝 send 请求方式实现流量控制。

注意，生产者流控，不会尝试消息重投。

### 消费者流控

- 消费者本地缓存消息数超过 `pullThresholdForQueue` 时，默认 1000。
- 消费者本地缓存消息大小超过 `pullThresholdSizeForQueue` 时，默认 100MB。
- 消费者本地缓存消息跨度超过 `consumeConcurrentlyMaxSpan` 时，默认 2000。

消费者流控的结果是降低拉取频率。

## 消息查询

RocketMQ 支持按照下面两种维度，按照 Message Id 或 Message Key 进行消息查询。

### 按 MessageId 查询

RocketMQ 中的 MessageId 的长度总共有 16 字节，其中包含了消息存储主机地址（IP 地址和端口），消息 Commit Log offset。

按照 MessageId 查询消息，具体做法是：Client 端从 MessageId 中解析出 Broker 的地址（IP 地址和端口）和 Commit Log 的偏移地址后封装成一个 RPC 请求后通过 Remoting 通信层发送（业务请求码：VIEW_MESSAGE_BY_ID）。Broker 端走的是 QueryMessageProcessor，读取消息的过程用其中的 commitLog offset 和 size 去 commitLog 中找到真正的记录并解析成一个完整的消息返回。

### 按 Message Key 查询

主要是基于 RocketMQ 的 IndexFile 索引文件来实现的。RocketMQ 的索引文件逻辑结构，类似 JDK 中 HashMap 的实现。索引文件的具体结构如下：

![rocketmq_design_13](../../../assets/RocketMQ消息简介/rocketmq_design_13.png)

IndexFile 索引文件为用户提供通过 Message Key 的消息索引查询服务，IndexFile 文件的存储位置是：`$HOME\store\index${fileName}`，文件名 fileName 是以创建时的时间戳命名的，文件大小是固定的，等于 ``40+500W*4+2000W*20 = 420000040`` 个字节大小。

若消息的 properties 中设置了 UNIQ_KEY 这个属性，就用 `topic + # + UNIQ_KEY` 的 value 作为 key 来做写入操作。若消息设置了 KEYS 属性（多个 KEY 以空格分隔），也会用 `topic + # + KEY` 来做索引。

其中的索引数据包含了 Key Hash、CommitLog Offset、Timestamp、NextIndex offset 这四个字段，一共 20 Byte。

NextIndex offset 即前面读出来的 slotValue，如果有 hash 冲突，就可以用这个字段将所有冲突的索引用链表的方式串起来了。

Timestamp 记录的是消息 storeTimestamp 之间的差，并不是一个绝对的时间。整个 Index File 的结构如图，40 Byte 的 Header 用于保存一些总的统计信息，4*500W 的 Slot Table 并不保存真正的索引数据，而是保存每个槽位对应的单向链表的头。20*2000W 是真正的索引数据，即一个 Index File 可以保存 2000W 个索引。

按照 Message Key 查询消息的方式，具体做法是，主要通过 Broker 端的 QueryMessageProcessor 业务处理器来查询，读取消息的过程就是用 topic 和 key 找到 IndexFile 索引文件中的一条记录，根据其中的 commitLog offset 从 CommitLog 文件中读取消息的实体内容。

## 参考资料

[RocketMQ 设计](https://github.com/apache/rocketmq/blob/master/docs/cn/design.md) 
