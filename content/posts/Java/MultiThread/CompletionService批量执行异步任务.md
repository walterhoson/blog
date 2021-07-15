---
title: CompletionService 批量执行异步任务
description: 简要分析 Java 中的 CompletionService 类的原理，以及使用其批量执行异步任务
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
date: '2020-05-02T20:30:+08:00'
lastmod: '2020-05-02T20:31:20+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中的 CompletionService 类的原理，以及使用其批量执行异步任务

<!--more-->

## CompletionService

CompletionService 接口的实现类是 ExecutorCompletionService。

实现类的原理是内部维护了一个阻塞队列，把任务执行结果的 Future 对象加入到阻塞队列中。

### 接口说明

CompletionService 接口的实现类是 ExecutorCompletionService，这个实现类的构造方法有两个，分别是：

```java
// 传入线程池，不指定队列，默认使用 LinkedBlockQueue
ExecutorCompletionService(Executor executor)
// 传入线程池，并使用传入的队列
ExecutorCompletionService(Executor executor, BlockingQueue<Future<V>> completionQueue)
```

两个方法都需要传入一个线程池。任务执行结果的 Future 对象会被加入到 completionQueue 中，若不指定 completionQueue，默认会使用无界队列 LinkedBlockingQueue。

通过 CompletionService 接口提供的 `submit()` 方法提交批量操作，这些批量操作会被 CompletionService 异步执行，最后通过 `take()` 方法获取一个 Future 对象，通过调用 Future 对象的 `get()` 方法就能返回批量操作的执行结果了。

下面介绍一下 CompletionService 接口提供的方法，CompletionService 接口提供的方法有 5 个

```java
Future<V> submit(Callable<V> task);
// 类似于 ThreadPoolExecutor 的 <T> Future<T> submit(Runnable task, T result) 
Future<V> submit(Runnable task, V result);
// 以下三个方法，都是从阻塞队列中获取并移除一个元素，区别在于若阻塞队列为空，调用 take 的线程会被阻塞
Future<V> take() throws InterruptedException;
// 若阻塞队列为空，poll 返回 null
Future<V> poll();
// 支持以超时的方式获取并移除阻塞队列头部的一个元素，若等待了 timeout unit 时间，阻塞队列还是空，那该方法会返回 null 值
Future<V> poll(long timeout, TimeUnit unit) throws InterruptedException;
```

### 使用示例

需求：三个线程执行询价，获取结果，并持久化。

**通过 ThreadPoolExecutor + Future**

三个线程异步执行询价，通过三次 Future 的 `get()` 方法获取结果，并持久化。

```java
// 创建线程池
ExecutorService executor = Executors.newFixedThreadPool(3);
// 异步向电商 S1 询价
Future<Integer> f1 = executor.submit(()->getPriceByS1());
// 异步向电商 S2 询价
Future<Integer> f2 = executor.submit(()->getPriceByS2());
// 异步向电商 S3 询价
Future<Integer> f3 = executor.submit(()->getPriceByS3());
 
// 获取电商 S1 报价并保存
r = f1.get();
executor.execute(()->save(r));
// 获取电商 S2 报价并保存
r = f2.get();
executor.execute(()->save(r));
// 获取电商 S3 报价并保存  
r = f3.get();
executor.execute(()->save(r));
```

存在问题：若询价 S1 执行耗时过长，S2 耗时很短，该做法也无法先保存 S2 结果，因为主线程阻塞在了 `f1.get()` 上。

解决方案：加入阻塞队列，获取到 S1、S2、S3 的结果都进入阻塞队列，然后主线程消费阻塞队列，这样就能确保先获取到的结果先保存到数据库中。

**方案一加入阻塞队列**

```java
// 创建阻塞队列
BlockingQueue<Integer> bq = new LinkedBlockingQueue<>();
//电商 S1 报价异步进入阻塞队列  
executor.execute(()-> bq.put(f1.get()));
//电商 S2 报价异步进入阻塞队列  
executor.execute(()-> bq.put(f2.get()));
//电商 S3 报价异步进入阻塞队列  
executor.execute(()-> bq.put(f3.get()));
//异步保存所有报价  
for (int i=0; i<3; i++) {
  Integer r = bq.take();
  executor.execute(()->save(r));
}  
```

