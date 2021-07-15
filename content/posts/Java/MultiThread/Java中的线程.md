---
title: Java中的线程
description: Java中线程的生命周期，以及线程状态之间的流转的场景
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
date: '2020-05-01T22:30:+08:00'
lastmod: '2020-05-01T22:30:20+08:00'
featuredImage: ''
draft: false
---

</br>
Java中线程的生命周期，以及线程状态之间的流转的场景。

<!--more-->

## 生命周期


### 通用的线程生命周期

可以“五态模型”来描述。分别是：初始状态、可运行状态、运行状态、休眠状态和终止状态。

![img](../../../assets/Java中的线程/9bbc6fa7fb4d631484aa953626cf6ae5.png)

#### 初始状态

**线程已经被创建，但还不允许分配 CPU 执行**。这个状态属于编程语言特有，所谓的被创建，仅仅是在编程语言层面被创建，而在操作系统层面，真正的线程还没有创建。

#### 可运行状态

**线程可以分配CPU执行**。此时真正的操作系统线程已经被成功创建，可以分配 CPU 执行。

#### 运行状态

当有空闲的 CPU 时，操作系统会将其分配给一个处于可运行状态的线程，被分配到 CPU 的线程的状态就转换成了运行状态。

#### 休眠状态

运行状态的线程若调用一个阻塞的API（例如以阻塞方式读文件）或者等待某个事件（例如条件变量），状态就会转换到休眠状态，同时释放CPU使用权，休眠状态的线程永远没有机会获得CPU使用权。

当等待的事件出现了，线程就会从休眠状态转换到可运行状态。

#### 终止状态

**线程执行完或出现异常就会进入终止状态**。终止状态的线程不会切换到其他任何状态，进入终止状态也就意味着线程的生命周期结束了。

### Java中线程的生命周期

C语言的 POSIX Threads 规范，就**把初始状态和可运行状态合并了**；

**Java 语言里则把可运行状态和运行状态合并了**，这两个状态在操作系统调度层面有用，而 JVM 层面不关心这两个状态，因为 JVM 把线程调度交给操作系统处理了。

除了简化合并，这五种状态也有可能被细化，比如，Java语言里就细化了休眠状态。所以 Java 中线程生命周期有六种状态，分别为：

1. NEW（初始化状态）
2. RUNNABLE（可运行/运行状态）
3. BLOCKED（阻塞状态）
4. WAITING（无时限等待）
5. TIMED_WAITING（有时限等待）
6. TERMINATED（终止状态）

其中BLOCKED、WAITING、TIMED_WAITING就是休眠状态。也就是说只要 Java 线程处于这三种状态之一，那么这个线程就永远没有 CPU 的使用权。

![img](../../../assets/Java中的线程/3f6c6bf95a6e8627bdf3cb621bbb7f8c.png)

#### RUNNABLE与BLOCKED的转换
只有一种场景会触发这种转换，就是线程等待 synchronized 的隐式锁。

synchronized 修饰的方法、代码块同一时刻只允许一个线程执行，其他线程只能等待。这种情况下，等待的线程就会从 RUNNABLE 转换到 BLOCKED 状态。而当等待的线程获得 synchronized 隐式锁时，就又会从 BLOCKED 转换到 RUNNABLE 状态。

而如果线程调用阻塞式 api 时，在操作系统层面的线程会转换到休眠状态，但在 JVM 层面，Java 线程不会变化，依旧时RUNNABLE状态，JVM 层面并不关心操作系统调度相关的状态，因为在 JVM 看来，等待 CPU 使用权（操作系统层面此时处于可执行状态）与等待 I/O（操作系统层面此时处于休眠状态）没有区别，都是在等待某个资源，所以都归入了 RUNNABLE 状态。平时所谓的 Java 在调用阻塞式 API 时，线程会阻塞，指的是操作系统线程的状态，并不是Java线程的状态。

#### RUNNABLE与WAITING的转换

总体来说，有三种场景会触发这种转换。

1. 获得 synchronized 隐式锁的线程，调用无参数的 Object.wait() 方法。

2. 调用无参数的 `Thread.join()` 方法。 `join()` 是一种线程同步方法，例如有一个线程对象 thread A，当调用 `A.join()` 时，执行这条语句的线程会等待 thread A 执行完，而等待中的这个线程，其状态会从 RUNNABLE 转换到 WAITING。当线程 thread A 执行完，原来等待它的线程又会从 WAITING 状态转换到 RUNNABLE。
3. 调用 `LockSupport.park()` 方法。调用 `LockSupport.park()` 方法，当前线程会阻塞，线程的状态会从 RUNNABLE 转换到 WAITING。调用`LockSupport.unpark(Thread thread)` 可唤醒目标线程，目标线程的状态又会从 WAITING 状态转换到 RUNNABLE。

#### RUNNABLE与TIMED_WAITING的转换

有五种场景会触发这种转换：

1. 调用带超时参数的 `Thread.sleep(long millis)` 方法；
2. 获得 synchronized 隐式锁的线程，调用带超时参数的 `Object.wait(long timeout)` 方法；
3. 调用带超时参数的 `Thread.join(long millis)` 方法；
4. 调用带超时参数的 `LockSupport.parkNanos(Object blocker, long deadline)` 方法；
5. 调用带超时参数的 `LockSupport.parkUntil(long deadline)` 方法。

#### NEW到RUNNABLE
Java 刚创建出来的 Thread 对象就是 NEW 状态，而创建 Thread 对象主要有两种方法。一种是继承 Thread 对象，重写 `run()` 方法。一种是实现 Runnalbe 接口，重写 `run()` 方法。

#### RUNNABLE到TERMINATED

线程执行完 `run()` 方法后，会自动转换到 TERMINATED 状态，当然若执行 `run()` 方法时异常抛出，也会导致线程终止。

若想要强制中断 `run()` 方法，有 `stop() ` 和 `interrupt()`，两者的区别为：

`stop()` 方法会真的杀死线程，若线程持有 ReentrantLock 锁，被 `stop()` 的线程并不会自动调用 ReentrantLock 的 `unlock()` 去释放锁，其他线程就再也无法获取锁，这很危险，所以不建议使用。类似方法还有 `suspend()` 和 `resume()` 方法，也都不建议使用了。

`interrupt()` 方法相对比较温柔，线程有机会执行一些后续操作，同时也可以无视这个通知。被 interrupt 的线程可以通过异常或主动检测来接收通知。

当线程A处于 WAITING、TIMED_WAITING 状态时，若其他线程调用线程A的 `interrupt()` 方法，会使线程A返回到 RUNNABLE 状态，同时线程A的代码会触发 InterruptedException 异常。这属于被中断的线程通过异常的方式获得了通知。

值得注意的是，在触发 InterruptedException 异常的同时，JVM 会同时把线程的中断标志位清除。

若线程处于 RUNNABLE 状态，并且没有阻塞在某个I/O操作上，此时其他线程调用线程A的 `interrupt()` 方法，那线程A可以通过 `isInterrupted()` 方法，检测是不是自己被中断了。这属于主动检测的方式。






