---
title: RocketMQ 高可用机制
description: 主要分析 RocketMQ 保证高可用的原理，包括集群部署方式和消息主从复制方式
toc: true
authors: 
    - WayneShen
tags: 
    - Middleware
    - RocketMQ
categories: 
    - Middleware
series: [RocketMQ]
date: '2021-07-03T14:30:+08:00'
lastmod: '2021-07-03T14:50:50+08:00'
draft: false
---

</br>

主要分析 RocketMQ 保证高可用的原理，包括集群部署方式和消息主从复制方式。

<!--more-->

## 消息可靠性

RocketMQ 支持消息的高可靠，其中影响可靠性的情况有：

1. Broker 正常关闭
2. Broker 异常 Crash
3. OS Crash
4. 机器掉电，但是能立即恢复供电情况
5. 机器无法开机（可能是 cpu、主板、内存等关键设备损坏）
6. 磁盘设备损坏

1-4 的四种情况属于硬件资源可理解恢复情况，RocketMQ 在这四种情况下能保证消息不丢，或丢失少量数据（依赖刷盘方式是同步还是异步）。

5-6 属于单点故障，且无法恢复，一旦发生，在此单点上的消息全部丢失。RocketMQ 在这两种情况下，通过异步复制，可保证 99%的消息不丢，但仍会有极少量的消息可能丢失。通过同步双写技术可以完全避免单点，但同步双写势必会影响性能，适合对消息可靠性要求极高的场合，例如与财务相关的应用。注：RocketMQ 从 3.0 版本开始支持同步双写。

## 分布式集群部署

RocketMQ 分布式集群是**通过 Master 和 Slave 的配合达到高可用性**。

![rocketmq_role](../../../assets/RocketMQ高可用机制/rocketmq_role.jpg)

Master 和 Slave 的区别是，在 Broker 的配置文件中，参数 brokerId 的值为 0 表示该 Broker 是 Master，大于 0 表示该 Broker 是 Slave，同时 brokerRole 参数也会说明这个 Broker 是 Master 还是 Slave。

Master 角色的 Broker 支持读和写，Slave 角色的 Broker 仅支持读；也就是 Producer 只能和 Master 角色的 Broker 连接写入消息；Consumer 可以连接 Master 或 Slave 角色的 Broker 来读取消息。

### 消息发送高可用

在创建 Topic 时，把 Topic 的多个 Message Queue 创建在多个 Broker 组上（相同 Broker 名称，不同 brokerId 的机器组成一个 Broker 组），这样当一个 Broker 组的 Master 不可用后，其他组的 Master 仍然可用，Producer 仍然可以发送消息。

此处需要注意的是，在同步双写情况下，可能由于 master 接受到数据后，成功同步给 slave 之后，master 未来及返回 producer 成功的 ack，就会导致 producer 认为消息没有发送成功，所以选择另一台 master 发送，导致消息重复。

RocketMQ 目前还不支持把 Slave 自动转成 Master，若机器资源不足， 需要把 Slave 转成 Master，则要手动停止 Slave 角色的 Broker，更改配置文件，用新的配置文件启动 Broker。

![rocketmq_ha](../../../assets/RocketMQ高可用机制/rocketmq_ha.jpg)

### 消息消费高可用

在 Consumer 的配置文件中，并不需要设置是从 Master 读还是从 Slave 读，**当 Master 不可用或繁忙时，Consumer 会被自动切换到从 Slave 读**。有了自动切换 Consumer 机制，当一个 Master 角色的机器出现故障后，Consumer 仍然可以从 Slave 读取消息，不影响 Consumer 程序。就达到了消费端的高可用性。

## 消息主从复制

如果一个 Broker 组有 Master 和 Slave，消息需要从 Master 复制到 Slave 上，有同步和异步两种复制方式。

通过 Broker 配置文件里的 brokerRole 参数进行设置，这个参数可以被设置成 ASYNC_MASTER、SYNC_MASTER、SLAVE 三个值中的一个。默认 ASYNC_MASTER（异步复制）。

### 同步双写 Master

SYNC_MASTER，**等 Master 和 Slave 均写成功后才返回**给客户端写成功状态；

在同步复制方式下，若 Master 出故障，Slave 上有全部的备份数据，容易恢复，但同步复制会增大数据写入延迟，降低系统吞吐量。

### 异步复制 Master

ASYNC_MASTER，**只要 Master 写成功即可返回**给客户端写成功状态。

### 实际应用

实际应用中要结合业务场景，合理设置刷盘方式和主从复制方式，尤其是 SYNC_FLUSH 方式，由于频繁地触发磁盘写动作，会明显降低性能。

通常情况下，应该把 Master 和 Slave 配置成 ASYNC_FLUSH 的刷盘方式，主从之间配置成 SYNC_MASTER 的复制方式，这样即使有一台机器出故障，仍然能保证数据不丢，是个不错的选择。

> 存在问题，若异步刷盘+同步主从复制，在 master 成功同步数据给 slave 后，没来及返回 producer 就发生 crash，此时 producer 选择另一个 master 发送，导致消息重复，如何解决。

## 参考资料

[RocketMQ 特性](https://github.com/apache/rocketmq/blob/master/docs/cn/features.md) 
