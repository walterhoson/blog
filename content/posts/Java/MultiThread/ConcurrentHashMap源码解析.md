---
title: ConcurrentHashMap 源码解析
description: 简要分析 Java 中 ConcurrentHashMap 源码
toc: true
authors: 
    - WayneShen
tags: 
    - Concurrent
    - Java
categories: 
    - Java
series: []
date: '2021-08-17T22:00:+08:00'
lastmod: '2021-08-17T22:00:20+08:00'
featuredImage: ''
draft: false
---

</br>

简要分析 Java 中 ConcurrentHashMap 源码

<!--more-->

## 线程安全的哈希表

hashTable 也是线程安全的，但其内部增删改操作都是采用方法体加 synchronized 来实现的，效率相对较低。

而 ConcurrentHashMap 采用的是分段锁的方式来实现线程安全，并提升效率。

### 分段加锁提升并发性能

ConcurrentHashMap 通过分段加锁，把一份数据拆分为多个 segment，对每个段设置锁，并发 put 时，仅需要锁住需要操作的 segment，此时其他的 segment 的数据不会产生锁竞争。

读操作保证尽量不加锁，采用底层的 volatile 特性保证数据的可见性，采用 volatile 读，写操作直接将无效队列的数据置为无效，并将写缓冲器的数据刷回缓存，保证数据的缓存一致性。采用 volatile 读来保证读性能。

## 赋值操作

```java
// table 的初始化容量，
// 当 table 为 null 时，保存创建时使用的初始表大小，默认为 0。初始化后，保存下一个要调整表格大小的元素计数值
// 为负表示正在初始化或调整大小，-1 表示正在进行初始化构造
private transient volatile int sizeCtl;
// volatile 形式的数据表
transient volatile Node<K,V>[] table;
// 扩容时专用的下一张表。用于暂存数据
private transient volatile Node<K,V>[] nextTable;
```

### put 方法

```java
public V put(K key, V value) {
  return putVal(key, value, false);
}

final V putVal(K key, V value, boolean onlyIfAbsent) {
  if (key == null || value == null) throw new NullPointerException();
  int hash = spread(key.hashCode());
  int binCount = 0;
  for (Node<K,V>[] tab = table;;) {
    Node<K,V> f; int n, i, fh;
    if (tab == null || (n = tab.length) == 0)
      tab = initTable();
    else if ((f = tabAt(tab, i = (n - 1) & hash)) == null) {
      if (casTabAt(tab, i, null, new Node<K,V>(hash, key, value, null)))
        // no lock when adding to empty bin
        break;                   
    }
    else if ((fh = f.hash) == MOVED)
      tab = helpTransfer(tab, f);
    else {
      V oldVal = null;
      synchronized (f) {
        if (tabAt(tab, i) == f) {
          if (fh >= 0) {
            binCount = 1;
            for (Node<K,V> e = f;; ++binCount) {
              K ek;
              if (e.hash == hash && ((ek = e.key) == key || (ek != null && key.equals(ek)))) {
                oldVal = e.val;
                if (!onlyIfAbsent)
                  e.val = value;
                break;
              }
              Node<K,V> pred = e;
              if ((e = e.next) == null) {
                pred.next = new Node<K,V>(hash, key, value, null);
                break;
              }
            }
          }
          else if (f instanceof TreeBin) {
            Node<K,V> p;
            binCount = 2;
            if ((p = ((TreeBin<K,V>)f).putTreeVal(hash, key, value)) != null) {
              oldVal = p.val;
              if (!onlyIfAbsent)
                p.val = value;
            }
          }
        }
      }
      if (binCount != 0) {
        if (binCount >= TREEIFY_THRESHOLD)
          treeifyBin(tab, i);
        if (oldVal != null)
          return oldVal;
        break;
      }
    }
  }
  addCount(1L, binCount);
  return null;
}
```

### spread 方法获取 hash 值

