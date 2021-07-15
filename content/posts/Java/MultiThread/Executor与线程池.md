---
title: Executor 与线程池
description: 简要分析 Java 中线程池的实现逻辑、使用要点及可能遇到问题。并扩展描述了动态更新配置的使用方式。
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
date: '2020-05-02T17:30:+08:00'
lastmod: '2020-05-02T17:35:20+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中线程池的实现逻辑、使用要点及可能遇到问题。并扩展描述了动态更新配置的使用方式

<!--more-->

## 引入线程池

创建线程对象 `new Thread()` 仅仅是在 JVM 的堆里分配一块内存，而创建一个线程，需要调用操作系统内核的 api，然后 OS 要为线程分配一系列资源，这个成本很高，所以线程是一个重量级的对象，应该**避免频繁创建和销毁**。

此时就引入了线程池，线程池和一般意义上的池化资源不同。一般意义上的池化资源，都是当需要资源的时候就调用 `acquire()` 方法来申请资源，用完后调用 `release()` 释放资源。而 Java 提供的线程池里没有申请线程和释放线程的方法。

**线程池是一种生产者-消费者模式**。线程池的使用方是生产者，线程池本身是消费者。

线程池的优势：

+ **重用存在的线程**，减少对象创建、消亡的开销，性能比较好

+ **可有效控制最大并发线程数**，提高系统资源利用率，同时可以避免过多的资源竞争，避免阻塞

+ **提供定时执行、定期执行、单线程、并发数控制等功能**。

```java
// 简化的线程池，仅用来说明工作原理
class MyThreadPool {
  // 利用阻塞队列实现生产者-消费者模式
  BlockingQueue<Runnable> workQueue;
  // 保存内部工作线程
  List<WorkerThread> threads = new ArrayList<>();
  // 构造方法
  MyThreadPool(int poolSize, BlockingQueue<Runnable> workQueue){
    this.workQueue = workQueue;
    // 创建工作线程
    for(int idx=0; idx<poolSize; idx++){
      WorkerThread work = new WorkerThread();
      work.start();
      threads.add(work);
    }
  }
  // 提交任务
  void execute(Runnable command){
    workQueue.put(command);
  }
  // 工作线程负责消费任务，并执行任务
  class WorkerThread extends Thread {
    public void run() {
      // 循环取任务并执行
      while(true){
        Runnable task = workQueue.take();
        task.run();
      } 
    }
  }  
}
/** 下面是使用示例 **/
// 创建有界阻塞队列
BlockingQueue<Runnable> workQueue = new LinkedBlockingQueue<>(2);
// 创建线程池  
MyThreadPool pool = new MyThreadPool(10, workQueue);
// 提交任务  
pool.execute(()->{
    System.out.println("hello");
});
```

### 线程池主要的工作原理

在 MyThreadPool 内部，维护了一个阻塞队列 workQueue 和一组工作线程，工作线程的个数由构造函数中的 poolSize 指定。

用户通过调用 `execute()` 方法来提交 Runnable 任务，`execute()` 方法的内部实现仅仅是将任务加入到 workQueue 中。

MyThreadPool 内部维护的工作线程会消费 workQueue 中的任务并执行任务，相关的代码在 while 循环中。

## Java 中的线程池

Java 并发包里提供的线程池工具类中，最核心的是 ThreadPoolExecutor，强调的是 Executor，而不是一般意义上的池化资源。ThreadPoolExecutor 的构造函数有 7 个参数。

```java
ThreadPoolExecutor(int corePoolSize, int maximumPoolSize, long keepAliveTime, TimeUnit unit, 
  BlockingQueue<Runnable> workQueue, ThreadFactory threadFactory, RejectedExecutionHandler handler) 
```

+ corePoolSize：线程池保有的最小线程数。
+ maximumPoolSize：线程池创建的最大线程数。空闲后撤回到 corePoolSize。
+ keepAliveTime & unit：若一个线程空闲了 keepAliveTime & unit，且线程池的线程数大于 corePoolSize ，那么该空闲的线程就要被回收了。
+ workQueue：工作队列。
+ threadFactory：自定义如何创建线程。默认创建的线程会有相同的优先级，并且为非守护线程。
+ handler：自定义任务的拒绝策略。ThreadPoolExecutor 已经提供了以下 4 种策略：
  + CallerRunsPolicy：提交任务的线程自己去执行该任务。
  + AbortPolicy：默认的拒绝策略，会抛出 RejectedExecutionException。
  + DiscardPolicy：直接丢弃任务，不抛出任何异常。
  + DiscardOldestPolicy：丢弃最老的任务，就是把最早进入工作队列的任务丢弃，然后把新任务加入到工作队列。

### 任务执行流程

