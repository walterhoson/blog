---
title: Java 中的原子类
description: 简要分析 Java 中的原子类，及解决的相关问题
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
date: '2020-05-02T16:20:+08:00'
lastmod: '2020-05-02T16:25:20+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中的原子类，及解决的相关问题

<!--more-->

## 无锁方案解决的问题

累加器的线程安全问题，出在变量 count 的可见性和 `count += 1` 的原子性上，可见性问题可以用 volatile 来解决，而原子性问题可以采用的互斥锁方案。

除去这种方案外，JUC 提供了无锁方案的原子类。

```java

public class Test {
  AtomicLong count = new AtomicLong(0);
  void add10K() {
    int idx = 0;
    while(idx++ < 10000) {
      count.getAndIncrement();
    }
  }
}
```

无锁方案相对互斥锁方案，**最大的好处就是性能**。互斥锁方案为了保证互斥性，需要执行加锁、解锁操作，而加锁、解锁操作本身就消耗性能；

同时拿不到锁的线程还会进入阻塞状态，进而触发线程切换，**线程切换对性能的消耗也很大**。 

相比之下，无锁方案则完全没有加锁、解锁的性能消耗，同时还能保证互斥性，既解决了问题，又没有带来新的问题。

## 无锁方案的实现原理

原子类的高性能是因为硬件的支持，CPU 为了解决并发问题，提供了 CAS 指令（Compare And Swap，比较并交换）。

CAS 指令包含 3 个参数：共享变量的内存地址 A、用于比较的值 B 和共享变量的新值 C；只有当内存中地址 A 处的值等于 B 时，才能将内存中地址 A 处的值更新为新值 C。作为一条 CPU 指令，CAS 指令本身是能够保证原子性的。一般都会伴随着自旋（循环尝试）。

比如原子类在 JDK8 中，`getAndIncrement()` 方法会转调 `unsafe.getAndAddLong(this, valueOffset, 1L)`。这里 this 和 valueOffset 两个参数可以唯一确定共享变量的内存地址。该方法首先会在内存中读取共享变量的值，之后循环调用 `compareAndSwapLong()` 方法来尝试设置共享变量的值，直到成功为止。

`compareAndSwapLong()` 是一个 native 方法，只有当内存中共享变量的值等于 expected 时，才会将共享变量的值更新为 x，并返回 true；否则返回 fasle。compareAndSwapLong 的语义和 CAS 指令的语义的差别仅仅是返回值不同而已。

### ABA 问题

在 CAS 自旋过程中，可能存在被其他线程改掉后又被另一个线程改了回来，导致当前线程任务符合预期值，这就是 ABA 问题。

但其实在大多数情况下，我们并不关心 ABA 问题，比如数值的原子递增，但也不可任何情况都不关心，比如原子化更新对象可能就需要关心 ABA 问题，因为两个 A 虽然相等，但是第二个 A 的属性可能已经发生变化了。所以在使用 CAS 方案时，一定要先 check 一下。

## 原子类概览

Java SDK 并发包里提供的原子类可以分为五个类别：

+ 原子化的基本数据类型
+ 原子化的对象引用类型
+ 原子化数组
+ 原子化对象属性更新器
+ 原子化的累加器

![img](../../../assets/Java中的原子类/007a32583fbf519469462fe61805eb4a.png)

### 原子化的基本数据类型

相关实现有 AtomicBoolean、AtomicInteger 和 AtomicLong，提供的方法有

```java
getAndIncrement() // 原子化 i++
getAndDecrement() // 原子化的 i--
incrementAndGet() // 原子化的++i
decrementAndGet() // 原子化的--i
getAndAdd(delta) // 当前值+=delta，返回+=前的值
addAndGet(delta) // 当前值+=delta，返回+=后的值
compareAndSet(expect, update) // CAS 操作，返回是否成功
// 以下四个方法。新值可以通过传入 func 函数来计算
getAndUpdate(func)
updateAndGet(func)
getAndAccumulate(x,func)
accumulateAndGet(x,func)
```

### 原子化的对象引用类

相关实现有 AtomicReference、AtomicStampedReference 和 AtomicMarkableReference，利用它们可以实现对象引用的原子化更新。

AtomicReference 提供的方法和原子化的基本数据类型差不多。需要注意的是，对象引用的更新需要重点关注 ABA 问题，AtomicStampedReference 和 AtomicMarkableReference 这两个原子类可以解决 ABA 问题。

解决 ABA 问题的思路其实很简单，增加一个版本号维度就可以了，和乐观锁机制很类似，每次执行 CAS 操作，附加再更新一个版本号，只要保证版本号是递增的，那么即便 A 变成 B 之后再变回 A，版本号也不会变回来。AtomicStampedReference 实现的 CAS 方法就增加了版本号参数，方法签名如下：

```java
boolean compareAndSet(V expectedReference, V newReference, int expectedStamp, int newStamp) 
```

AtomicMarkableReference 的实现机制则更简单，将版本号简化成了一个 Boolean 值，方法签名如下：

```java
boolean compareAndSet(V expectedReference, V newReference, boolean expectedMark, boolean newMark)
```

### 原子化数组

相关实现有 AtomicIntegerArray、AtomicLongArray、AtomicReferenceArray。

利用这些原子类，可以原子化地更新数组里面的每一个元素。这些类提供的方法和原子化的基本数据类型的区别仅仅是：每个方法多了一个数组的索引参数。

### 原子化对象属性更新器

相关实现有 AtomicIntegerFieldUpdater、AtomicLongFieldUpdater 和 AtomicReferenceFieldUpdater。

利用它们可以原子化地更新对象的属性，这三个方法都是利用反射机制实现的，创建更新器的方法如下：

```java
public static <U> AtomicXXXFieldUpdater<U> newUpdater(Class<U> tclass, String fieldName)
```

需要注意的是，对象属性必须是 volatile 类型的，只有这样才能保证可见性；如果对象属性不是 volatile 类型的，`newUpdater()` 方法会抛出 IllegalArgumentException 异常。

`newUpdater()` 的方法参数只有类的信息，没有对象的引用，而更新对象的属性，一定需要对象的引用，这个参数是在原子操作的方法参数中传入的。

例如 `compareAndSet()` 这个原子操作，相比原子化的基本数据类型多了一个对象引用 obj。原子化对象属性更新器相关的方法，相比原子化的基本数据类型仅仅是多了对象引用参数。方法为：`boolean compareAndSet(T obj, int expect, int update)`

### 原子化的累加器

DoubleAccumulator、DoubleAdder、LongAccumulator 和 LongAdder，这四个类仅仅用来执行累加操作，相比原子化的基本数据类型，速度更快，但是不支持 `compareAndSet()` 方法。若仅仅需要累加操作，使用原子化的累加器性能会更好。

## 总结

无锁方案相对于互斥锁方案，优点很多，首先性能好，其次是基本不会出现死锁问题（但可能出现饥饿和活锁问题，因为自旋会反复重试）。Java 提供的原子类大部分都实现了 `compareAndSet()` 方法。

Java 提供的原子类能够解决一些简单的原子性问题，但所有原子类的方法都是针对一个共享变量的，如果需要解决多个变量的原子性问题，建议还是使用互斥锁方案。

原子类虽好，但使用要慎之又慎。

## 参考资料

《Java 并发编程实战》