```java
int hash = spread(key.hashCode());

static final int spread(int h) {
  return (h ^ (h >>> 16)) & HASH_BITS;
}
```

获取 key 的 hashCode，调用 spread 算法，获取到了一个 hash 值。

该 hash 算法与 HashMap 中相似，将 hash 值的高低 16 位进行异或运算，以此融合高低 16 位的特征，来打散 hash，降低冲突的概率。

### initTable 初始化表

```java
if (tab == null || (n = tab.length) == 0)
  tab = initTable();
private final Node<K,V>[] initTable() {
  Node<K,V>[] tab; int sc;
  while ((tab = table) == null || tab.length == 0) {
    if ((sc = sizeCtl) < 0)
      Thread.yield(); // lost initialization race; just spin
    else if (U.compareAndSwapInt(this, SIZECTL, sc, -1)) {
      try {
        if ((tab = table) == null || tab.length == 0) {
          int n = (sc > 0) ? sc : DEFAULT_CAPACITY;
          @SuppressWarnings("unchecked")
          Node<K,V>[] nt = (Node<K,V>[])new Node<?,?>[n];
          table = tab = nt;
          sc = n - (n >>> 2);
        }
      } finally {
        sizeCtl = sc;
      }
      break;
    }
  }
  return tab;
}
```

- 最初 table 为 null，此时需要初始化该 table
- ``U.compareAndSwapInt(this, SIZECTL, sc, -1)``，CAS 操作，sizeCtl = -1
- 初始化一个 table 数组，默认大小就是 16，最终 sizeCtl 设置为 16-4=12，初始化阈值容量大小为 12 超过该容量触发扩容
- 然后重新开始 put 方法的 for 循环开启下一轮循环

### tabAt 方法的 volatile 读

```java
else if ((f = tabAt(tab, i = (n - 1) & hash)) == null) {
  if (casTabAt(tab, i, null, new Node<K,V>(hash, key, value, null)))
    break;                   // no lock when adding to empty bin
}

static final <K,V> Node<K,V> tabAt(Node<K,V>[] tab, int i) {
  return (Node<K,V>)U.getObjectVolatile(tab, ((long)i << ASHIFT) + ABASE);
}
```

- ``tabAt(tab, i = (n - 1) & hash)``，通过 ``n-1 & hash`` 定位到table中对应的位置；
- ``return (Node<K,V>)U.getObjectVolatile(tab, ((long)i << ASHIFT) + ABASE);``，传递位置（数组和 hash 定位出来的位置）
- 此处为**线程安全**操作，获取数组对应位置的元素，用于后面的key-value放入。
- volatile 只能保证 Node 数组的引用可见性，不能保证里面的对象，所以采用这种方法。

### casTabAt 方法

```java
static final <K,V> boolean casTabAt(Node<K,V>[] tab, int i, Node<K,V> c, Node<K,V> v) {
    return U.compareAndSwapObject(tab, ((long)i << ASHIFT) + ABASE, c, v);
}
```

- 使用底层的 CAS 操作，直接将 key-value 对放在数组定位到的位置
- **Unsafe，CAS 的操作，是线程安全的**，**只有一个线程可以在这里成功的将一个 key-value 对方在数组的一个地方里**
- ConcurrentHashMap的线程安全，是在 put 操作时，首先初始化数组，然后依靠CAS 对数组对应位置进行赋值。

截止目前为止，暂时没有分段的概念，起初内部就一个数组，数组赋值依赖CAS，硬件级别的 MESI 协议，以此实现线程安全。

### 分段锁策略

