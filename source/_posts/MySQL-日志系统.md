---
title: MySQL更新语句及redo log
date: 2020-08-28 22:01:00
tags: [MySQL,笔记]
description: 
read_more: 阅读全文
categories: MySQL
toc: true
---


执行链路与查询一致。

## 日志模块 

### redo log

MySQL中，如果每次更新操作都需要写入磁盘，然后磁盘找到对应的那条记录，然后再更新，整个过程的IO成本和查找成本都很高。

为此引入了 **WAL 技术**（Write-Ahead Logging），关键点就是**先写日志，再写磁盘**。

具体来说，InnoDB 引擎会先把记录写到 redolog 里，并更新内存，此时就算完成了，InnoDB 在适当时候，如系统空闲时，将操作记录更新到磁盘中。InnoDB 的 redolog 的大小是固定的，比如可以配置一组4个文件，每个文件的大小时1GB，从头开始写，写到末尾又回到开头循环写。也就是写满之后无法再执行新的更新，先停下持久化一下。

<!-- more -->

![redo-log](image-20200921231702981.png)

+ wirte pos 是当前记录的位置，一边写一边后移，写到第 3 号文件末尾后就回到 0 号文件开头。
+ checkpoint 是当前要擦除的位置，也是往后推移并循环的，擦除记录前要把记录更新到数据文件。
+ wirte pos 和 checkpoint 中间的空着的，就是可以用来记录新的操作。

> **redo log 是 InnoDB 特有的**。
>
> 有了 redolog，InnoDB 就可以**保证即使数据库发生异常重启，之前提交的记录都不会丢失**，这个能力称为 crash-safe。

### bin log

binlog 是 **server 层自带**的日志，称为**归档日志**。只可用于归档，没有 crash-safe 能力。

### 区别

+ redolog 是 InnoDB 引擎特有；binlog 是 MySQL 的 Server 层实现的，所有引擎都可以使用。
+ redolog 是物理日志，记录**在某个数据页上做的修改**；binlog 是逻辑日志，记录**此语句的原始逻辑**，如”给 id = 2 的行的字段 field 加1“。补充：binlog有两种模式，statement 格式记 sql 语句， row 格式会记录行的内容，记两条，更新前和更新后都有。
+ redolog 是**循环写**的，空间固定会用完；binlog 是可以**追加写**的。追加写指 binlog 文件写到一定大小后会切换到下一个，并不会覆盖以前的日志。



## update 执行流程

```sql
-- 示例sql
update T set c=c+1 where ID=2;
```

### innoDB 内部执行流程

1. 执行器

![更新执行流程](image-20200929191838287.png)

> 浅色表示 InnoDB 内部执行，深色表示执行器中执行

1. 执行器先找引擎取 ID=2 这一行。ID 是主键，引擎直接用树搜索找到这一行。如果 ID=2 这一行所在的数据页本来就在内存中，就直接返回给执行器；否则，需要先从磁盘读入内存，然后再返回。
2. 执行器拿到引擎给的行数据，将值加上 1，得到新的一行数据，再调用引擎接口写入这行新数据。
3. 引擎将这行新数据更新到内存中，同时将更新操作记录到 redolog 里，此时 redolog 处于 prepare 状态。然后告知执行器执行完成了，随时可以提交事务。
4. 执行器生成这个操作的 binlog，并把 binlog 写入磁盘。
5. 执行器调用引擎的提交事务接口，引擎把刚刚写入的 redolog 改成提交 commit 状态，更新完成。

### 两阶段提交

redolog 写入操作被拆成了两步，prepare 和 commit。为了让两份日志之间的逻辑一致。如果不一致，若一个日志写完，另一个没有写完的时候 crash了，会导致两份日志数据不一致。

上图中，两个阶段 crach 处理逻辑如下：

+ 时刻A，写入 redolog 处于 prepare 阶段之后、写 binlog 之前，发生了 crash，由于此时 binlog 还没写，redolog 也还没提交，所以崩溃恢复的时候，这个事务会回滚。binlog 还没写，所以也不会传到备库。

+ 时刻B，binlog 写完，redolog 没有 commit。这个时候需要做判断：

  + redolog 中已有 commit 标识，表示 redolog 事务时完整的，则直接提交。
  + redolog 中事务只有完整 prepare，则判断对应的事务 binlog 是否存在并完整，是则提交事务，否则回滚。时刻B 属于 binglog 完整，所以直接提交。


### 相关参数

+ redolog 用于保证 crash-safe 能力。``innodb_flush_log_at_trx_commit`` 这个参数设置成 1 的时候，表示每次事务的 redolog 都直接持久化到磁盘。这个参数建议设置成 1，这样可以保证 MySQL 异常重启之后数据不丢失。
+ ``sync_binlog`` 这个参数设置成 1 的时候，表示每次事务的 binlog 都持久化到磁盘。这个参数也建议设置成 1，这样可以保证 MySQL 异常重启之后 binlog 不丢失。



## 扩展

#### MySQL 如何知道 binlog 是否完整？

一个事务的 binlog 是有完整格式：

+ statement 格式的 binlog，最后会有 COMMIT；

+ row 格式的 binlog，最后会有一个 XID event。

  另外，在 MySQL 5.6.2 版本以后，还引入了 binlog-checksum 参数，用来验证 binlog 内容的正确性。对于 binlog 日志由于磁盘原因，可能会在日志中间出错的情况，MySQL 可以通过校验 checksum 的结果来发现。所以，MySQL 还是有办法验证事务 binlog 的完整性的。

#### redo log 和 binlog 如何关联起来？

它们有一个共同的数据字段，叫 **XID**。崩溃恢复的时候，会按顺序扫描 redo log：

+ 如果碰到既有 prepare、又有 commit 的 redo log，就直接提交；
+ 如果碰到只有 parepare、而没有 commit 的 redo log，就拿着 XID 去 binlog 找对应的事务。

#### redo log 一般设置多大？

redolog 太小的话，会导致很快就被写满，然后不得不强行刷 redolog，这样 WAL 机制的能力就发挥不出来了。

所以，如果是现在常见的几个 TB 的磁盘的话，可以直接将 redolog 设置为 4 个文件、每个文件 1GB。

#### 数据写入后的最终落盘，是从 redo log 还是从 buffer pool 更新过来的？

实际上，redo log 并没有记录数据页的完整数据，所以它并没有能力自己去更新磁盘数据页，也就不存在由 redolog 更新过去的情况。

1. 正常运行的实例，数据页被修改后，跟磁盘的数据页不一致，称为**脏页**。最终数据落盘，就是把内存中的数据页写盘。这个过程与 redolog 无关。
2. 在崩溃恢复场景中，InnoDB 如果判断到一个数据页可能在崩溃恢复的时候丢失了更新，就会将它读到内存，然后让 redolog 更新内存内容。更新完成后，内存页变成脏页，就回到了情况1。

#### redo log buffer 是什么？是先修改内存，还是先写 redo log 文件？

如果一个事务要往两个表中插入记录，插入数据的过程中，生成的日志都得先保存起来，但又不能在还没 commit 的时候就直接写到 redolog 文件里。

redolog buffer 就是一块内存，用来先存 redo 日志的。也就是说，在执行第一个 insert 的时候，数据的内存被修改了，redolog buffer 也写入了日志。但是，真正把日志写到 redolog 文件（文件名是 ib_logfile+ 数字），是在执行 commit 语句的时候。

单独执行一个更新语句的时候，InnoDB 会启动一个事务，在语句执行完成的时候提交。过程同上，只不过是“压缩”到了一个语句里面完成。