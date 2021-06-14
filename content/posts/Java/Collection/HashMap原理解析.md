---
title: HashMap原理解析
description: HashMap是应用广泛的哈希表实现，拥有较强的性能表现，put 和 get 操作可以达到常数时间的性能，当然其性能表现非常依赖哈希码的有效性。
toc: true
authors: 
    - WayneShen
tags: 
    - Collection
    - Java
categories: 
    - Java
series: []
date: '2020-11-19T15:20:+08:00'
lastmod: '2020-11-19T15:20:20+08:00'
draft: false
---

</br>
HashMap是应用广泛的哈希表实现，拥有较强的性能表现，put 和 get 操作可以达到常数时间的性能，当然其性能表现非常依赖哈希码的有效性。

<!--more-->


## 内部实现

HashMap 内部可以看作 **数组**（Node<K,V>[]  table）和 **链表** 结合组合成的复合结构，数组被分为一个个桶（bucket），通过哈希值决定了键值对在这个数组的寻址。

哈希值相同的键值对，则以链表形式存储。若链表大小超过阈值（TREEIFY_THRESHOLD, 默认 8），链表就会被改造为树形结构（红黑树）。

HashMap 按照类似 `lazy-load` 的原则。首次实例化时只是进行初始化，在首次 put 数据时，判断若 `table=null`，则调用 `resize` 方法进行初始化数组（resize 方法作用初始化或扩容）。

### 寻址与 Hash 函数

键值对在 Hash 表中的位置（数组的index）是由 ``(n - 1) & hash``  计算得出（n = tab.length，即数组长度）。

需要注意的是，此处的 hash 值并不是 key 的 hashCode，而是通过内部的 hash 函数计算得出的：

> key.hashCode() 的高位数据移位到低位（即放弃低16位），再进行异或运算。
> 即 ``(h = key.hashCode()) ^ (h >>> 16)``。

高位移位后的异或运算，其实就相当于将  hashCode  的高16位和低16位进行异或运算。其原因是寻址算法中高16位与 `length - 1` 的与运算都是0，就相当于高16位没有参与运算，在 table 长度较小时，就容易产生碰撞。所以需要将原 hashCode 的高低16位进行融合，放在低16位。让低16位保持高低16位的特征，此**目的是打散 hash，减少碰撞**。



举个🌰，当 table 较小时，`length - 1` 的高16位就永远是 0

![运算过程](../../../assets/HashMap原理解析/image-20201119160550156.png)


此时 `length - 1` 的高16位0和未处理的 `hashCode` 高16位相与，永远是0。当出现两个 `hashCode` 低16位相同，高16位不同时，相与运算出来的结果就相同了，就产生了 hash 碰撞。

其实 ``(n - 1) & hash`` 的效果和 hash 对 length 取模效果一样（n 必须是 2<sup>m</sup>），但是与运算性能比取模要高很多。

找到位置后，若位置上有元素，判断它的 hash 值和 key 是否都与当前相同，相同则覆盖，不相同则追加链表。



### resize 函数

`resize` 除了第一次 put 时进行初始化 table 之外，还会对 table 进行扩容，不考虑极端情况下（容量理论最大极限由 MAXIMUM_CAPACITY 指定，数值为 1<<30，也就是 2<sup>30</sup>），主要逻辑为

+ 阈值 = 负载系数 x 容量，若构建 HashMap 时没有指定，那么就依据相应的默认常量值，即 0.75 x 16 = 12。
+ 阈值通常以倍数进行调整，即 `newThr = oldThr  <<  1`，根据 `putVal` 的逻辑，当元素个数超过阈值时，则调整Map大小。
+ 扩容后，需要将老的数组中的元素重新放入到新的数组中，这是扩容的主要性能消耗。

resize 中一个有意思的地方，在扩容之后进行 rehash，因为每次扩容都是两倍，所以元素要么在原来的位置，要么在原位置往左移一位的位置，所以在 resize 方法中，迁移原数据时，判断 hash 是否与原来相同，相同则位置不变，不同则只需要加上 oldCap（相当于数值的二进制往左移动了一位），这种做法避免了 rehash 时对每个 hash 进行 n 取模，从而加快了速度。

下图，扩容前后 hash 值未发生变化

![运算过程](../../../assets/HashMap原理解析/image-20201119161908634.png)



## 容量 和负载系数

容量（Capacity，默认 16）和 负载系数（Load Factor，默认 0.75）决定了可用桶的数量，空桶太多会浪费空间，太满会严重影响性能。

如果知道键值对数量，可以预先设置合适的容量大小，计算公式为：容量 x 负载系数 > 元素数量。即：**元素数量 / 0.75 的结果向上取2的幂**。