```java
synchronized (f) {
  if (tabAt(tab, i) == f) {
    if (fh >= 0) {
      binCount = 1;
      for (Node<K,V> e = f;; ++binCount) {
        K ek;
        if (e.hash == hash && ((ek = e.key) == key || (ek != null && key.equals(ek)))) {
          oldVal = e.val;
          if (!onlyIfAbsent)
            e.val = value;
          break;
        }
        Node<K,V> pred = e;
        if ((e = e.next) == null) {
          pred.next = new Node<K,V>(hash, key,value, null);
          break;
        }
      }
    }
    else if (f instanceof TreeBin) {
      Node<K,V> p;
      binCount = 2;
      if ((p = ((TreeBin<K,V>)f).putTreeVal(hash, key,value)) != null) {
        oldVal = p.val;
        if (!onlyIfAbsent)
          p.val = value;
      }
    }
  }
}
```

- 当在 casTabAt() 方法上进行 cas 失败后，会重新循环，走到分段锁这块儿。synchronized (f) 这段代码就是分段锁的核心。只对单个元素加锁

数组如果有 16 个元素，最多就是对每个位置的元素加一把锁，synchronized 锁，这个位置的元素直接加了一个锁，只有一个线程可以加锁来进行这个位置的链表+红黑树的处理，这个就是分段加锁

JDK 1.8 的 ConcurrentHashMap，并没有采取的是对整个数组加一把大的锁，而是对数组每个位置的元素都有一把小锁，synchronized，保证对数组的每个位置的元素同一时间只能有一个线程进入处理链表/红黑树就可以了

数组的中的每一个元素，无论是 null 情况下来赋值（CAS，分段加锁思想），有值情况下来处理链表/红黑树（synchronized，对元素本身加锁，更加是分段加锁思想），都是对数组的一个元素加锁而已

你的数组有多大，有多少个元素，你就有多少把锁

大幅度的提升了整个 HashMap 加锁的效率

- 其他逻辑跟 hashmap 就大同小异了。... 基本上差不多。.. 主要理解其内部操作都可以保证安全性就可以了

### tryPresize 方法

```java
private final void tryPresize(int size) {
  int c = (size >= (MAXIMUM_CAPACITY >>> 1)) ? MAXIMUM_CAPACITY :
  tableSizeFor(size + (size >>> 1) + 1);
  int sc;
  while ((sc = sizeCtl) >= 0) {
    Node<K,V>[] tab = table; int n;
    if (tab == null || (n = tab.length) == 0) {
      n = (sc > c) ? sc : c;
      if (U.compareAndSwapInt(this, SIZECTL, sc, -1)) {
        try {
          if (table == tab) {
            @SuppressWarnings("unchecked")
            Node<K,V>[] nt = (Node<K,V>[])new Node<?,?>[n];
            table = nt;
            sc = n - (n >>> 2);
          }
        } finally {
          sizeCtl = sc;
        }
      }
    }
    else if (c <= sc || n >= MAXIMUM_CAPACITY)
      break;
    else if (tab == table) {
      int rs = resizeStamp(n);
      if (sc < 0) {
        Node<K,V>[] nt;
        if ((sc >>> RESIZE_STAMP_SHIFT) != rs || sc == rs + 1 ||
            sc == rs + MAX_RESIZERS || (nt = nextTable) == null ||
            transferIndex <= 0)
          break;
        if (U.compareAndSwapInt(this, SIZECTL, sc, sc + 1))
          transfer(tab, nt);//这里内部也是使用了分段锁
      }
      else if (U.compareAndSwapInt(this, SIZECTL, sc,
                                   (rs << RESIZE_STAMP_SHIFT) + 2))
        transfer(tab, null);
    }
  }
}
```

## transfer() 方法--分段锁策略