在实际项目中不建议如此做，因为 JDK 并发包提供了 CompletionService，可以解决先获取到的报价先保存数据库的问题。

**方案二通过 CompletionService 实现**

与上一方案不同的是，CompletionService 是把任务执行结果的 Future 对象加入到阻塞队列中，而上面的示例代码是把任务最终的执行结果放入了阻塞队列中。

高性能的执行批量异步任务，示例代码

```java
// 创建线程池
ExecutorService executor = Executors.newFixedThreadPool(3);
// 创建 CompletionService
CompletionService<Integer> cs = new ExecutorCompletionService<>(executor);
// 异步向电商 S1 询价
cs.submit(()->getPriceByS1());
// 异步向电商 S2 询价
cs.submit(()->getPriceByS2());
// 异步向电商 S3 询价
cs.submit(()->getPriceByS3());
// 将询价结果异步保存到数据库
for (int i=0; i<3; i++) {
  Integer r = cs.take().get();
  executor.execute(()->save(r));
}
```

## Dubbo 中的 Forking Cluster

Dubbo 中有一种叫做 Forking 的集群模式，这种集群模式下，支持并行地调用多个查询服务，只要有一个成功返回结果，整个服务就可以返回了。

例如需要提供一个地址转坐标的服务，为了保证该服务的高可用和性能，可以并行地调用 3 个地图服务商的 API，然后只要有 1 个正确返回了结果，那么地址转坐标这个服务就可以直接返回了。这种集群模式可以容忍 2 个地图服务商服务异常，但缺点是消耗的资源偏多。

```java
geocoder(addr) {
  //并行执行以下 3 个查询服务 
  r1 = geocoderByS1(addr);
  r2 = geocoderByS2(addr);
  r3 = geocoderByS3(addr);
  //只要 r1,r2,r3 有一个返回，则返回
  return r1 | r2 | r3;
}
```

利用 CompletionService 可以快速实现 Forking 这种集群模式。

首先创建了一个线程池 executor 、一个 CompletionService 对象 cs 和一个 `Future<Integer>` 类型的列表 futures，每次通过调用 CompletionService 的 `submit()` 方法提交一个异步任务，会返回一个 Future 对象，把这些 Future 对象保存在列表 futures 中。通过调用 `cs.take().get()`，就能拿到最快返回的任务执行结果，只要拿到一个正确返回的结果，就可以取消所有任务并且返回最终结果了。

```java
// 创建线程池
ExecutorService executor = Executors.newFixedThreadPool(3);
// 创建 CompletionService
CompletionService<Integer> cs = new ExecutorCompletionService<>(executor);
// 用于保存 Future 对象
List<Future<Integer>> futures = new ArrayList<>(3);
//提交异步任务，并保存 future 到 futures 
futures.add(cs.submit(()->geocoderByS1()));
futures.add(cs.submit(()->geocoderByS2()));
futures.add(cs.submit(()->geocoderByS3()));
// 获取最快返回的任务执行结果
Integer r = 0;
try {
  // 只要有一个成功返回，则 break
  for (int i = 0; i < 3; ++i) {
    r = cs.take().get();
    //简单地通过判空来检查是否成功返回
    if (r != null) {
      break;
    }
  }
} finally {
  //取消所有任务
  for(Future<Integer> f : futures)
    f.cancel(true);
}
// 返回结果
return r;
```

## 总结

当需要批量提交异步任务的时候建议使用 CompletionService。它将线程池 Executor 和阻塞队列 BlockingQueue 的功能融合在了一起，能够让批量异步任务的管理更简单。

除此之外，CompletionService 能够让异步任务的执行结果有序化，**先执行完的先进入阻塞队列**，利用这个特性，可以轻松**实现后续处理的有序性**，**避免无谓的等待**，同时还可以快速实现诸如 Forking Cluster 这样的需求。

CompletionService 的实现类 ExecutorCompletionService，需要自己创建线程池，虽看上去有些啰嗦，但好处是可以让多个 ExecutorCompletionService 的线程池隔离，这种隔离性能避免几个特别耗时的任务拖垮整个应用的风险。

## 参考资料

《Java 并发编程实战》