为什么负载系数设置为 0.75？

+ 若设置为1，就意味着需要等到数组满了才能进行扩容，虽然增加了空间利用率，但 hash 碰撞的几率也增加了，底层的红黑树也变得非常复杂，同样也增加了查找成本。
+ 若设置为0.5，则数组才一半，就要开始扩容，虽然 hash 冲突的几率变小，但是降低了空间的利用率，尤其是当数组较大时。




## 树化

当 table 中每个桶里的 bin 的数量大于 `TREEIFY_THRESHOLD` （默认8）时

+ 若当前容量小于 `MIN_TREEIFY_CAPACITY`（64），只会进行 resize 扩容。
+ 若容量大于 `MIN_TREEIFY_CAPACITY`，则会进行树化改造，构造成红黑树。

树化改造的原因是，在元素放置过程中，如果一个个对象哈希冲突，都被放置到同一个桶里，则会形成一个链表，而链表查询是线性的，复杂度为 O(n)，严重影响存取性能。

通过精心构造大量的数据，产生哈希冲突，这样的操作就会消耗服务器大量 CPU 和线程资源，导致服务器不可用，这就构成 **哈希碰撞拒绝服务攻击**。

树化后，链表被改造成了红黑树，红黑树的插入、查询、删除的最坏时间复杂度都为 O(logn)，性能要好于链表的O(n)。




## 线程不安全

HashMap 是线程不安全的，在并发场景下会出现死循环的情况。下面说明存在的问题。

### JDK8

#### 1. 丢失元素

并发 put 可能导致丢失元素。

下面是在 put 方法中追加列表的逻辑：

```java
if ((e = p.next) == null) { 
    p.next = newNode(hash, key, value, null);
    if (binCount >= TREEIFY_THRESHOLD - 1) 
        treeifyBin(tab, hash);
    break;
}
```

假设两个线程同时通过了外层的 if 判断，此时两个线程先后执行 newNode，那么后者就会把前者新增的 node 给替换掉了，从而造成了元素的丢失。

#### 2. get 结果为 null

put 和 get 并发可能会导致 get 结果为 null。

在 put 过程中，若数量超过阈值会发生扩容，下面是 `resize` 中的代码块，新实例化一个容量为 newCap 的 newTable，并覆盖原 table，然后进行数组即链表的迁移；

```java
Node<K,V>[] newTab = (Node<K,V>[])new Node[newCap];
table = newTab; // T1
if (oldTab != null) {
    for (int j = 0; j < oldCap; ++j) {
        // 进行数组及迁移...
    }
}
```

假如一个线程在 T1 时刻，新建的空的 `newTab` 覆盖了原有的 table，此时另一线程进行 get 操作，会发现 table 是空的，就只能返回 null 了。

### JDK1.7

#### 并发产生循环链表

问题主要是出在并发 resize 时，首先看下 resize 中的数组迁移的方法 `transfer`

```java
void transfer(Entry[] newTable, boolean rehash) {  
    int newCapacity = newTable.length;  
    for (Entry<K,V> e : table) {  
        while(null != e) {  
            Entry<K,V> next = e.next;           
            if (rehash) {  
                e.hash = null == e.key ? 0 : hash(e.key);  
            }  
            int i = indexFor(e.hash, newCapacity);   
            e.next = newTable[i];  
            newTable[i] = e;  
            e = next;  
        } 
    }  
}  
```

并发情况下，Thread 1与 Thread 2 同时进行扩容。假设原表为：

![开始状态](../../../assets/HashMap原理解析/Snipaste_2020-11-19_16-36-01.png)


Thread 1 在开始扩容时，执行到 `Entry<K,V> next = e.next`；此时时间片用完，进入阻塞。此时 Thread 1 中 `e = 6，next = e.next = 7`。

此时 Thread 2 开始扩容，假设 Thread 2 完成了扩容，便于理解假设扩容数据迁移后 index 不变，因为链表迁移使用的**头插法**，此时链表变成了 8 -> 7 -> 6，执行结束。此时哈希表变成如下状态：

![Thread 2 执行后](../../../assets/HashMap原理解析/Snipaste_2020-11-19_16-31-39.png)

此时，Thread 1 拿到时间片继续执行，`e = 6, e.next = 7`。而目前链表中，`7.next = 6`，这时 6 和 7 两个节点形成了循环链表，此时 get 一个链表中不存在的 key，就出现了死循环。

![Thread 1 继续执行](../../../assets/HashMap原理解析/Snipaste_2020-11-19_16-32-06.png)






> 本博客文章除特别声明外均为原创，采用<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0 许可协议</a>进行许可。超出<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0 许可协议</a>的使用请联系作者获得授权。