```java
private final void transfer(Node<K,V>[] tab, Node<K,V>[] nextTab) {
  int n = tab.length, stride;
  if ((stride = (NCPU > 1) ? (n >>> 3) / NCPU : n) < MIN_TRANSFER_STRIDE)
    stride = MIN_TRANSFER_STRIDE; // subdivide range
  if (nextTab == null) {            // initiating
    try {
      @SuppressWarnings("unchecked")
      Node<K,V>[] nt = (Node<K,V>[])new Node<?,?>[n << 1];
      nextTab = nt;
    } catch (Throwable ex) {      // try to cope with OOME
      sizeCtl = Integer.MAX_VALUE;
      return;
    }
    nextTable = nextTab;
    transferIndex = n;
  }
  int nextn = nextTab.length;
  ForwardingNode<K,V> fwd = new ForwardingNode<K,V>(nextTab);
  boolean advance = true;
  boolean finishing = false; // to ensure sweep before committing nextTab
  for (int i = 0, bound = 0;;) {
    Node<K,V> f; int fh;
    while (advance) {
      int nextIndex, nextBound;
      if (--i >= bound || finishing)
        advance = false;
      else if ((nextIndex = transferIndex) <= 0) {
        i = -1;
        advance = false;
      }
      else if (U.compareAndSwapInt
               (this, TRANSFERINDEX, nextIndex,
                nextBound = (nextIndex > stride ?
                             nextIndex - stride : 0))) {
        bound = nextBound;
        i = nextIndex - 1;
        advance = false;
      }
    }
    if (i < 0 || i >= n || i + n >= nextn) {
      int sc;
      if (finishing) {
        nextTable = null;
        table = nextTab;
        sizeCtl = (n << 1) - (n >>> 1);
        return;
      }
      if (U.compareAndSwapInt(this, SIZECTL, sc = sizeCtl, sc - 1)) {
        if ((sc - 2) != resizeStamp(n) << RESIZE_STAMP_SHIFT)
          return;
        finishing = advance = true;
        i = n; // recheck before commit
      }
    }
    else if ((f = tabAt(tab, i)) == null)
      advance = casTabAt(tab, i, null, fwd);
    else if ((fh = f.hash) == MOVED)
      advance = true; // already processed
    else {
      synchronized (f) {
        if (tabAt(tab, i) == f) {
          Node<K,V> ln, hn;
          if (fh >= 0) {
            int runBit = fh & n;
            Node<K,V> lastRun = f;
            for (Node<K,V> p = f.next; p != null; p = p.next) {
              int b = p.hash & n;
              if (b != runBit) {
                runBit = b;
                lastRun = p;
              }
            }
            if (runBit == 0) {
              ln = lastRun;
              hn = null;
            }
            else {
              hn = lastRun;
              ln = null;
            }
            for (Node<K,V> p = f; p != lastRun; p = p.next) {
              int ph = p.hash; K pk = p.key; V pv = p.val;
              if ((ph & n) == 0)
                ln = new Node<K,V>(ph, pk, pv, ln);
              else
                hn = new Node<K,V>(ph, pk, pv, hn);
            }
            setTabAt(nextTab, i, ln);
            setTabAt(nextTab, i + n, hn);
            setTabAt(tab, i, fwd);
            advance = true;
          }
          else if (f instanceof TreeBin) {
            TreeBin<K,V> t = (TreeBin<K,V>)f;
            TreeNode<K,V> lo = null, loTail = null;
            TreeNode<K,V> hi = null, hiTail = null;
            int lc = 0, hc = 0;
            for (Node<K,V> e = t.first; e != null; e = e.next) {
              int h = e.hash;
              TreeNode<K,V> p = new TreeNode<K,V>
                (h, e.key, e.val, null, null);
              if ((h & n) == 0) {
                if ((p.prev = loTail) == null)
                  lo = p;
                else
                  loTail.next = p;
                loTail = p;
                ++lc;
              }
              else {
                if ((p.prev = hiTail) == null)
                  hi = p;
                else
                  hiTail.next = p;
                hiTail = p;
                ++hc;
              }
            }
            ln = (lc <= UNTREEIFY_THRESHOLD) ? untreeify(lo) :
            (hc != 0) ? new TreeBin<K,V>(lo) : t;
            hn = (hc <= UNTREEIFY_THRESHOLD) ? untreeify(hi) :
            (lc != 0) ? new TreeBin<K,V>(hi) : t;
            setTabAt(nextTab, i, ln);
            setTabAt(nextTab, i + n, hn);
            setTabAt(tab, i, fwd);
            advance = true;
          }
        }
      }
    }
  }
}
```

