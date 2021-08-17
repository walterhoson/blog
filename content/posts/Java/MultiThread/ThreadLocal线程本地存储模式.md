---
title: ThreadLocal 线程本地存储模式
description: 简要分析 ThreadLocal 线程本地存储模式的原理，及相关使用。
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
date: '2020-05-02T22:20:+08:00'
lastmod: '2020-05-02T22:20:11+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 ThreadLocal 线程本地存储模式的原理，及相关使用。

<!--more-->

## 线程本地存储模式

解决并发问题的一个重要方法：**避免共享**。

多个线程同时读写同一共享变量存在并发问题，除了写操作，若没有共享变量也不会有并发问题。**若每个线程都拥有自己的变量，彼此间不共享，也就没有并发问题**。

所谓**线程封闭**，其本质就是**避免共享**。通过局部变量可以做到避免共享。其次通过 Java 语言提供的线程本地存储（ThreadLocal）同样也可以做到。

## ThreadLocal

### 工作原理

Thread 类中维护 ThreadLocalMap。ThreadLocal 仅仅是一个代理工具类，内部并不持有任何与线程相关的数据，所有和线程相关的数据都存储在 Thread 里面。

这样的设计容易理解，而从数据的亲缘性上来讲，ThreadLocalMap 属于 Thread 也更加合理。更加深层次的原因是**不容易产生内存泄露**。

### 内存泄漏

若 ThreadLocal 持有 Map，那 Map 中就会持有 Thread 对象的引用，也就意味着只要 ThreadLocal 对象存在，那么 Map 中的 Thread 对象就永远不会被回收。而 ThreadLocal 的生命周期往往都比线程要长，所以设计该方案很容易导致内存泄露。

而 Java 的实现中 Thread 持有 ThreadLocalMap，而且 ThreadLocalMap 里对 ThreadLocal 的引用还是弱引用（WeakReference），所以只要 Thread 对象可以被回收，那么 ThreadLocalMap 就能被回收。该实现方案虽然看上去复杂一些，但更加安全。

但 Java 中的实现也并非百分百不会内存泄漏，比如在线程池中使用 ThreadLocal，不谨慎可能会导致内存泄漏。原因就出**在线程池中线程的存活时间太长**，往往都是和程序同生共死的，这就意味着 Thread 持有的 ThreadLocalMap 一直都不会被回收，再加上 ThreadLocalMap 中的 Entry 对 ThreadLocal 是弱引用（WeakReference），所以只要 ThreadLocal 结束了自己的生命周期是可以被回收掉的。但 Entry 中的 Value 却是被 Entry 强引用的，所以即便 Value 的生命周期结束了，Value 也是无法被回收的，从而导致内存泄露。

### 线程池中使用 ThreadLocal

既然 JVM 不能做到自动释放对 Value 的强引用，那只需要手动释放，可以使用 **try{}finally{}方案**。

```java
ExecutorService es;
ThreadLocal tl;
es.execute(()->{
  //ThreadLocal 增加变量
  tl.set(obj);
  try {
    // 省略业务逻辑代码
  }finally {
    //手动清理 ThreadLocal 
    tl.remove();
  }
});
```

### InheritableThreadLocal 与继承性

通过 ThreadLocal 创建的线程变量，其子线程是无法继承的，在线程中通过 ThreadLocal 创建了线程变量 V，而后该线程创建了子线程，在子线程中是无法通过 ThreadLocal 来访问父线程的线程变量 V 的。

若需要在子线程继承父线程的线程变量，Java 提供了 InheritableThreadLocal 来支持这个特性，InheritableThreadLocal 是 ThreadLocal 子类，用法与 ThreadLocal 相同。

不过不建议在线程池中使用 InheritableThreadLocal，因为他也可能导致内存泄漏，除此之外的更重要的原因是，线程池中线程的创建是动态的，很容易导致继承关系错乱，若业务逻辑依赖 InheritableThreadLocal，那么很可能导致业务逻辑计算错误，而这个错误往往比内存泄露更要命。

## 总结

若需要在并发场景中使用一个线程不安全的工具类，最简单的方案就是避免共享。避免共享有两种方案，一种方案是将这个工具类作为局部变量使用，另外一种方案就是线程本地存储模式。

局部变量方案的缺点是在高并发场景下会频繁创建对象，而线程本地存储方案，每个线程只需要创建一个工具类的实例，所以不存在频繁创建对象的问题。

Java 中的 ThreadLocal 可能导致内存泄漏，使用时需要谨慎。

## 参考资料

《Java 并发编程实战》