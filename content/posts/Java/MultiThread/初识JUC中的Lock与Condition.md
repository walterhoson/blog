---
title: 初识JUC中的Lock与Condition
description: 初步了解JUC中的Lock与Condition解决的问题以及与管程的对比
toc: true
authors: 
    - WayneShen
tags: 
    - Java
    - Notes
    - Concurrent
    - JUC
categories: 
    - Java
series: []
date: '2020-05-02T11:30:+08:00'
lastmod: '2020-05-02T11:30:20+08:00'
featuredImage: ''
draft: false
---

</br>
初步了解JUC中的Lock与Condition解决的问题以及与管程的对比。简单解析Lock与Condition的实现原理

<!--more-->

## 藏在并发包中的管程

并发编程领域，有两大核心问题

+ 互斥，即同一时刻只允许一个线程访问共享资源
+ 同步，即线程之间如何通信、协作。

这两大问题，管程都能解决。

JUC中通过Lock和Condition两个接口来实现管程，其中**Lock用于解决互斥问题，Condition解决同步问题**。

### 保证可见性

Java中多线程的可见性是通过 `Happens-Before` 规则保证的，

synchronized 能够保证可见性是因为它有一条规则：synchronized 的解锁 Happens-Before 于后续对该锁的加锁。

而 Lock 实现可见性，利用了 volatile 相关的 `Happens-Before` 规则。

ReentrantLock 内部有个 volatile 修饰的成员变量 `state`，获取锁时会读写 `state` 值；锁的时候，也会读写 `state` 值。

```java
class X{
  private final Lock rtl = new ReentrantLock(); 
  int value;
  public void addOne() {
    // 获取锁 
    rtl.lock(); 
    try {
      value += 1; 
    } finally {
      // 保证锁能释放
      rtl.unlock(); 
    }
  } 
}
```

根据相关的Happens-Before规则：

1. 顺序性规则：对于线程T1，`value+=1` Happens-Before释放锁的操作 `unlock()`;

2. volatile变量规则：由于 `state=1` 会先读取state，所以线程T1的 `unlock()` 操作 Happens-Before 线程T2的 `lock()` 操作;

3. 传递性规则：线程T1的 `value+=1` Happens-Before 线程T2的 `lock()` 操作。

### 可重入锁

ReentrantLock翻译为可重入锁，指**线程可以重复获取同一把锁**。

可重入函数，指的是**多个线程可以同时调用该函数**，每个线程都能得到正确结果；同时在一个线程内支持线程切换，无论被切换多少次，结果都是正确的。多线程可同时执行，还支持线程切换，这意味线程安全。

### 公平锁和非公平锁

ReentrantLock 类有两个构造函数，一个无参（默认非公平），一个有参，入参 fair 表示锁的公平策略，`true` 为公平锁。

锁对应着一个等待队列，若一个线程没有获得锁，就会进入等待队列，当有线程释放锁时，就需要从等待队列中唤醒一个等待的线程。

+ 公平锁，唤醒的策略就是唤醒等待时间最长的线程，较公平；

+ 非公平锁，则不提供这个公平保证，队列中的线程都有机会被唤醒，可能等待时间短的线程反而先被唤醒。

## 用锁的最佳实践

并发大师Doug Lea《Java并发编程：设计原则与模式》 中推荐的三个用锁的最佳实践。

> 1. 永远只在更新对象的成员变量时加锁
> 2. 永远只在访问可变的成员变量时加锁
> 3. 永远不在调用其他对象的方法时加锁

最后一条尽管有些苛刻，但还是要尽量遵守。因为调用其他对象的方法，实在是太不安全了，也许“其他”方法里面有线程sleep()的调用，也可能会有奇慢无比的I/O操作，这些都会严重影响性能。更可怕的是，“其他”类的方法可能也会加锁，然后双重加锁就可能导致死锁。

## 管程实现异步转同步

一个阻塞队列，需要两个条件变量，一个是队列不空（空队列不允许出队），另一个是队列不满（队列已满不允许入队）。

Lock和Condition实现的管程，线程等待和通知需要调用`await()`、`signal()`、`signalAll()`，它们的语义和 `wait()`、`notify()`、`notifyAll()`相同。

但不一样的是，Lock和Condition实现的管程里只能使用前者，而后者只有在 synchronized 实现的管程里才能使用。

若在Lock&Condition实现的管程里调用了后者，会导致程序崩溃。

## 与synchronized区别

JDK1.5之前synchronized性能较差，JDK1.6之后，对其做了优化，提升了性能。

synchronized没有解决**破坏不可抢占条件问题**，原因是synchronized申请资源时，若申请不到，线程直接进入了阻塞状态，此时也释放不了线程已占有的资源。

Lock解决了这个问题，它能够响应中断、支持超时、非阻塞地释放锁。

```java
//支持中断
void lockInterruptibly() throws InterruptedException;
// 支持超时
boolean tryLock(long time, TimeUnit unit) throws InterruptedException;
// 支持非阻塞获取锁
boolean tryLock();
```


## 参考资料

《Java并发编程实战》
《Java并发编程：设计原则与模式》