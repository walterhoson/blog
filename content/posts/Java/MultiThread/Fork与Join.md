---
title: Fork 与 Join
description: 简要分析 Java 中的 Fork 与 Join 的工作原理，以及如何支持分治模型
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
date: '2020-05-02T21:50:+08:00'
lastmod: '2020-05-02T21:50:11+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中的 Fork 与 Join 的工作原理，以及如何支持分治模型

<!--more-->

## 单机版的 MapReduce

对于**简单的并行任务**，可以通过“**线程池+Future**”的方案来解决。

如果**任务之间有聚合关系**，无论是 AND 聚合还是 OR 聚合，都可以**通过 CompletableFuture 来解决**。

而**批量的并行任务**，则可以**通过 CompletionService 来解决**。

![img](../../../assets/Fork与Join/47f3e1e8834c99d9a1933fb496ffde2d.png)

并发问题可以分为三个层面：**分工、协作和互斥**，除此之外，还有一个任务模型为“分治”，即分而治之。

**把一个复杂的问题分解成多个相似的子问题，然后再把子问题分解成更小的子问题，直到子问题简单到可以直接求解**。

Java 并发包中提供的 Fork/Join 并行计算框架，就是用来支持分治这种任务模型的。

### 分治任务模型

分治任务模型可分为两个阶段：

+ 一个阶段是**任务分解**，也就是将任务迭代地分解为子任务，直至子任务可以直接计算出结果；
+ 另一个阶段是**结果合并**，即逐层合并子任务的执行结果，直至获得最终结果。

![img](../../../assets/Fork与Join/d2649d8db8e5642703aa5563d76eb86a.png)

在这个分治任务模型里，任务和分解后的子任务具有相似性，这种相似性往往体现在任务和子任务的算法是相同的，但计算的数据规模是不同的。具备这种相似性的问题，往往都采用递归算法。

### Fork/Join 的使用

**Fork 对应的是分治任务模型里的任务分解，Join 对应的是结果合并**。

Fork/Join 计算框架主要包含两部分，一部分是**分治任务的线程池 ForkJoinPool**，另一部分是**分治任务 ForkJoinTask**。这两部分的关系类似于 ThreadPoolExecutor 和 Runnable 的关系，都可以理解为提交任务到线程池，只不过分治任务有自己独特类型 ForkJoinTask。

ForkJoinTask 是一个抽象类，它的方法有很多，最核心的是 `fork()` 方法和 `join()` 方法，其中 `fork()` 方法会异步地执行一个子任务，而 `join()` 方法则会阻塞当前线程来等待子任务的执行结果。

ForkJoinTask 有两个子类 RecursiveAction 和 RecursiveTask，通过名字应该能知道，它们都是用递归的方式来处理分治任务的。这两个子类都定义了抽象方法 `compute()`，不过区别是 RecursiveAction 定义的 `compute()` 没有返回值，而 RecursiveTask 定义的 `compute()` 方法是有返回值的。这两个子类也是抽象类，在使用时，需要自定义子类去扩展。

来自官方示例，利用 Fork/Join 这个并行计算框架计算斐波那契数列

```java
static void main(String[] args){
  //创建分治任务线程池  
  ForkJoinPool fjp = new ForkJoinPool(4);
  //创建分治任务
  Fibonacci fib = new Fibonacci(30);   
  //启动分治任务  
  Integer result = fjp.invoke(fib);
  //输出结果  
  System.out.println(result);
}
//递归任务
static class Fibonacci extends RecursiveTask<Integer>{
  final int n;
  Fibonacci(int n){
    this.n = n;
  }
  protected Integer compute(){
    if (n <= 1)
      return n;
    Fibonacci f1 = new Fibonacci(n - 1);
    //创建子任务  
    f1.fork();
    Fibonacci f2 = new Fibonacci(n - 2);
    //等待子任务结果，并合并结果  
    return f2.compute() + f1.join();
  }
}
```

首先需要创建一个分治任务线程池以及计算斐波那契数列的分治任务，之后通过调用分治任务线程池的 `invoke()` 方法来启动分治任务。由于计算斐波那契数列需要有返回值，所以 Fibonacci 继承自 RecursiveTask。分治任务 Fibonacci 需要实现 `compute()` 方法，这个方法里面的逻辑和普通计算斐波那契数列非常类似，区别之处在于计算 `Fibonacci(n - 1)` 使用了异步子任务，这是通过 `f1.fork()` 这条语句实现的。

### ForkJoinPool 工作原理

Fork/Join 并行计算的核心组件是 ForkJoinPool。

ThreadPoolExecutor 本质上是一个生产者-消费者模式的实现，内部有一个任务队列，这个任务队列是生产者和消费者通信的媒介；ThreadPoolExecutor 可以有多个工作线程，但是这些工作线程都共享一个任务队列。

ForkJoinPool 本质上也是一个生产者-消费者的实现，但更加智能，可以参考下面的 ForkJoinPool 工作原理图来理解其原理。ThreadPoolExecutor 内部只有一个任务队列，而 ForkJoinPool 内部有多个任务队列，当我们通过 ForkJoinPool 的 `invoke()` 或 `submit()` 方法提交任务时，ForkJoinPool 根据一定的路由规则把任务提交到一个任务队列中，如果任务在执行过程中会创建出子任务，那么子任务会提交到工作线程对应的任务队列中。

