---
title: CompletableFuture 实现异步编程
description: 简要分析 Java 中的 CompletableFuture 类，以及通过其实现异步编程
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
date: '2020-05-02T19:50:+08:00'
lastmod: '2020-05-02T19:51:20+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中的 CompletableFuture 类，以及通过其实现异步编程

<!--more-->

## 异步化

用多线程优化性能，其实就是将串行操作变成并行操作。在这过程中，一定会涉及到异步化。异步化，是并行方案得以实施的基础，也就是利用多线程优化性能这个核心方案得以实施的基础。

JDK8 提供了 CompletableFuture 来支持异步编程。

## 创建 CompletableFuture

创建 CompletableFuture 对象主要靠下面代码中展示的这 4 个静态方法

```java
// 使用默认线程池
static CompletableFuture<Void> runAsync(Runnable runnable)
static <U> CompletableFuture<U> supplyAsync(Supplier<U> supplier)
// 可以指定线程池  
static CompletableFuture<Void> runAsync(Runnable runnable, Executor executor)
static <U> CompletableFuture<U> supplyAsync(Supplier<U> supplier, Executor executor)  
```

前两个之间的区别是：Runnable 接口的 `run()` 方法没有返回值，而 Supplier 接口的 `get()` 方法有返回值。

前后两个方法的区别在于：后两个方法可以指定线程池参数。

**默认情况下 CompletableFuture 会使用公共的 ForkJoinPool 线程池**，这个线程池默认创建的线程数是 CPU 的核数（也可以通过 JVM option:`-Djava.util.concurrent.ForkJoinPool.common.parallelism` 来设置 ForkJoinPool 线程池的线程数）。

如果所有 CompletableFuture 共享一个线程池，那么一旦有任务执行一些很慢的 I/O 操作，就会导致线程池中所有线程都阻塞在 I/O 操作上，从而**造成线程饥饿**，进而影响整个系统的性能。所以，**强烈建议要根据不同的业务类型创建不同的线程池，以避免互相干扰**。

创建完 CompletableFuture 对象之后，会自动地异步执行 `runnable.run()` 方法或 `supplier.get()` 方法。对于一个异步操作，需要关注两个问题：

1. 异步操作何时结束；
2. 如何获取异步操作的执行结果。
 
因为 CompletableFuture 类实现了 Future 接口，所以这两个问题都可以通过 Future 接口来解决。另外，CompletableFuture 类还实现了 CompletionStage 接口，这个接口有 40 个方法。

## CompletionStage 接口

可以站在分工的角度类比一下工作流。任务是有时序关系的，比如有**串行关系**、**并行关系**、**汇聚关系**等。先后执行就是串行关系，几组任务同时执行就是并行关系，并行任务执行完后才可以执行下一个任务就是汇聚关系。

CompletionStage 接口可以清晰地描述任务之间的这种时序关系，例如 `f3 = f1.thenCombine(f2, ()->{})` 描述的就是一种汇聚关系。

汇聚关系分 AND 聚合和 OR 聚合，

+ AND 聚合表示所有依赖的任务都完成后才开始执行当前任务；
+ OR 聚合表示依赖的任务只要有一个完成就可以执行当前任务。

同时 CompletionStage 接口也可以方便地描述异常处理。

### 描述串行关系

CompletionStage 接口里面描述串行关系，主要是 thenApply、thenAccept、thenRun 和 thenCompose 这四个系列的接口。

```java
CompletionStage<R> thenApply(Function<? super T,? extends U> fn);
CompletionStage<R> thenApplyAsync(Function<? super T,? extends U> fn);
CompletionStage<Void> thenAccept(Consumer<? super T> action);
CompletionStage<Void> thenAcceptAsync(Consumer<? super T> action);
CompletionStage<Void> thenRun(Runnable action);
CompletionStage<Void> thenRunAsync(Runnable action);
CompletionStage<R> thenCompose(Function<? super T, ? extends CompletionStage<U>> fn);
CompletionStage<R> thenComposeAsync(Function<? super T, ? extends CompletionStage<U>> fn);
```

+ thenApply 系列函数里参数 fn 的类型是接口 `Function<T, R>`，这个接口里与 CompletionStage 相关的方法是 `R apply(T t)`，这个方法既能接收参数也支持返回值，所以 thenApply 系列方法返回的是 `CompletionStage<R>`。
+ thenAccept 系列方法里参数 consumer 的类型是接口 `Consumer<T>`，这个接口里与 CompletionStage 相关的方法是 `void accept(T t)`，这个方法虽然支持参数，但却不支持回值，所以 thenAccept 系列方法返回的是 `CompletionStage<Void>`。
+ thenRun 系列方法里 action 的参数是 Runnable，所以 action 既不能接收参数也不支持返回值，所以 thenRun 系列方法返回的也是 CompletionStage<Void>。
+ thenCompose 方法，这个系列的方法会新创建出一个子流程，最终结果和 thenApply 系列是相同的。