# get 方法 

- ConcurrentHashMap 在进行获取元素的时候加锁吗？其实是不加的。

下面是直接获取 tab 数组中的数据。

```java
public V get(Object key) {
  Node<K,V>[] tab; Node<K,V> e, p; int n, eh; K ek;
  int h = spread(key.hashCode());
  if ((tab = table) != null && (n = tab.length) > 0 &&
      (e = tabAt(tab, (n - 1) & h)) != null) {
    if ((eh = e.hash) == h) {
      if ((ek = e.key) == key || (ek != null && key.equals(ek)))
        return e.val;
    }
    else if (eh < 0)
      return (p = e.find(h, key)) != null ? p.val : null;
    while ((e = e.next) != null) {
      if (e.hash == h &&
          ((ek = e.key) == key || (ek != null && key.equals(ek))))
        return e.val;
    }
  }
  return null;
}
```

put，如何 CAS 加锁赋值，synchronized 分段加锁处理链表/红黑树，扩容两倍大小的数组，核心的原理跟 hashmap 是一样的，CAS 和 synchronized 分段加锁的思想体现，加锁的粒度是数组里的每个元素

他对读这个事情，是不用锁的，volatile 底层硬件级别的原理，思考一下，volatile 读操作的话，load 屏障，绝对是在读取数据的时候，一定会嗅探一下，探查一下无效队列，如果说某个数据被别人修改过了

此时必须立马过期掉本地高速缓存里的缓存数据，invalid（I），然后再读的时候，就需要发送 read 消息到总线，从其他线程修改修改这个值的线程的高速缓存里，必须这个加载到最新的值

不加锁，但是他通过 volatile 读，尽可能给你保证说是读到了其他线程修改的一个最新的值，但是不需要加锁

记录了数组的每个位置挂载了多少个元素，每个位置都可能挂的是链表或者是红黑树，此时可能一个位置有多个元素，size 方法，是帮助你去读到当前最新的一份数据，通过 volatile 的读操作

但是因为读操作是不加锁，他不一定可以保证说，你读的时候就一定没人修改了，很可能是你刚刚读完一份数据，就有人来修改

# jdk1.7 和 1.8 对应的 ConcurrentHashMap 的锁粒度比较

## JDK 1.7 的 ConcurrentHashMap 锁粒度相对较粗

Segment，16 个 Segment，16 个分段，每个 Segment 对应 Node[] 数组，每个 Segment 有一把锁，也就是说对一个 Segment 里的 Node[] 数组的不同的元素如果要 put 操作的话，其实都是要竞争一个锁，串行化来处理的

锁的粒度是比较粗的，因为一个 Node[] 数组是一把锁，但是他有多个 Node[] 数组

## JDK 1.8 的 ConcurrentHashMap，优化了，锁粒度细化，

他是就一个 Node[] 数组，正常会扩容的，但是他的锁粒度是针对的数组里的每个元素，每个元素的处理会加一把锁，不同的元素就会有不同的锁

大幅度的提升了多线程并发写 ConcurrentHashMap 的性能，降低了锁的冲突

读这个事情，是不加锁，他 volatile 读，保证说你读到的是当前最新的数据，内存屏障和硬件级别的原理，都给大家讲解过了

# 总结：

- 1.8 的 concurrentHashmap 在 1.7 的数据结构上做了大的改动，采用红黑树之后可以保证查询效率（`O(logn)`），甚至取消了 ReentrantLock 改为了 synchronized，这样可以看出在新版的 JDK 中对 synchronized 优化是很到位的。
- concurrentHashmap 在 1.7 使用的是数组加链表，遍历效率较低。而 1.8 采用的是链表+红黑树