![img](../../../assets/Fork与Join/e75988bd5a79652d8325ca63fcd55131.png)

若工作线程对应的任务队列空了，并不是没活儿干了，ForkJoinPool 支持一种叫做“**任务窃取**”的机制，如果工作线程空闲了，那它可以“窃取”其他工作任务队列里的任务，例如下图中，线程 T2 对应的任务队列已经空了，它可以“窃取”线程 T1 对应的任务队列的任务。如此一来，所有的工作线程都不会闲下来了。

ForkJoinPool 中的任务队列采用的是双端队列，工作线程正常获取任务和“窃取任务”分别是从任务队列不同的端消费，这样能避免很多不必要的数据竞争。这里介绍的仅仅是简化后的原理，ForkJoinPool 的实现比较复杂。

### 模拟 MapReduce 统计单词数量

学习 MapReduce 有一个入门程序，统计一个文件里面每个单词的数量，下面来看看如何用 Fork/Join 并行计算框架来实现。

可以先用二分法递归地将一个文件拆分成更小的文件，直到文件里只有一行数据，然后统计这一行数据里单词的数量，最后再逐级汇总结果，可以对照前面的简版分治任务模型图来理解这个过程。

思路有了，下面的示例程序用一个字符串数组 `String[] fc` 来模拟文件内容，fc 里面的元素与文件里面的行数据一一对应。关键的代码在 `compute()` 这个方法里，这是一个递归方法，前半部分数据 fork 一个递归任务去处理（关键代码 `mr1.fork()`），后半部分数据则在当前任务中递归处理（`mr2.compute()`）。

```java
static void main(String[] args){
  String[] fc = {"hello world", 
                 "hello me",
                 "hello fork", 
                 "hello join", 
                 "fork join in world"};
  //创建 ForkJoin 线程池    
  ForkJoinPool fjp = new ForkJoinPool(3);
  //创建任务    
  MR mr = new MR(fc, 0, fc.length);  
  //启动任务    
  Map<String, Long> result = fjp.invoke(mr);
  //输出结果    
  result.forEach((k, v)->
    System.out.println(k+":"+v));
}

//MR 模拟类
static class MR extends RecursiveTask<Map<String, Long>> {
  private String[] fc;
  private int start, end;

  //构造函数
  MR(String[] fc, int from, int to){
    this.fc = fc;
    this.start = from;
    this.end = to;
  }
  
  @Override 
  protected Map<String, Long> compute(){
    if (end - start == 1) {
      return calc(fc[start]);
    } else {
      int mid = (start + end) / 2;
      MR mr1 = new MR(fc, start, mid);
      mr1.fork();
      MR mr2 = new MR(fc, mid, end);
      //计算子任务，并返回合并的结果    
      return merge(mr2.compute(), mr1.join());
    }
  }
  
  //合并结果
  private Map<String, Long> merge(Map<String, Long> r1, Map<String, Long> r2) {
    Map<String, Long> result = new HashMap<>();
    result.putAll(r1);
    //合并结果
    r2.forEach((k, v) -> {
      Long c = result.get(k);
      if (c != null)
        result.put(k, c + v);
      else 
        result.put(k, v);
    });
    return result;
  }
  
  //统计单词数量
  private Map<String, Long> calc(String line) {
    Map<String, Long> result = new HashMap<>();
    //分割单词    
    String [] words = line.split("\\s+");
    //统计单词数量    
    for (String w : words) {
      Long v = result.get(w);
      if (v != null) 
        result.put(w, v + 1);
      else
        result.put(w, 1L);
    }
    return result;
  }
}
```

### 总结

Fork/Join 并行计算框架主要解决的是分治任务。分治的核心思想是“分而治之”：将一个大的任务拆分成小的子任务去解决，然后再把子任务的结果聚合起来从而得到最终结果。这个过程非常类似于大数据处理中的 MapReduce，所以可以把 Fork/Join 看作单机版的 MapReduce。

Fork/Join 并行计算框架的核心组件是 ForkJoinPool。ForkJoinPool 支持任务窃取机制，能够让所有线程的工作量基本均衡，不会出现有的线程很忙，而有的线程很闲的状况，所以性能很好。Java 1.8 提供的 Stream API 里面并行流也是以 ForkJoinPool 为基础的。不过需要注意的是，**默认情况下所有的并行流计算都共享一个 ForkJoinPool**，这个**共享的 ForkJoinPool 默认的线程数是 CPU 的核数**；如果所有的并行流计算都是 CPU 密集型计算的话，完全没有问题，但是如果存在 I/O 密集型的并行流计算，那么很可能会因为一个很慢的 I/O 计算而拖慢整个系统的性能。所以**建议用不同的 ForkJoinPool 执行不同类型的计算任务**。

如果你对 ForkJoinPool 详细的实现细节感兴趣，也可以参考 。

## 参考资料

《Java 并发编程实战》

[ForkJoinPool 详细实现细节 - Doug Lea 的论文](http://gee.cs.oswego.edu/dl/papers/fj.pdf)