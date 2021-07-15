---
title: CountDownLatch 与 CyclicBarrier
description: 简要分析 Java 中 CountDownLatch 与 CyclicBarrier 基础概念与使用，以及如何让多线程实现步调一致
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
date: '2020-05-02T15:12:+08:00'
lastmod: '2020-05-02T15:12:20+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中 CountDownLatch 与 CyclicBarrier 基础概念与使用，以及如何让多线程实现步调一致

<!--more-->

## 并行优化系统

对于串行化的系统，优化性能首先想到的是能否利用多线程并行处理。

### 用 CountDownLatch 实现线程等待

如果满足执行条件，任务 A 和任务 B 可以并行执行，只有 A 和 B 都结束后，再执行 C 的需求。

优化线路：

**方案一**

开两个线程，分别执行任务 A 和 B，调用两个线程的 `join()` 方法来等待，线程 Ta 和 Tb 结束退出后，主线程就会从阻塞态被唤醒，再执行任务 C。频繁创建线程比较耗时，此时可以选择创建一个线程池，以循环利用线程。

**方案二**

创建一个计数器（条件变量），初始值设置为 2，执行完任务 A 后计数器减一，执行完任务 B 后计数器减一，主线程中检测到计数器等于 0 时，表示两个操作已经执行完成。

其实方案二的思想可以直接使用 CountDownLatch。首先创建了一个 CountDownLatch，计数器的初始值等于 2，执行完任务 A 和 B 的两条语句后**对计数器执行减 1（`latch.countDown()`）**。**在主线程中，通过调用 `latch.await()` 来实现对计数器等于 0 的等待。**

```java
// 创建 2 个线程的线程池
Executor executor = Executors.newFixedThreadPool(2);
// 条件
while(flag){
  // 计数器初始化为 2
  CountDownLatch latch = new CountDownLatch(2);
  // 任务 A
  executor.execute(()-> {
    pos = doA();
    // 计数器减一
    latch.countDown();
  });
  // 任务 B
  executor.execute(()-> {
    dos = doB();
    latch.countDown();
  });
  // 等待计数器为 0，即等待两个操作结束
  latch.await();
  
  // 执行任务 C
  result = check(pos, dos);
  // 后续逻辑
}
```

### 用 CyclicBarrier 实现线程同步

若任务 A 处理速度与任务 B 不一样，两个线程步调不一致。同时还需要两个线程结束后再执行任务 C，此时可以利用一个计数器来解决这两个难点，计数器初始化为 2，线程 T1 和 T2 生产完一条数据都将计数器减 1，若计数器大于 0 则线程 T1 或 T2 等待。如果计数器等于 0，则通知线程 T3，并唤醒等待的线程 T1 或者 T2，与此同时，将计数器重置为 2，这样线程 T1 和线程 T2 生产下一条数据的时候就可以继续使用这个计数器了。

JUC 中提供了相关的工具类：CyclicBarrier。首先创建了一个计数器初始值为 2 的 CyclicBarrier，需要注意的是**创建 CyclicBarrier 时，还传入了一个回调函数，当计数器减到 0 时，会调用这个回调函数**。

线程 T1 负责任务 A，执行完后，调用 `barrier.await()` 来将计数器减 1；线程 T2 负责任务 B，执行完后，也调用 `barrier.await()` 来将计数器减 1，同时等待计数器变为 0，当 T1 和 T2 都调用 `barrier.await()`，计数器会减到 0，此时 T1 和 T2 就可以执行下一条语句了，同时会调用 barrier 的回调函数来执行后续操作。**CyclicBarrier 的计数器有自动重置的功能，当减到 0 时，会自动重置为当时设置的初始值**。

```java

// 任务 A 队列
Vector<A> vectorA;
// 任务 B 队列
Vector<B> vectorB;
// 执行回调的线程池 
Executor executor = Executors.newFixedThreadPool(1);
final CyclicBarrier barrier = new CyclicBarrier(2, () -> {
    executor.execute(() -> check());
});

void doAfter(){
  A a = vectorA.remove(0);
  B b = vectorB.remove(0);
  // 执行任务 C
  result = doC(a, b);
  // 后续操作
}
  
void pre(){
  // 循环执行任务 A
  Thread T1 = new Thread(()->{
    while(flag){
      // 查询订单库
      vectorA.add(doA());
      // 等待
      barrier.await();
    }
  });
  T1.start();  
  // 循环执行任务 B
  Thread T2 = new Thread(()->{
    while(flag){
      // 查询运单库
      vectorB.add(doB());
      // 等待
      barrier.await();
    }
  });
  T2.start();
}
```

## 总结

CountDownLatch 和 CyclicBarrier 是 Java 并发包提供的两个非常易用的线程同步工具类，这两个工具类用法的区别为：

+ CountDownLatch **主要用来解决一个线程等待多个线程的场景**；CountDownLatch 的**计数器不能循环利用**，也就是说一旦计数器减到 0，再有线程调用 `await()`，该线程会直接通过。
+ 而 CyclicBarrier 是**一组线程之间互相等待**；CyclicBarrier 的**计数器可以循环利**，而且**具备自动重置的功能**，一旦计数器减到 0 会自动重置到当时设置的初始值。

## 参考资料

《Java 并发编程实战》