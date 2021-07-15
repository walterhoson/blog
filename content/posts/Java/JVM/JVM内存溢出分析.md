---
title: JVM 内存溢出分析
description: 分析系统发生内存溢出的各种原因，及相关场景
toc: true
authors: 
    - WayneShen
tags: 
    - Java
    - JVM
categories: 
    - Java
series: []
date: '2020-04-21T21:21:+08:00'
lastmod: '2020-04-21T21:22:00+08:00'
draft: false
---

</br>

分析系统发生内存溢出的各种原因，及相关场景

<!--more-->

## Metaspace 区域溢出

Metaspace 区域大小设置，`-XX:MetaspaceSize=512m`、`-XX:MaxMetaspaceSize=512m`。

FGC 触发时会尝试回收 Meatspace 区域中的类。当然一旦 Metaspace 满了，此时也会触发 FGC。

类被回收的条件有很多，比如这个类的类加载器先要被回收、这个类的所有对象实例都要被回收，等等。

### 场景

Metaspace 内存溢出很少发生，主要原因有

1. 系统上线前使用的默认参数，没有设置 Metaspace 大小。
2. 代码中使用 cglib 之类的动态生成类，如果代码中没有控制好，就容易把 Metaspace 塞满。

## 栈内存溢出

一般设置每个线程的虚拟机栈的内存大小为 1MB。每次方法调用的栈帧都是要占用内存的。栈帧中包括方法的局部变量等。

如果不停的让线程调用方法，不停的往栈里放入栈帧，最终大量的栈帧会消耗完这 1MB 的线程栈内存。通常而言哪怕虚拟机栈内存只有 128kb 或 256kb，通常也是足够一定深度的方法调用的。

一般情况 4C8G 的机器，占据的线程量应该在几百个比较合理，占用几百兆，若线程数太多，4 核的 CPU 负载也会过高。

### 场景

方法循环调用，就会导致 `java.lang.StackOverflowError`

## 堆内存溢出

高并发场景下，YGC 后很多请求还没有处理完，存活对象太多，可能 Survivor 区域放不下，此时只能进到老年代，老年代很快会被放满，触发 FGC，过后有一批存活对象跳过 Survivior 直接进入老年代，如果此时老年代也满了，就会发生堆内存溢出了。`java.lang.OutOfMemoryError:Java heap space`。

通过设置 JVM 参数 `-XX:+HeapDumpOnOutOfMemoryError`，就会在系统内存溢出时导出一份内存快照到指定的位置，里面线程内存里的情况。通过类似 MAT 这样的工具分析。

大体思路就是，找到当时占用内存最大的对象，找出这些对象在哪些代码中被创建，然后修改代码，进行调优。

### 诱因

+ 创建的对象过多，并且都为存活的，没有及时取消引用，导致 GC 无法回收。

+ 负载过高

## 堆外内存溢出

堆外内存，Direct Buffer memory，字面意思直接内存，不受 JVM 管理，直接被操作系统管理。

Java 代码中申请堆外内存空间，使用 DirectByteBuffer 类，构建该对象，该对象本身在堆内存，但在构建这个对象同时，会在堆外内存中划出一块内存空间与该对象关联。当 DirectByteBuffer 对象没有人引用，成为垃圾对象后，通过 YGC/FGC 回收该对象，同时释放关联的那块堆外内存。

### 诱因

如果创建大量 DirectByteBuffer 对象占用大量堆外内存，堆内的 DirectByteBuffer 没有回收掉，那堆外内存也无法释放。在高并发下，有一些 DirectByteBuffer 对象进入了老年代，而老年代迟迟没有满，没有触发 FGC，导致无法释放他们。

### 示例

NIO 源码中，每次分配新的堆外内存时，都会调用 `System.gc()` 提醒 JVM 主动执行一下 GC，处理一下没有人引用的 DirectByteBuffer，释放堆外内存空间。

注意若设置了 `-XX:+DisableExplicitGC` 会导致 `System.gc()` 不生效。
