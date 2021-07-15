---
title: StampedLock 比读写锁更快的锁
description: 简要分析 Java 中 StampedLock 的概念及使用
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
date: '2020-05-02T14:22:+08:00'
lastmod: '2020-05-02T14:22:20+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中 StampedLock 的概念及使用

<!--more-->

## StampedLock

StampedLock 支持三种模式，分别是：**写锁、悲观读锁和乐观读**。

写锁、悲观读锁的语义和 ReadWriteLock 的写锁、读锁的语义非常类似，允许多个线程同时获取悲观读锁，但只允许一个线程获取写锁，写锁和悲观读锁是互斥的。

不同的是：StampedLock 里的写锁和悲观读锁加锁成功后，都会返回一个 stamp，解锁时，需要传入这个 stamp。

示例代码：

```java
final StampedLock sl = new StampedLock();
// 获取/释放悲观读锁示意代码 
long stamp = sl.readLock(); 
try {
  // 省略业务相关代码
} finally {
  sl.unlockRead(stamp); 
}

// 获取/释放写锁示意代码 
long stamp = sl.writeLock(); 
try {
  // 省略业务相关代码 
} finally {
  sl.unlockWrite(stamp);
}
```

StampedLock 的性能之所以比 ReadWriteLock 还要好，其关键是 StampedLock 支持乐观读的方式。

ReadWriteLock 支持多个线程同时读，但当多个线程同时读时，所有写操作会被阻塞，而 StampedLock 提供的乐观读，允许一个线程获取写锁，并不是所有的写操作都被阻塞。

乐观读，而非乐观锁。**StampedLock 的乐观读操作是无锁的**，所以相对 ReadWriteLock 的读锁，乐观读性能更好。

示例：

```java
class Point {
  private int x, y;
  final StampedLock sl = new StampedLock();
  // 计算到原点的距离  
  int distanceFromOrigin() {
    // 乐观读
    long stamp = sl.tryOptimisticRead();
    // 读入局部变量，读的过程数据可能被修改
    int curX = x, curY = y;
    // 判断执行读操作期间，是否存在写操作，若存在，则 sl.validate 返回 false
    if (!sl.validate(stamp)){
      // 升级为悲观读锁
      stamp = sl.readLock();
      try {
        curX = x;
        curY = y;
      } finally {
        //释放悲观读锁
        sl.unlockRead(stamp);
      }
    }
    return Math.sqrt(curX * curX + curY * curY);
  }
}
```

在执行乐观读操作期间，存在写操作，会把乐观读升级为悲观读锁。

这是合理的做法，否则就需要在一个循环里反复执行乐观读，直到执行乐观读操作的期间没有写操作（只有这样才能保证数据的正确性和一致性），而循环读会浪费大量的 CPU。升级为悲观读锁，代码简练且不易出错。

StampedLock 的乐观读和数据库的乐观锁有异曲同工之妙。stamp 就类似于数据库表中的 version 字段。

## 使用注意事项

对于读多写少的场景 StampedLock 性能很好，简单的应用场景基本上可以替代 ReadWriteLock，但 StampedLock 的功能仅仅是 ReadWriteLock 的子集，在使用时，需要注意的是：

+ StampedLock 不支持重入。
+ StampedLock 的悲观读锁、写锁都不支持条件变量。
  
还有点值得注意，线程阻塞在 StampedLock 的 `readLock()` 或者 `writeLock()` 上时，此时调用该阻塞线程的 `interrupt()` 方法，会导致该线程所在 CPU 飙升 100%。所以，使用 StampedLock 一定不要调用中断操作，如果需要支持中断功能，一定使用可中断的悲观读锁 `readLockInterruptibly()` 和写锁 `writeLockInterruptibly()`。

StampedLock 支持锁的降级（通过 `tryConvertToReadLock()` 方法实现）和升级（通过 `tryConvertToWriteLock()` 方法实现），但是升级后一定要记得解锁。

官方模板示例：

读：

```java
final StampedLock sl = new StampedLock();

// 乐观读
long stamp = sl.tryOptimisticRead();
// 读入方法局部变量
// 省略。.....
// 校验 stamp
if (!sl.validate(stamp)){
  // 升级为悲观读锁
  stamp = sl.readLock();
  try {
    // 读入方法局部变量
    // 省略。.....
  } finally {
    //释放悲观读锁
    sl.unlockRead(stamp);
  }
}
//使用方法局部变量执行业务操作
// 省略。.....
```

写：

```java
long stamp = sl.writeLock();
try {
  // 写共享变量
  // 省略。.....
} finally {
  sl.unlockWrite(stamp);
}
```

## 参考资料

《Java 并发编程实战》