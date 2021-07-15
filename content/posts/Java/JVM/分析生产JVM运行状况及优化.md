---
title: 分析生产 JVM 运行状况及优化
description: 分析系统生产环境中 JVM 运行状况，并进行优化。要点为：合理的内存分配、垃圾收集器的选择、垃圾收集器常见的参数设置、代码层面内存泄露检查。
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

分析系统生产环境中 JVM 运行状况，并进行优化。

要点为：**合理的内存分配**、**垃圾收集器的选择**、**垃圾收集器常见的参数设置**、**代码层面内存泄露检查**。

<!--more-->

## 内存分配

| 参数名           | 含义                                                         |
| ---------------- | ------------------------------------------------------------ |
| -Xms             | Java 堆内存的大小                                             |
| -Xmx             | Java 堆内存的最大大小                                         |
| -Xmn             | Java 堆内存中的新生代大小，扣除新生代剩下的就是老年代的内存大小了 |
| -XX:PermSize:    | 永久代大小，JDK8 后，被替换为了-XX:MetaspaceSize           |
| -XX:MaxPermSize: | 永久代最大大小，JDK8 后，被替换为了-XX:MaxMetaspaceSize    |
| -Xss:            | 每个线程的栈内存大小                                         |
 

## 对系统进行预估性优化

首先根据业务系统分析以下几点

1. 估算系统每秒请求数量
2. 每个请求会创建对象数量，占用内存数量
3. 选用机器配置的情况
4. 年轻代应该分配的内存大小
5. YGC 触发频率
6. 对象进入老年代的速率
7. 老年代应该分配的内存大小
8. FGC 触发频率

## 优化 JVM 参数设置

根据预估结果进行优化，并合理设置一些 JVM 参数

比如堆内存大小，年轻代大小，Eden 和 Survivor 的比例，老年代大小，大对象的阈值，大龄对象进入老年代的阈值，等等。

**JVM 参数优化要点**

尽量让每次 YGC 后的存活对象小于 Survivor 区域的 50%。让对象尽量都留在年轻代里，尽量别让对象进入老年代。尽量减少 FGC 的频率，避免频繁 FGC 对 JVM 性能的影响。

`-XX:InitialHeapSize` 和 `-XX:MaxHeapSize` 就是初始堆大小和最大堆大小，单位 byte

`-XX:NewSize`和`-XX:MaxNewSize`是初始新生代大小和最大新生代大小，单位 byte

`-XX:PretenureSizeThreshold=10485760`指定了大对象阈值，单位 byte

`-XX:GCTimeRatio`，设置吞吐量，设置一个 0-100 的值，表示垃圾收集时间占总时间比例，相当于吞吐量的倒数

`-XX:+CMSParallellnitialMarkEnabled`，表示在初始标记的多线程执行，减少 STW

`-XX:+CMSScavengeBeforeRemark`：在重新标记之前执行 YGC，以减少扫描一些对象，从而减少重新标记时间。

`-XX:+CMSParallelRemarkEnabled`：在重新标记的时候多线程执行，降低 STW

`-XX: CMSInitiatingOoccupancyFraction=92` 和 `-XX:+UseCMSInitiatingOccupancyOnly` 配套使用，如果不设置后者，JVM 第一次会采用 92% 但是后续 JVM 会根据运行时采集的数据来进行 GC 周期，如果设置后者则 JVM 每次都会在 92%的时候进行 GC。

**打印 JVM GC 日志**

`-XX:+PrintGCDetils`：打印详细的 GC 日志

`-XX:+PrintGCTimeStamps`：这个参数可以打印出来每次 GC 发生的时间 

`-Xloggc:gc.log`：将 GC 日志写入一个磁盘文件

`-XX:+PrintHeapAtGC`：在每次 GC 前都要 GC 堆的概况输出

`-XX:+HeapDumpOnOutOfMemoryError`：这个参数会在系统内存溢出的时候导出一份内存快照到指定的位置

JDK8 中参数配置示例：

```shell
-Xms4096M-Xmx4096M-Xmn3072M-Xss1M -xX:MetaspaceSize=256M-XX:MaxMetaspaceSize=256M- XX:+UseParNewGC-XX:+UseConcMarkSweepGC-XX:CMSInitiatinaOccupancyFaction=92-XX:+UseCMSCompactAtFullCollection-XX:CMSFullGCsBeforeCompaction-0-XX:+CMSParallellnitialMarkEnabled -XX:+CMSScavengeBeforeRemark-xx:DisableExplicitGC-xx: +PrintGCDetails-Xloqgc:gc.log-XX:+HeapDumpOnOutOfMemoryError -XXHeapDumpPath=/usr/local/app/oom
```

## 系统压测时的 JVM 优化

新系统上线前必要走的流程

1. 单元测试
2. 系统集成测试
3. 测试环境功能测试
4. 预发布环境压力测试

采用 jstat 分析模拟真实环境的压力，JVM 的整体运行状态。

主要分析几个关键运行指标：

+ 新生代对象的增长的速率
+ YGC 的触发频率
+ YGC 的耗时
+ 每次 YGC 后对象存活数量
+ 每次 YGC 过后对象进入老年代数量
+ 老年代对象增长的速率
+ FGC 的触发频率
+ FGC 的耗时

## 对线上系统进行 JVM 监控

1. 高峰期和低峰期，使用 jstat、jmap、jhat 查看线上系统 JVM 运行情况
2. 部署监控系统，比较常见的有：Zabbix、OpenFalcon、Ganglia、Prometheus 等，并提供短信、邮箱等报警功能

## 总结

对线上运行的系统，可以通过命令行工具手动监控，发现问题并优化，或可以依托监控系统进行自动监控，可视化查看日常系统的运行状态。
