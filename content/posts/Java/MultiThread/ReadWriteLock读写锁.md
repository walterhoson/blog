---
title: ReadWriteLock 读写锁
description: 简要分析 Java 中 ReadWriteLock 读写锁的概念及使用
toc: true
authors: 
    - WayneShen
tags: 
    - Concurrent
    - Java
    - Notes
categories: 
    - Java
series: []
date: '2020-05-02T13:42:+08:00'
lastmod: '2020-05-02T13:42:20+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中 ReadWriteLock 读写锁的概念及使用

<!--more-->

适用于**读多写少**的场景，在 JDK 并发包中提供了 ReadWriteLock 接口。实现类有 ReentrantReadWriteLock，支持可重入。

## 读写锁定义

读写锁是通用技术，都需要遵循以下三条基本原则：

1. 允许多个线程同时读共享变量；
2. 只允许一个线程写共享变量；
3. 如果一个写线程正在执行写操作，此时禁止读线程读共享变量。

读写锁与互斥锁的重要区别就是**读写锁允许多个线程同时读共享变量**，但读写锁的写操作是互斥的。

## 读写锁的升级与降级

**ReadWriteLock 不支持锁的升级**，若读锁还没有释放，就去获取写锁，会导致写锁永久等待，最终导致相关线程都被阻塞，永远无法被唤醒。

读写锁支持锁降级。ReentrantReadWriteLock 也**提供公平与非公平模式**。同时**写锁支持条件变量，读锁不支持条件变量**，读锁调用 `newCondition()` 会抛出 UnsupportedOperationException 异常。

## 简单示例

```java
class CachedData {
  Object data;
  volatile boolean cacheValid; 
  final ReadWriteLock rwl = new ReentrantReadWriteLock(); 
  // 读锁
  final Lock r = rwl.readLock(); 
  // 写锁
  final Lock w = rwl.writeLock();

  void processCachedData() { // 获取读锁
    r.lock();
    if (!cacheValid) {
      // 释放读锁，因为不允许读锁的升级 
      r.unlock();
      // 获取写锁
      w.lock();
      try {
        // 再次检查状态
        if (!cacheValid) {
          data = ...;
          cacheValid = true; 
        }
        // 释放写锁前，降级为读锁 
        r.lock();
      } finally {
        // 释放写锁 w.unlock();
      } 
    }
    // 此处仍然持有读锁 
    try {
        use(data);
    } finally {
      r.unlock();
    }
  }
}
```

## 参考资料

《Java 并发编程实战》