![img](../../../assets/Executor与线程池/17171b849819affe.png)

**核心 > 队列 > 最大 > 拒绝**

其核心就是，当任务来临时，首先比较线程池中活动线程与核心线程数，若活动线程数小于核心线程数则创建新的核心线程，否则判断队列是否已满，未满则将任务放入队列中等待执行，若满了则判断当前活动线程数是否小于最大线程数，小于则继续创建线程到最大线程数，否则进行拒绝策略。

### 线程池状态

+ RUNNING：运行状态。
+ SHUTDOWN：调用 `shotdown()` 方法进入该状态，无法处理新提交的任务，但继续可以处理阻塞队列中的任务。
+ STOP：调用 `shotdownNow()` 方法进入该状态，不处理新提交的任务，也无法处理队列中的任务；中断正在处理任务的线程。
+ TIDYING：若所有的任务已经终止，有效工作线程为 0，进入该状态。
+ TERMINATED：TIDYING 状态下调用 `terminated()` 方法进入该状态。

### 核心方法

```java
// 提交任务，交给线程池执行
exectue()
// 提交任务，能够返回执行结果 execute + Future
submit()
// 关闭线程池，等待任务都执行完
shutdown()
// 关闭线程池，不等待任务都执行完
shutdownNow()
```

### 性能与监控方法

值得注意的是，任务和线程的状态在计算过程中可能会动态更改，因此返回的值只是一个近似值

```java
// 线程池已执行和未执行的任务总数
getTaskCount()
// 已完成的任务数量
getCompletedTaskCount()
// 线程池当前的线程数量
getPoolSize()
// 当前线程池中正在执行任务的线程数量
getActiveCount()
```

### 异常处理

使用线程池，需要**注意异常处理的问题**，例如通过 ThreadPoolExecutor 对象的 `execute()` 方法提交任务时，如果**任务在执行的过程中出现运行时异常，会导致执行任务的线程终止**；不过，最致命的是任务虽然异常了，但却**获取不到任何通知**，这会让开发者误以为任务都执行得很正常。虽然线程池提供了很多用于异常处理的方法，但最稳妥和简单的方案还是捕获所有异常并按需处理。

## 线程池合理配置

### 合理设置核心线程数

#### 查看 CPU 核心数

```java
Runtime.getRuntime().availableProcessors();
```

#### 分析处理的任务类型

**CPU 密集型**

对于 CPU 密集型计算，多线程本质上是**提升多核 CPU 的利用率**，理论上再多创建线程也只是增加线程切换的成本。对于 CPU 密集型的计算场景，理论上 `核心线程数 = CPU 核数` 就是最合适的。

不过在工程上，线程的数量一般会设置为 `核心线程数 = CPU 核数 + 1`，

这样的话，**即使当计算线程偶尔由于页缺失故障或其他原因而暂停时，这个“额外”的线程也能确保 CPU 的时钟周期不会被浪费**。从而保证 CPU 的利用率。

**IO 密集型**

若 CPU 计算和 IO 操作的耗时是 1:1，那么 2 个线程是最合适的。若 CPU 计算和 IO 操作的耗时是 1:2，3 个线程最合适。最佳的线程数是与程序中 CPU 计算和 IO 操作的耗时比相关的。

总结一个公式：

+ 针对单核 CPU，`最佳线程数= 1 + (IO 耗时 / CPU 耗时）`。
+ 针对多核 CPU，只需要等比扩大，`最佳线程数= CPU 核数 * [ 1 + (IO 耗时 / CPU 耗时）]`

令 R = IO 耗时 / CPU 耗时，理想状态，当线程 A 执行 IO 操作时，另外 R 个线程正好执行完各自的 CPU 计算。这样 CPU 的利用率就达到了 100%。

另一种说法是，IO 密集型一般设置为 `CPU 核数 / (1 - 阻塞系数）`。阻塞系数等于 IO 操作的占比。计算结果应该与上面一致。

同时要考虑一台机器上可能部署多个服务，需要考虑其他服务线程池的配置情况。

![img](../../../assets/Executor与线程池/17171bd4dc7a7df6.png)

![img](../../../assets/Executor与线程池/17171bd786f4b4a7.png)

按照理论设置参考值，观察任务运行情况（负载、任务利用率等）进行调整，当然也需要支持动态调整。

#### 合理设置核心线程数

若任务经常发生阻塞，可以调用**设置最大线程数方法来重新设置线程池的容量**，以提高 CPU 使用率，但如果设置容量较大，线程之间的调度可能影响到性能，可能会降低吞吐量。

#### 线程预热

线程池被创建后若没有任务过来，里面是不会有线程的。如果需要预热的话可以调用下面的两个方法：