这些方法中 Async 代表的是异步执行 fn、consumer 或 action。

以下示例代码，首先通过 `supplyAsync()` 启动一个异步流程，之后是两个串行操作。虽然这是一个异步流程，但任务①②③却是串行执行的，②依赖①的执行结果，③依赖②的执行结果。

```java
CompletableFuture<String> f0 = CompletableFuture.supplyAsync(() -> "Hello World") //①
  	.thenApply(s -> s + " QQ")  //②
  	.thenApply(String::toUpperCase);//③
System.out.println(f0.join());
//输出结果
//HELLO WORLD QQ
```

### 描述 AND 汇聚关系
CompletionStage 接口里面描述 AND 汇聚关系，主要是 thenCombine、thenAcceptBoth 和 runAfterBoth 系列的接口，这些接口的区别也是源自 fn、consumer、action 这三个核心参数不同。

```java
CompletionStage<R> thenCombine(other, fn);
CompletionStage<R> thenCombineAsync(other, fn);
CompletionStage<Void> thenAcceptBoth(other, consumer);
CompletionStage<Void> thenAcceptBothAsync(other, consumer);
CompletionStage<Void> runAfterBoth(other, action);
CompletionStage<Void> runAfterBothAsync(other, action);
```

### 描述 OR 汇聚关系
CompletionStage 接口里面描述 OR 汇聚关系，主要是 applyToEither、acceptEither 和 runAfterEither 系列的接口，这些接口的区别也是源自 fn、consumer、action 这三个核心参数不同。

```java
CompletionStage applyToEither(other, fn);
CompletionStage applyToEitherAsync(other, fn);
CompletionStage acceptEither(other, consumer);
CompletionStage acceptEitherAsync(other, consumer);
CompletionStage runAfterEither(other, action);
CompletionStage runAfterEitherAsync(other, action);
```
下面的示例代码展示了如何使用 `applyToEither()` 方法来描述一个 OR 汇聚关系。

```java
CompletableFuture<String> f1 = CompletableFuture.supplyAsync(() -> {
    int t = getRandom(5, 10);
    sleep(t, TimeUnit.SECONDS);
    return String.valueOf(t);
});

CompletableFuture<String> f2 = CompletableFuture.supplyAsync(() -> {
    int t = getRandom(5, 10);
    sleep(t, TimeUnit.SECONDS);
    return String.valueOf(t);
});

CompletableFuture<String> f3 = f1.applyToEither(f2, s -> s);
System.out.println(f3.join());
```

### 异常处理
虽然 fn、consumer、action 的核心方法都不允许抛出可检查异常，但却无法限制它们抛出运行时异常，下面的代码出现了除零错误的运行时异常。

```java
CompletableFuture<Integer> f0 = CompletableFuture.supplyAsync(()->(7/0)).thenApply(r->r*10);
System.out.println(f0.join());
```

非异步编程里面，可以使用 try-catch 来捕获并处理异常，那在异步编程里 CompletionStage 接口提供的方案非常简单，比 try-catch 还要简单，使用下面方法进行异常处理和串行操作是一样的，都支持链式编程方式。

```java
CompletionStage exceptionally(fn);
CompletionStage<R> whenComplete(consumer);
CompletionStage<R> whenCompleteAsync(consumer);
CompletionStage<R> handle(fn);
CompletionStage<R> handleAsync(fn);
```

`exceptionally()` 的使用非常类似于 try-catch 中的 catch，但是由于支持链式编程方式，所以相对更简单。除此之外，`whenComplete()` 和 `handle()` 系列方法就类似于 finally，无论是否发生异常都会执行 `whenComplete()` 中的回调函数 consumer 和 handle() 中的回调函数 fn。`whenComplete()` 和 `handle()` 的区别在于 `whenComplete()` 不支持返回结果，而 handle() 是支持返回结果的。

下面的示例代码展示了如何使用 `exceptionally()` 方法来处理异常：

```java
CompletableFuture<Integer> f0 = CompletableFuture.supplyAsync(()->7/0))
    .thenApply(r->r*10).exceptionally(e->0);
System.out.println(f0.join());
```

## 参考资料

《Java 并发编程实战》