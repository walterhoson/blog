---
title: RocketMQ 消息存储
description: 主要分析 RocketMQ 的消息存储整体架构、PageCache 与 Mmap 内存映射以及 RocketMQ 中两种不同的刷盘方式三方面
toc: true
authors: 
    - WayneShen
tags: 
    - Middleware
    - RocketMQ
categories: 
    - Middleware
series: [RocketMQ]
date: '2021-07-03T13:10:+08:00'
lastmod: '2021-07-03T13:45:20+08:00'
draft: false
---

</br>

主要分析 RocketMQ 的消息存储整体架构、PageCache 与 Mmap 内存映射以及 RocketMQ 中两种不同的刷盘方式三方面

<!--more-->

## 常见的消息存储方案

### DB 存储

ActiveMQ（默认采用 KahaDB）可以选用 JDBC 的方式来做消息的持久化。但由于 MySQL 在单表数据量达到千万级别的情况下，IO 读写性能会出现瓶颈。同时可靠性依赖 DB 的可靠性。

所以选择 DB 存储不是一个理想的选择。

### 文件系统

RocketMQ、Kafka、RabbitMQ 通过刷盘到文件系统来保证消息数据持久化。区分同步刷盘和异步刷盘两种模式。性能比 DB 要好。

磁盘使用得当速度完全可以匹配上网络的数据传输速度，目前的高性能磁盘，顺序写速度可以达到 600MB/s，超过了一般网卡的传输速度。但磁盘随机写的速度只有大概 100KB/s，和顺序写的性能相差 6000 倍。因为有如此巨大的速度差别，好的消息队列系统会比普通的消息队列系统速度快多个数量级。**RocketMQ 的消息用顺序写，保证了消息存储的速度**。

## RocketMQ消息存储整体架构

![rocketmq_store](../../../assets/RocketMQ消息存储/rocketmq_store.png)

### CommitLog

**消息主体以及元数据的存储主体，存储 Producer 端写入的消息主体内容**，消息内容不是定长的。单个文件大小默认 1G，文件名长度为 20 位，左边补零，剩余为起始偏移量，

比如 `00000000000000000000` 代表了第一个文件，起始偏移量为 0，文件大小为 1G=1073741824；当第一个文件写满了，第二个文件为 `00000000001073741824`，起始偏移量为 1073741824，以此类推。

消息主要是顺序写入日志文件，当文件满了，写入下一个文件；

### ConsumeQueue

消息消费队列，引入的目的主要是**提高消息消费的性能**，由于 RocketMQ 是基于主题 topic 的订阅模式，消息消费是针对主题进行的，如果要遍历 commitlog 文件中根据 topic 检索消息是非常低效的。**Consumer 即可根据 ConsumeQueue 来查找待消费的消息**。

其中，ConsumeQueue（逻辑消费队列）作为消费消息的索引，保存了**指定 Topic 下的队列消息在 CommitLog 中的起始物理偏移量 offset，消息大小 size 和消息 Tag 的 HashCode 值**。consumequeue 文件可以看成是基于 topic 的 commitlog 索引文件，故 consumequeue 文件夹的组织方式如下：`topic/queue/file` 三层组织结构，具体存储路径为：`$HOME/store/consumequeue/{topic}/{queueId}/{fileName}`。

同样 consumequeue 文件采取定长设计，每一个条目共 20 个字节，分别为 8 字节的 commitlog 物理偏移量、4 字节的消息长度、8 字节 tag hashcode，单个文件由 30W 个条目组成，可以像数组一样随机访问每一个条目，每个 ConsumeQueue 文件大小约 5.72M；

### IndexFile

IndexFile（索引文件）提供了一种可以**通过 key 或时间区间来查询消息**的方法。

Index 文件的存储位置是：`$HOME\store\index${fileName}`，文件名 fileName 是以创建时的时间戳命名的，固定的单个 IndexFile 文件大小约为 400M，一个 IndexFile 可以保存 2000W 个索引，IndexFile 的底层存储设计为在文件系统中实现 HashMap 结构，故 **rocketmq 的索引文件其底层实现为 hash 索引**。

通过 RocketMQ 的消息存储整体架构图中可以看出，RocketMQ 采用的是混合型的存储结构，即为 Broker 单个实例下所有的队列共用一个日志数据文件（即为 CommitLog）来存储。也就是说多个 Topic 的消息实体内容都存储于一个 CommitLog 中。

RocketMQ 的混合型存储结构针对 Producer 和 Consumer 分别采用了数据和索引部分相分离的存储结构，Producer 发送消息至 Broker 端，然后 Broker 端使用同步或者异步的方式对消息刷盘持久化，保存至 CommitLog 中。

只要消息被刷盘持久化至磁盘文件 CommitLog 中，那么 Producer 发送的消息就不会丢失。正因为如此，Consumer 也就肯定有机会去消费这条消息。

当无法拉取到消息后，可以等下一次消息拉取，同时服务端也支持长轮询模式，若一个消息拉取请求未拉取到消息，Broker 允许等待 30s，只要这段时间内有新消息到达，将直接返回给消费端。此处具体做法是，使用 Broker 端的后台服务线程 `ReputMessageService` 不停地分发请求并异步构建 ConsumeQueue（逻辑消费队列）和 IndexFile（索引文件）数据。

## 页缓存与内存映射

页缓存（PageCache) 是 **OS 对文件的缓存，用于加速对文件的读写**。

