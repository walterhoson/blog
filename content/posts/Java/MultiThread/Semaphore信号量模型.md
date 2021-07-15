---
title: Semaphore 信号量模型
description: 简单分析 Java 中的 Semaphore 信号量模型的概念及使用
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
date: '2020-05-02T12:32:+08:00'
lastmod: '2020-05-02T12:32:20+08:00'
featuredImage: ''
draft: false
---

</br>

简单分析 Java 中的 Semaphore 信号量模型的概念及使用

<!--more-->

## 信号量模型

简单概括为：**一个计数器，一个等待队列，三个方法**。

在信号量模型里，计数器和等待队列对外是透明的，所以只能通过信号量模型提供的三个方法来访问它们，这三个方法分别是：`init()`、`down()` 和 `up()`。这三个方法都是原子性的，并且这个原子性是由信号量模型的实现方保证的。

JDK 中，信号量模型由 `java.util.concurrent.Semaphore` 实现的，Semaphore 类能够保证这三个方法都是原子操作。

+ `init()`：设置计数器的初始值。
+ `down()`：计数器的值减 1；若此时计数器的值小于 0，则当前线程将被阻塞，否则当前线程可以继续执行。JDK 中叫 `acquire()`。
+ `up()`：计数器的值加 1；若此时计数器的值小于或等于 0，则唤醒等待队列中的一个线程，并将其从等待队列中移除。JDK 中叫 `release()`。

## 如何使用信号量

就像使用互斥锁一样，只需要在进入临界区之前执行一下 `down()` 操作，退出临界区之前执行一下 `up()` 操作。

实现一个互斥锁仅仅是 Semaphore 的部分功能，它还有一个功能是 Lock 不容易实现的，**Semaphore 可以允许多个线程访问一个临界区**。

但信号量**不能做的是同时唤醒多个线程去争抢锁，只能唤醒一个阻塞中的线程**。

而且信号量模型没有 Condition 概念，即**阻塞线程被唤醒就直接运行了，而不会去检查此时临界条件是否仍满足**。

## 参考资料

《Java 并发编程实战》