+ 全部启动：`prestartAllCoreThreads()`
+ 仅启动一个：`prestartCoreThread()`

### 队列的选用

JUC 提供了一个线程池的静态工厂类 Executors，利用 Executors 可以快速创建线程池，并且**默认使用的都是无界队列 LinkedBlockingQueue，在高负载下，无界队列很容易导致 OOM**。而 OOM 会导致所有请求都无法处理，这是致命问题。所以**强烈建议使用有界队列**。

所以现在的编码规范中基本都**不建议使用 Executors**。

下面是阻塞队列介绍

![img](../../../assets/Executor与线程池/17171b857e1ed12f.png)

若想降低系统的资源消耗，比如 CPU 的使用率等，可以**设置一个较大的队列容量，较小的线程池容量，来降低线程池处理任务的吞吐量**。

### 拒绝策略的选用

任务拒绝策略属于线程池的保护部分，线程池有一个最大的容量，当线程池的任务缓存队列已满，并且线程池中的线程数目达到 maximumPoolSize 时，就需要拒绝掉该任务，采取任务拒绝策略，保护线程池。

拒绝策略是一个接口

```java
public interface RejectedExecutionHandler {
    void rejectedExecution(Runnable r, ThreadPoolExecutor executor);
}
```

| 名称 | 描述 |
| ---------- | ---- |
|ThreadPoolExecutor.AbortPolicy    | 丢弃任务并抛出 RejectedExecutionException 异常。默认的拒绝策略，在任务不能再提交时，抛出异常，及时反馈程序运行状态。若是比较关键的业务，推荐使用此拒绝策略，在系统不能承载更大的并发量时，能够及时的通过异常发现 |
| ThreadPoolExecutor.DiscardPolicy    | 丢弃任务，但不抛出异常。使用此策略，可能会使我们无法发现系统的异常状态。建议是一些无关紧要的业务采用 |
| ThreadPoolExecutor.DiscardOldestPolicy   | 丢弃队列最前面的任务，然后重新提交被拒绝的任务。需要根据实际业务是否允许丢弃老任务来认真衡量使用使用。 |
| ThreadPoolExecutor.CallerRunsPolicy    | 由调用线程（提交任务的线程）处理该任务。这种情况是需要让所有任务都执行完毕，那么就适合大量计算的任务类型去执行，多线程仅仅是增大吞吐量的手段，最终必须要让每个任务都执行完毕。 |

使用有界队列，当任务过多时，线程池会触发执行拒绝策略，**默认拒绝策略要慎用**，因为默认采用 AbortPolicy，会丢弃任务，并抛出 RejectedExecutionException 异常，对于运行时异常编译器并不强制 catch 它，所以很容易忽略。如果线程池处理的任务非常重要，**建议自定义拒绝策略**；并且在实际工作中，**自定义的拒绝策略往往和降级策略配合使用**。

## 动态更新线程池配置

比如美团 12 点和下午 3、4 点的流量都不一致，所以就需要动态更新线程池的配置。包括修改线程池核心大小、最大核心大小、队列长度等

动态设置最大线程数

```java
public void setMaximumPoolSize(int maximumPoolSize) {
  // 设置允许的最大线程数。 这将覆盖构造函数中设置的任何值。
  if (maximumPoolSize <= 0 || maximumPoolSize < corePoolSize) {
    throw new IllegalArgumentException();
  }
  this.maximumPoolSize = maximumPoolSize;
  // 新设置的值如果大于当前核心线程数，则对空闲线程发起中断请求，将在下次空闲时终止
  if (workerCountOf(ctl.get()) > maximumPoolSize)
    interruptIdleWorkers();
}
```

通过 `setCorePoolSize(corePoolSize)` 设置核心线程数。

```java
public void setCorePoolSize(int corePoolSize) {
  if (corePoolSize < 0)
    throw new IllegalArgumentException();                                                            
  int delta = corePoolSize - this.corePoolSize;
  this.corePoolSize = corePoolSize;
  // 新设置的值如果大于当前活动线程数，则对空闲线程发起中断请求，将在下次空闲时终止
  if (workerCountOf(ctl.get()) > corePoolSize)
    interruptIdleWorkers();
  // 若将设置的数量比之前设置的核心线程数的大，
  else if (delta > 0) {
    // 官翻，我们真的不知道有多少新线程是“需要的”。
    // 作为一种启发式方法，预先启动足够多的新工作线程（最多达到新的核心大小）来处理队列中当前的任务数量，
    // 但如果队列在此时变成空的，则停止。
    int k = Math.min(delta, workQueue.size());
    while (k-- > 0 && addWorker(null, true)) {
      if (workQueue.isEmpty())
        break;
    }
  }
}
```

