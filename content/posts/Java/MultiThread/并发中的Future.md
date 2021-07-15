---
title: 并发中的 Future
description: 简要分析 Java 中的 Future 类，以及获取异步执行的结果的方式
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
date: '2020-05-02T19:00:+08:00'
lastmod: '2020-05-02T19:05:20+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中的 Future 类，以及获取异步执行的结果的方式

<!--more-->

## 线程池中获取任务执行结果

通过 ThreadPoolExecutor 提供的 3 个 `submit()` 方法和 1 个 FutureTask 工具类来支持获得任务执行结果的需求。3 个 `submit()` 方法签名如下：

```java
// 提交 Runnable 任务
Future<?> submit(Runnable task);
// 提交 Callable 任务
<T> Future<T> submit(Callable<T> task);
// 提交 Runnable 任务及结果引用  
<T> Future<T> submit(Runnable task, T result);
```

它们的返回值都是 Future 接口，Future 接口有 5 个方法，

```java
// 取消任务
boolean cancel(boolean mayInterruptIfRunning);
// 判断任务是否已取消  
boolean isCancelled();
// 判断任务是否已结束
boolean isDone();
// 获得任务执行结果
get();
// 获得任务执行结果，支持超时
get(long timeout, TimeUnit unit);
```

通过 Future 接口的这 5 个方法，提交的任务不但能够获取任务执行结果，还可以取消任务。

不过需要注意的是：这两个 `get()` 方法都是阻塞式的，如果被调用时，任务还没有执行完，那么调用 `get()` 方法的线程会阻塞，直到任务执行完才会被唤醒。

3 个 `submit()` 方法之间的区别在于方法参数不同：

**submit(Runnable task)**

用于提交 Runnable 任务。参数是一个 Runnable 接口，Runnable 接口的 `run()` 方法是没有返回值的，所以 `submit(Runnable task)` 方法返回的 Future 仅可以用来断言任务已经结束了，类似于 `Thread.join()`。

**submit(Callable<T> task)**

提交 Callable 任务。参数是一个 Callable 接口，它只有一个 `call()` 方法，并且这个方法是有返回值的，所以这个方法返回的 Future 对象可以通过调用其 `get()` 方法来获取任务的执行结果。

**submit(Runnable task, T result)**

提交 Runnable 任务及结果引用。假设这个方法返回的 Future 对象是 f，`f.get()` 的返回值就是传给 `submit()` 方法的参数 result。

下面这段示例代码展示了经典用法，需要注意的是 Runnable 接口的实现类 Task 声明了一个有参构造函数 `Task(Result r)`，创建 Task 对象时传入了 result 对象，这样就能在类 Task 的 `run()` 方法中对 result 进行各种操作了。**result 相当于主线程和子线程之间的桥梁，通过它主子线程可以共享数据**。

```java
ExecutorService executor = Executors.newFixedThreadPool(1);
// 创建 Result 对象 r
Result r = new Result();
r.setA(a);
// 提交任务
Future<Result> future = executor.submit(new Task(r), r);  
Result fr = future.get();
// 下面等式成立
fr === r;
fr.getA() === a;
fr.getX() === x;

class Task implements Runnable{
  Result r;
  //通过构造函数传入 result
  Task(Result r){
    this.r = r;
  }
  void run() {
    //可以操作 result
    a = r.getA();
    r.setX(x);
  }
}
```

## FutureTask 工具类

Future 是一个接口，而 FutureTask 是一个工具类，这个工具类有两个构造函数，它们的参数和前面介绍的 `submit()` 方法类似，

```java
FutureTask(Callable<V> callable);
FutureTask(Runnable runnable, V result);
```

### 使用方法

FutureTask 实现了 Runnable 和 Future 接口。**利用 FutureTask 对象可以很容易获取子线程的执行结果**。

由于实现了 Runnable 接口，所以可以将 FutureTask 对象作为任务提交给 ThreadPoolExecutor 去执行，也可以直接被 Thread 执行。

```java
// 创建 FutureTask
FutureTask<Integer> futureTask = new FutureTask<>(()-> 1+2);
// 创建并启动线程
Thread T1 = new Thread(futureTask);
T1.start();
// 获取计算结果
Integer result = futureTask.get();
```

又因为实现了 Future 接口，所以也能用来获得任务的执行结果。下面的示例代码是将 FutureTask 对象提交给 ThreadPoolExecutor 去执行。

```java
// 创建 FutureTask
FutureTask<Integer> futureTask = new FutureTask<>(()-> 1+ 2);
// 创建线程池
ExecutorService es = Executors.newCachedThreadPool();
// 提交 FutureTask 
es.submit(futureTask);
// 获取计算结果
Integer result = futureTask.get();
```

## 总结

利用 Java 并发包提供的 Future 可以很容易获得异步任务的执行结果，无论异步任务是通过线程池 ThreadPoolExecutor 执行的，还是通过手工创建子线程来执行的。Future 可以类比为现实世界里的提货单，比如去蛋糕店订生日蛋糕，蛋糕店都是先给你一张提货单，你拿到提货单之后，没有必要一直在店里等着，可以先去干点其他事，比如看场电影；等看完电影后，基本上蛋糕也做好了，然后你就可以凭提货单领蛋糕了。

利用多线程可以快速将一些串行的任务并行化，从而提高性能；**如果任务之间有依赖关系，比如当前任务依赖前一个任务的执行结果，这种问题基本上都可以用 Future 来解决**。在分析这种问题的过程中，可以使用有向图描述一下任务之间的依赖关系，同时将线程的分工也做好，好处是更形象，且不易出错。

## 参考资料

《Java并发编程实战》