一般来说，**程序对文件进行顺序读写的速度几乎接近于内存的读写速度**，主要原因就是由于 OS 使用 PageCache 机制对读写访问操作进行了性能优化，将一部分的内存用作 PageCache。对于数据的写入，OS 会先写入至 Cache 内，随后通过异步的方式由 pdflush 内核线程将 Cache 内的数据刷盘至物理磁盘上。

对于数据的读取，如果一次读取文件时出现未命中 PageCache 的情况，OS 从物理磁盘上访问读取文件的同时，会顺序对其他相邻块的数据文件进行预读取。

在 RocketMQ 中，ConsumeQueue 逻辑消费队列存储的数据较少，并且是顺序读取，在 page cache 机制的预读取作用下，Consume Queue 文件的读性能几乎接近读内存，即使在有消息堆积情况下也不会影响性能。而对于 CommitLog 消息存储的日志数据文件来说，读取消息内容时会产生较多的随机访问读取，严重影响性能。如果选择合适的系统 IO 调度算法，比如设置调度算法为“Deadline”（此时若块存储采用 SSD），随机读的性能也会有所提升。

另外，RocketMQ 主要通过 MappedByteBuffer 对文件进行读写操作。其中，利用了 NIO 中的 FileChannel 模型将磁盘上的物理文件直接映射到用户态的内存地址中（这种 Mmap 的方式减少了传统 IO 将磁盘文件数据在操作系统内核地址空间的缓冲区和用户应用程序地址空间的缓冲区之间来回进行拷贝的性能开销），将对文件的操作转化为直接对内存地址进行操作，从而极大地提高了文件的读写效率。

正因为需要使用内存映射机制（MappedByteBuffer），该机制有几个限制，一是一次只能映射 1.5-2G 的文件至用户态的虚拟内存，故 RocketMQ 的文件存储都使用定长结构来存储（单个 CommitLog 日志数据文件为 1G），方便一次将整个文件映射至内存。

### 零拷贝技术

Linux 区分”用户态“和”内核态“，文件操作、网络操作需要涉及这两种形态的切换，免不了进行数据复制。

一台服务器把本机磁盘文件的内容发送到客户端，一般分为两个步骤：

1. read; 读取本地文件内容；
2. write; 将读取的内容通过网络发送出去。

这两个操作，实际进行了 4 次数据复制，分别是：

1. 从磁盘复制数据到内核态内存；
2. 再从内核态内存复制到用户态内存；
3. 再从用户态内存复制到网络驱动的内核态内存；
4. 最后是从网络驱动的内核态内存复制到网卡中进行传输。

> 数据 -> 内核态 -> 用户态 -> 网络驱动内核态 -> 网卡 -> 数据

通过使用 mmap 的方式，可以省去向用户态的内存复制，提高速度，这种机制在 Java 中是通过 MappedByteBuffer 实现的。

>  数据 -> 内核态 -> 网络驱动内核态 -> 网卡 -> 数据

RocketMQ 充分利用了上述特性，也就是所谓的"零拷贝"技术，提高消息存盘和网络发送的速度。

零拷贝包括两种方式，RocketMQ 使用第一种方式，因小块数据传输的要求效果比 sendfile 方式好

**使用 mmap+write 方式**

优点：即使频繁调用，使用小文件块传输，效率也很高

缺点：不能很好的利用 DMA 方式，会比 sendfile 多消耗 CPU 资源，内存安全性控制复杂，需要避免 JVM Crash 问题。

**使用 sendfile 方式**

优点：可以利用 DMA 方式，消耗 CPU 资源少，大块文件传输效率高，无内存安全的问题。

缺点：小块文件效率低于 mmap 方式，只能是 BIO 方式传输，不能使用 NIO。

## 消息刷盘

RocketMQ 的消息是存储到磁盘上的，这样既能保证断电后恢复，又可以让存储的消息量超出内存的限制。

RocketMQ 为了提高性能，会**尽可能地保证磁盘的顺序写**。消息在通过 Producer 写入 RocketMQ 时，有同步刷盘和异步刷盘两种写磁盘方式。

![rocketmq_flush_desk](../../../assets/RocketMQ消息存储/rocketmq_flush_desk.png)

### 同步刷盘

如上图所示，只有在消息真正持久化至磁盘后 RocketMQ 的 Broker 端才会真正返回给 Producer 端一个成功的 ACK 响应。

具体流程是，消息写入内存的 PageCache 后，立刻通知刷盘线程进行刷盘，等待刷盘完成，刷盘线程执行完成后唤醒等待的线程，返回消息写成功的状态。

同步刷盘对 MQ 消息可靠性来说是一种不错的保障，但是性能上会有较大影响，一般适用于金融业务应用该模式较多。

### 异步刷盘

能够充分利用 OS 的 PageCache 的优势，只要消息写入 PageCache 即可将成功的 ACK 返回给 Producer 端。消息刷盘采用后台异步线程提交的方式进行，降低了读写延迟，提高了 MQ 的性能和吞吐量。

当内存里的消息量积累到一定程度时，统一触发写磁盘动作，快速写入。

### 刷盘配置

通过 Broker 配置文件里的 `flushDiskType` 参数设置，这个参数被配置成 `SYNC_FLUSH`（同步刷盘）或 `ASYNC_FLUSH`（异步刷盘）。

## 参考资料

[RocketMQ 设计](https://github.com/apache/rocketmq/blob/master/docs/cn/design.md) 
