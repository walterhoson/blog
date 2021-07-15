---
title: Java中的引用
description: 简介 Java 中对象的引用机制，分代算法的原理及优化思路
toc: true
authors: 
    - WayneShen
tags: 
    - Java
    - JVM
categories: 
    - Java
series: []
date: '2020-03-14T11:05:+08:00'
lastmod: '2020-03-14T13:40:00+08:00'
draft: false
---

</br>

简介 Java 中对象的引用机制，分代算法的原理及优化思路

<!--more-->

## Java 中的引用

### 强引用

```java
public class Test {
  public static A a = new A();
}
```

一个变量引用一个对象，只要是强引用的类型，那么垃圾回收时绝对不会去回收这个对象的。

### 软引用

```java
public class Test {
  A a = new A();
  public static SoftReference<A> sf = new SoftReference<A>(a);
  a = null;
  sf.get();//有时候会返回 null
}
```

把 A 实例对象用一个 SoftReference 软引用类型的对象包起来，此时 a 变量对 A 对象的引用就是软引用了。

软引用意思是该对象可有可无，若内存实在不够，就回收它。

### 弱引用

```java
public class Test {
  A a = new A();
  public static WeakReference<A> wf = new WeakReference<A>(a);
  a = null;
  wf.get();//有时候会返回 null
  wf.isEnQueued();//返回是否被垃圾回收器标记为即将回收的垃圾
}
```

弱引用就类似没引用，如果发生垃圾回收，必定把这个对象回收掉。

### 虚引用

```java
public class Test {
  A a = new A();
  PhantomReference<A> pf = new PhantomReference<Object>(a);
  a=null;
  pf.get();//永远返回 null
  pf.isEnQueued();//返回是否从内存中已经删除
}
```

顾名思义，形同虚设，与其他几种引用都不同，虚引用并不会决定对象的生命周期。如果一个对象仅持有虚引用，那么它就和没有任何引用一样，在任何时候都可能被垃圾回收器回收。

| 引用类型 | 被垃圾回收时间 | 用途           | 生存时间           |
| -------- | -------------- | -------------- | ------------------ |
| 强引用   | 从不会         | 对象的一般状态 | JVM 停止运行时终止 |
| 软引用   | 内存不足时     | 对象缓存       | 内存不足时终止     |
| 弱引用   | 垃圾回收时     | 对象缓存       | GC 运行后终止      |
| 虚引用   | unknown        | unknown        | unknown            |

## finalize() 方法

```java
public class A {
  public static A instance;
  @Override
  protected void finalize() throws Throwable {
    A.instance = this;
  } 
}
```

在对象即将要被回收前，会先看是否重写了 Object 类中的 finalize 方法，看是否把自己这个实例对象给了某个 GC Roots 变量，如果重新让某个 GC Roots 变量引用了自己，那么就不用被垃圾回收了。