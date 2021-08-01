---
title: MySQL 偶发卡顿-刷脏页
description: 分析 MySQL 中偶发性卡顿的原因，以及刷脏页机制。
toc: true
authors: 
    - WayneShen
tags: 
    - MySQL
    - Notes
categories: 
    - DataBase
series: []
date: '2020-08-28T22:20:+08:00'
lastmod: '2020-08-28T22:20:20+08:00'
draft: false
---

</br>

分析 MySQL 中偶发性卡顿的原因，以及刷脏页机制。

<!--more-->

## SQL 语句为什么变慢了

InnoDB 在处理更新语句时，只做了写日志（redo log）这一磁盘操作。

当内存数据页跟磁盘数据页内容不一致时，称这个内存页为 Dirty Page（脏页）。内存数据写入到磁盘后（flush），内存和磁盘上的数据页的内容就一致了，称为“干净页”。

InnoDB 会在后台刷脏页，而刷脏页的过程是要将内存页写入磁盘。所以，无论是查询语句在需要内存时可能要求淘汰一个脏页，还是由于刷脏页的逻辑会占用 IO 资源并可能影响到了更新语句，都可能是造成从业务端感知到 MySQL 卡了一下的原因。卡一下的那个瞬间，可能就是在刷脏页（flush）。

### 何时刷脏页

**InnoDB 的 redo log 写满了**。

这时系统会停止所有更新操作，把 checkpoint 往前推进，redo log 留出空间可以继续写。把 checkpoint 位置从 CP 推进到 CP’，就需要将两个点之间的日志（浅绿色部分），对应的所有脏页都 flush 到磁盘上。之后，图中从 write pos 到 CP’ 之间就是可以再写入的 redo log 的区域。

这种情况**应该尽量避免**，因为出现这种情况时，整个系统就不能再接受更新了，所有的更新都必须堵住。如果从监控上看，这时候更新数会跌为 0。

![redo log 将写完状态](../../../assets/MySQL偶发卡顿-刷脏页/redolog.png)

**系统内存不足**。

当需要新的内存页，而内存不够用时，就要淘汰一些数据页，空出内存给别的数据页使用。如果淘汰的是“脏页”，就要先将脏页写到磁盘。不可以直接淘汰内存，因为刷脏页一定会写盘，就保证了每个数据页有两种状态：

+ 在内存里存在，内存里就肯定是正确的结果，直接返回
+ 内存里没有数据，就可以肯定数据文件上是正确的结果，读入内存后返回。

这种情况是常态，InnoDB 用缓冲池（buffer pool）管理内存，缓冲池中的内存页有三种状态：

+ 还没有使用的
+ 使用了并且是干净页
+ 使用了并且是脏页

**InnoDB 的策略是尽量使用内存**，因此对于一个长时间运行的库来说，未被使用的页面很少。

而当要读入的数据页没有在内存时，就必须到缓冲池中申请一个数据页。这时只能把最久不使用的数据页从内存中淘汰掉：如果要淘汰的是一个干净页，就直接释放出来复用；但如果是脏页，就必须将脏页先刷到磁盘，变成干净页后才能复用。出现以下情况会明显影响性能：

+ 一个查询要淘汰的脏页个数太多，会导致查询的响应时间明显变长；
+ 日志写满，更新全部堵住，写性能跌为 0，这种情况对敏感业务来说，是不能接受的。

所以 InnoDB 需要有控制脏页比例的机制，来尽量避免这些情况。

**MySQL 认为系统空闲时**

MySQL 认为系统有空，见缝插针，有机会就刷一点“脏页”。

**MySQL 正常关闭的情况。**

正常关闭时，MySQL 会把内存的脏页都 flush 到磁盘上，这样下次 MySQL 启动时，就可以直接从磁盘上读数据，启动速度会很快。

但也会导致关闭 MySQL/InnoDB 速度变慢，因为要刷完所有的脏页。

## InnoDB 刷脏页的控制策略

首先要让 InnoDB 知道所在主机的 IO 能力，这样 InnoDB 才能知道需要全力刷脏页时，可以刷多快。

通过 `innodb_io_capacity` 设置，这个值建议设置为磁盘的 IOPS。磁盘的 IOPS 可以通过 fio 这个工具来测试。设置错误会造成性能问题。

需要考虑两个因素：一个是脏页比例，一个是 redo log 写盘速度。

### 刷脏页速度的算法逻辑

**参数 `innodb_max_dirty_pages_pct` 是脏页比例上限，默认值是 75%**。InnoDB 会根据当前的脏页比例（假设为 M），算出一个范围在 0 到 100 之间的数字，计算这个数字的伪代码类似如下：

```c
F1(M)
{
	if M >= innodb_max_dirty_pages_pct then
		return 100;
	return 100 * M / innodb_max_dirty_pages_pct;
}
```

InnoDB 每次写入的日志都有一个序号，当前写入的序号跟 checkpoint 对应的序号之间的差值，假设为 N。InnoDB 会根据这个 N 算出一个范围在 0 到 100 之间的数字，这个计算公式可以记为 F2(N)。F2(N) 算法比较复杂，但可以知道 N 越大，算出来的值越大。然后，根据上述算得的 F1(M) 和 F2(N) 两个值，取其中较大的值记为 R，之后引擎就可以按照 innodb_io_capacity 定义的能力乘以 R% 来控制刷脏页的速度。

### 注意事项

为了避免 MySQL 出现“抖动”，要**合理地设置 innodb_io_capacity 的值**，并且**平时要多关注脏页比例，不要让它经常接近 75%**。

脏页比例是通过 *Innodb_buffer_pool_pages_dirty / Innodb_buffer_pool_pages_total* 得到的

```sql
select VARIABLE_VALUE into @a from global_status where VARIABLE_NAME = 'Innodb_buffer_pool_pages_dirty';
select VARIABLE_VALUE into @b from global_status where VARIABLE_NAME = 'Innodb_buffer_pool_pages_total';
select @a/@b;
```

### 连坐机制

MySQL 中通过 `innodb_flush_neighbors` 控制是否开启**连坐机制**。该参数控制是否在刷脏页时，判断邻居的数据页是否也为脏页，是则一起刷掉，而且这种行为会蔓延。导致数据库变慢。

```sql
show variables like 'innodb_flush_neighbors'
```

此优化在机械硬盘时代比较有意义，可以减少很多随机 IO。机械硬盘的随机 IOPS 一般只有几百，相同的逻辑操作减少随机 IO 就意味着系统性能的大幅度提升。

如果使用的是 SSD 这类 IOPS 比较高的设备的话，就建议把 `innodb_flush_neighbors` 的值设置成 0。

因为这时 IOPS 往往不是瓶颈，而“只刷自己”，就能更快地执行完必要的刷脏页操作，减少 SQL 语句响应时间。

在 MySQL 8.0 中，innodb_flush_neighbors 参数的默认值已经为 0 了。

## 参考资料

《MySQL 45 讲》