在运行期线程池使用方调用此方法后，线程池会直接覆盖原来的 corePoolSize 值，并基于当前值和原始值的比较结果采取不同的处理策略

+ 当前值小于当前工作线程数，说明有多余的 worker 线程，此时会向当前 idle 的 worker 线程发起中断请求以实现回收，多余的 worker 在下次 idel 的时候也会被回收；
+ 当前值大于原始值且当前队列中有待执行任务，则线程池会创建新的 worker 线程来执行队列任务。

setCorePoolSize 具体流程如下：

![img](../../../assets/Executor与线程池/17171beed4523ba9.png)

通过 `prestartCoreThread()` 方法启动所有核心线程

```java
public boolean prestartCoreThread() {
  // 启动一个核心线程，使其闲置地等待工作。
  // 这将覆盖仅在执行新任务时启动核心线程的默认策略。如果所有核心线程已经启动，则此方法将返回 false 。
  return workerCountOf(ctl.get()) < corePoolSize &&
    addWorker(null, true);
}
```

### 动态更新要注意的点

动态修改核心线程数大小时，如果将数据改大，可能出现活跃线程数没有发生变化的情况，即使调用 `prestartCoreThread()` 方法也无济于事（该方法是启动所有核心线程）。

出现这种情况的主要原因可以通过 `getTask()` 方法发现端倪

```java
private Runnable getTask() {
  boolean timedOut = false; // Did the last poll() time out?

  for (;;) {
    int c = ctl.get();
    int rs = runStateOf(c);

    // Check if queue empty only if necessary.
    if (rs >= SHUTDOWN && (rs >= STOP || workQueue.isEmpty())) {
      decrementWorkerCount();
      return null;
    }

    int wc = workerCountOf(c);

    // Are workers subject to culling?
    boolean timed = allowCoreThreadTimeOut || wc > corePoolSize;
    // 此处判断活动线程是否大于最大线程数，若大于，并且活动线程数大于 1/队列为空
    // 则将活动线程数减 1
    if ((wc > maximumPoolSize || (timed && timedOut))
        && (wc > 1 || workQueue.isEmpty())) {
      if (compareAndDecrementWorkerCount(c))
        return null;
      continue;
    }

    try {
      Runnable r = timed ?
        workQueue.poll(keepAliveTime, TimeUnit.NANOSECONDS) :
      workQueue.take();
      if (r != null)
        return r;
      timedOut = true;
    } catch (InterruptedException retry) {
      timedOut = false;
    }
  }
}
```

通过该方法可以看到，若工作线程数大于最大线程数，则会对工作线程数量进行减一操作，然后返回 null。

所以改大核心线程数的实际流程为，创建新的工作线程 worker，然后工作线程数进行加一操作。运行创建的工作线程 worker，开始获取任务 task。发现工作线程数量大于最大线程数，对工作线程数进行减一操作。返回 null，即没有获取到 task。清理该任务，流程结束。

流程中加一减一，真正在执行任务的工作线程的数量一直没有发生变化，也就是最大线程数。

解决这个问题的方法是，设置核心线程数时，同时设置最大线程数。或者可以把二者设置为相同的值。

### 设置允许线程超时

Java 在 1.6 版本增加了 `allowCoreThreadTimeOut(boolean value)` 方法，可以让所有线程都支持超时，这意味着如果线程很闲，就会销毁所有线程。

若调整之后把活动线程数设置的值太大了，也并不需要在业务低峰期时人工把值调小，因为 corePoolSize 参数的含义就是"**corePoolSize 是保持活动状态的最小工作线程数（不允许超时等），除非设置了 allowCoreThreadTimeOut，在这种情况下，最小值为零**"。

也就是说，当 allowCoreThreadTimeOut 参数设置为 true 时，核心线程在空闲了 keepAliveTime 的时间后会被回收，相当于线程池自动动态修改了。设置为 false（默认）时，核心线程即使在空闲时也保持活动状态。所以说，核心线程的默认是不会被回收的，若需要回收核心线程数，需要调用 `allowCoreThreadTimeOut(long value)` 方法。

### 如何动态指定队列长度？

由于队列的 capacity 是被 final 修饰了，无法直接 set 队列长度。

美团给出的方案是，自定义一个队列（ResizableCapacityLinkedBlockIngQueue），让其可以对 Capacity 参数进行修改即可，操作起来也非常方便，把 LinkedBlockingQueue 粘贴一份出来，修改类名，然后把 Capacity 参数的 final 修饰符去掉，并提供其对应的 get/set 方法。

在构造线程池的时，使用自定义的这个自定义队列。

## 参考资料

《Java 并发编程实战》

[Java 线程池实现原理及其在美团业务中的实践](https://tech.meituan.com/2020/04/02/java-pooling-pratice-in-meituan.html) 
