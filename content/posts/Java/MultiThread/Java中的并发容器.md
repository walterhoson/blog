---
title: Java 中的并发容器
description: 简要分析 Java 中的并发容器的种类及使用
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
date: '2020-05-02T15:51:+08:00'
lastmod: '2020-05-02T15:52:20+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中的并发容器的种类及使用

<!--more-->

Collections 中包装后线程安全容器，都是基于 synchronized 这个同步关键字实现的，所以也被称为同步容器。比如 SynchronizedList、SynchronizedMap 等。

Java 中同步容器还有 Vector、Stack 和 Hashtable，这三个容器不是基于包装类实现的，但同样是基于 synchronized。对于这些容器的遍历，要加锁保证互斥。

比如在用迭代器遍历容器时，就可能存在并发问题，`hasNext()` 和 `next()` 属于组合操作，正确做法是锁住容器后再执行遍历操作。

Collections 内部包装类中的公共方法用 sychronized 锁住的是对象的 this。

## 并发容器及其注意事项

Java1.5 版本之前所谓的线程安全的容器，主要指的就是同步容器。不过**同步容器最大的问题就是性能差**，所有方法都用 synchronized 来保证互斥，串行度太高。

因此 Java 在 1.5 及之后版本提供了性能更高的容器，一般称为并发容器。主要包括四大类：List、Map、Set 和 Queue。

![img](../../../assets/Java中的并发容器/a20efe788caf4f07a4ad027639c80b1d.png)

并发容器的操作中，需要注意的是，组合操作需要注意竞态条件。组合操作往往隐藏着竞态条件问题，即便每个操作都能保证原子性，也并不能保证组合操作的原子性。

## List

List 里只有一个实现类就是 CopyOnWriteArrayList。顾名思义就是**写的时候会将共享变量新复制一份出来**，这样做的好处是**读操作完全无锁**。

**实现原理**

CopyOnWriteArrayList 内部维护了一个数组，成员变量 array 就指向这个内部数组，所有的读操作都是基于 array 进行，迭代器 Iterator 遍历的就是 array 数组。

若在遍历 array 的同时，还有一个写操作，例如增加元素，CopyOnWriteArrayList 会将 array 复制一份，然后在新复制处理的数组上执行增加元素的操作，执行完之后再将 array 指向这个新的数组。

读写是可以并行的，遍历操作一直都是基于原 array 执行，而写操作则是基于新 array 进行。

使用 CopyOnWriteArrayList 注意点：

+ CopyOnWriteArrayList **仅适用于写操作非常少的场景**，而且**能够容忍读写的短暂不一致**。写入的新元素并不能立刻被遍历到。
+ CopyOnWriteArrayList **迭代器是只读的，不支持增删改**。因为迭代器遍历的仅仅是一个快照，而对快照进行增删改没有意义。

## Map

Map 接口的两个实现是 ConcurrentHashMap 和 ConcurrentSkipListMap。

从应用的角度来看，主要区别在于 **ConcurrentHashMap 的 key 是无序的**，而 **ConcurrentSkipListMap 的 key 是有序的**。使用这两个 Map 需要注意的地方是，它们的 key 和 value 都不能为空，否则会抛出 NPE 异常。

ConcurrentSkipListMap 内部是 SkipList（跳表）的数据结构。跳表插入、删除、查询操作平均的时间复杂度是 O(logn)，理论上和并发线程数没有关系，所以在并发度非常高的情况下，比 ConcurrentHashMap 的性能高。

## Set

Set 接口的两个实现是 CopyOnWriteArraySet 和 ConcurrentSkipListSet，原理与 CopyOnWriteArrayList 和 ConcurrentSkipListMap 一致。

## Queue

JUC 中的 Queue，可以从两个维度来分类。

+ 一个维度是**阻塞与非阻塞**，所谓阻塞指的是当队列已满时，入队操作阻塞；当队列已空时，出队操作阻塞。JUC 中阻塞队列都用 Blocking 关键字标识。
  
+ 另一个维度是**单端与双端**，单端指的是只能队尾入队，队首出队；而双端指的是队首队尾皆可入队出队。JUC 中单端队列使用 Queue 标识，双端队列使用 Deque 标识。

这两个维度组合后，可将 Queue 细分为四大类，分别是：

1. 单端阻塞队列：其实现有 ArrayBlockingQueue、LinkedBlockingQueue、SynchronousQueue、LinkedTransferQueue、PriorityBlockingQueue 和 DelayQueue。这些实现里，内部一般会持有一个队列，这个队列可以是数组（ArrayBlockingQueue）也可以是链表（Linke dBlockingQueue）；甚至还可以不持有队列（SynchronousQueue），此时生产者线程的入队操作必须等待消费者线程的出队操作。而 LinkedTransferQueue 融合 LinkedBlockingQueue 和 SynchronousQueue 的功能，性能比 LinkedBlockingQueue 更好；PriorityBlockingQueue 支持按照优先级出队；DelayQueue 支持延时出队。

2. 双端阻塞队列：其实现是 LinkedBlockingDeque。

3. 单端非阻塞队列：其实现是 ConcurrentLinkedQueue。

4. 双端非阻塞队列：其实现是 ConcurrentLinkedDeque。

使用队列时，需要格外注意队列是否支持有界（所谓有界指的是内部的队列是否有容量限制）。

实际工作中，一般都不建议使用无界的队列，因为如果控制不好，数据量大了之后很容易导致 OOM。

上面的这些 Queue 中，只有 ArrayBlockingQueue 和 LinkedBlockingQueue 是支持有界的，所以在使用其他无界队列时，一定要充分考虑是否存在导致 OOM 的隐患。

## 参考资料

《Java 并发编程实战》