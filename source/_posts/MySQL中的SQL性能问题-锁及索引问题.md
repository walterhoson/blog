---
title: MySQL性能问题分析-锁及索引问题
date: 2020-10-15 22:10:39
tags: [MySQL,笔记]
description: 
read_more: 阅读全文
categories: MySQL
toc: true
---


MySQL 数据库本身就有很大的压力，导致数据库服务器 CPU 占用率很高或 ioutil（IO 利用率）很高，是导致SQL卡慢的最直接原因。

## 查询长时间不返回

大概率是表被锁住了，首先执行 show processlist 命令进行分析。

<!--more-->

### 等MDL锁

show processlist 看到状态是，**Waiting for table metadata lock**。该状态表示，现在有一个线程正在表上请求或持有 MDL 写锁，把 select 语句堵住了。比如线程通过 lock table t write 持有MDL 锁。

解决方法，通过 select blocking_pid from sys.schema_table_lock_waits，查询造成阻塞的线程pid，然后用kill 命令杀掉。

### 等 flush

 **Waiting for table flush**。当有 session 占用表，并一直处于打开状态，此时另一个线程要执行 flush tables t，关闭表 t 时，就需要等待上一个 session 结束，此时再有 session 读表 t 的话，就会被 flush 命令堵住，显示 Waiting for table flush。

flush 操作的逻辑是关闭打开的表，并加上一个读锁，直到显示地执行 unlock tables。该操作常用于数据备份，也就是将所有的脏页刷新到磁盘，然后对表加上读锁，此时拷贝数据文件就是安全的。

flush 可以针对一个表，也可以通过 flush tables with read lock 操作所有的表。

### 等行锁

```sql
select * from t where id=1 lock in share mode;
```

如果执行到上述语句时，**当前行已经被加上了写锁并未释放，此时加读锁的操作就会被堵住**。

show processlist 显示 state 为 statistics，可以通过 sys.innodb_lock_waits 查到哪个线程占用写锁。

```sql
select * from t sys.innodb_lock_waits where locked_table=`'test'.'t'`
```

 显示的信息很全，通过找到 **sql_kill_blocking_query** ，内容显示 kill query x，表示停止 x 号线程正在执行的语句，但其实此方法无用，因为占用行锁的语句之前已经执行完了，现在kill query 并不能让事务去掉行锁。

找到 **sql_kill_blocking_connection**，内容为 kill x，这个语句有效，直接断开之前的连接，断开时，会自动会滚连接中正在执行的线程，也就释放了行锁。

## 查询慢

条件字段没有索引，导致语句只能走主键顺序扫描，一旦扫描行数过多，就表现为查询慢。

通过慢查询日志（show log），观察扫描行数 Rows_examined 和查询时间 Query_time 来进行判断。一般来说，线上配置超过1秒就算慢查询（set long_query_time）。

还有情况是直接查比加上 lock in share mode 读锁 速度要慢。原因就是**加了读锁后是当前读，而不加是一致性读**。举个例子，session A 开启事务，此时 session B 对一行记录进行了1万条修改或自增（产生了1万了undo log），然后 session A 开始查询，如果 session A 查询是开启读锁，直接进行当前读，读到 session B 结束的值，而如果不加读锁，因为要遵循一致性读，所以要将当前值倒退执行1万个undo log，计算出最早的值，所以速度较慢。



