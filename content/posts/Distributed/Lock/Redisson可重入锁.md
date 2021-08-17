---
title: Redisson 可重入锁
description: 分布式锁 Redisson 的可重入特性
toc: true
authors: 
    - WayneShen
tags: 
    - Distributed
    - Theory
categories: 
    - Distributed
series: []
date: '2021-03-06T16:21:+08:00'
lastmod: '2021-03-06T16:21:20+08:00'
featuredImage: ''
draft: false
---

</br>

分布式锁 Redisson 的可重入特性

<!--more-->

## 可重入锁基本使用

基于 Redis 的 Redisson 分布式可重入锁 `RLock`  Java 对象实现了 `java.util.concurrent.locks.Lock` 接口。同时还提供了 [异步 (Async)](http://static.javadoc.io/org.redisson/redisson/3.10.0/org/redisson/api/RLockAsync.html)、[反射式 (Reactive)](http://static.javadoc.io/org.redisson/redisson/3.10.0/org/redisson/api/RLockReactive.html) 和 [RxJava2 标准](http://static.javadoc.io/org.redisson/redisson/3.10.0/org/redisson/api/RLockRx.html) 的接口。

```java
RLock lock = redisson.getLock("anyLock");
// 最常见的使用方法
lock.lock();
```

大家都知道，**如果负责储存这个分布式锁的 Redisson 节点宕机以后，而且这个锁正好处于锁住的状态时，这个锁会出现锁死的状态**。

为了避免这种情况的发生，**Redisson 内部提供了一个监控锁的看门狗**，它的作用是在 **Redisson 实例被关闭前，不断的延长锁的有效期**。默认情况下，**看门狗的检查锁的超时时间是 30 秒钟**，也可以通过修改 [Config.lockWatchdogTimeout](https://github.com/redisson/redisson/wiki/2.-配置方法#lockwatchdogtimeout监控锁的看门狗超时单位毫秒)来另行指定。

另外 Redisson 还通过加锁的方法提供了 `leaseTime` 的参数来指定加锁的时间。超过这个时间后锁便自动解开了。

```java
// 同步加锁以后 10 秒钟自动解锁，无需调用 unlock 方法手动解锁
lock.lock(10, TimeUnit.SECONDS);
// 尝试加锁，最多等待 100 秒，上锁以后 10 秒自动解锁
if (lock.tryLock(100, 10, TimeUnit.SECONDS)) {
   try {
     ...
   } finally {
       lock.unlock();
   }
}
```

Redisson 同时还为分布式锁提供了异步执行的相关方法：

```java
RLock lock = redisson.getLock("anyLock");
lock.lockAsync();
lock.lockAsync(10, TimeUnit.SECONDS);
Future<Boolean> res = lock.tryLockAsync(100, 10, TimeUnit.SECONDS);
```

同步加锁时，如果未获取到则会阻塞住，而 `lock.lockAsync()` 则是异步加锁，用其他线程去进行加锁，不会阻塞当前主线程的执行。

通过 `RFuture<Boolean> res`，不断的去查询 Feture 对象的状态，看看异步加锁是否成功。

`RLock` 对象完全符合 Java 的 Lock 规范。也就是说只有拥有锁的进程才能解锁，其他进程解锁则会抛出`IllegalMonitorStateException`错误。

但是如果遇到需要其他进程也能解锁的情况，请使用 [分布式信号量](https://github.com/redisson/redisson/wiki/8.-分布式锁和同步器#86-信号量semaphore)`Semaphore` 对象。

## 参考资料

[Redisson-分布式锁和同步器](https://github.com/redisson/redisson/wiki/8.-分布式锁和同步器) 
