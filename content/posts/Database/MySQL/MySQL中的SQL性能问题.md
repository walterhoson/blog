---
title: MySQL 性能问题分析
description: 浅析 MySQL 性能问题，包括条件字段函数操作、隐式类型转换及类型问题，以及锁或索引带来的性能问题。
toc: true
authors: 
    - WayneShen
tags: 
    - MySQL
    - Notes
categories: 
    - DataBase
series: []
date: '2020-08-28T23:30:+08:00'
lastmod: '2020-08-28T23:30:20+08:00'
draft: false
---

</br>

浅析 MySQL 性能问题，包括条件字段函数操作、隐式类型转换、类型问题，以及锁或索引带来的性能问题。

<!--more-->

MySQL 本身就有很大的压力，DB 服务器 CPU 占用率很高或 ioutil（IO 利用率）很高，是导致 SQL 卡慢的最直接原因。

```sql
CREATE TABLE `tradelog` (
    `id` int(11) NOT NULL,
    `tradeid` varchar(32) DEFAULT NULL,
    `operator` int(11) DEFAULT NULL, 
    `t_modified` time DEFAULT NULL,
    PRIMARY KEY (`id`),
    KEY `tradeid` (`tradeid`),
    KEY `t_modified` (`t_modified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `trade_detail` (
    `id` int(11) NOT NULL,
    `tradeid` varchar(32) DEFAULT NULL,
    `trade_step` int(11) DEFAULT NULL, /* 操作步骤 */ 
    `step_info` varchar(32) DEFAULT NULL, /* 步骤信息 */ 
    PRIMARY KEY (`id`),
    KEY `tradeid` (`tradeid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
```

## 条件字段函数操作

**对索引字段做函数操作，可能会破坏索引值的有序性，因此优化器就放弃走树搜索功能。**

**例一**

```sql
select count(*) from tradelog where month(t_modified)=7;
```

| id   | select_type | table    | type  | key        | key_len | ref  | rows | filtered | Extra                    |
| ---- | ----------- | -------- | ----- | ---------- | ------- | ---- | ---- | -------- | ------------------------ |
| 1    | SIMPLE      | tradelog | index | t_modified | 4       |      | 3    | 100      | Using where; Using index |

需要注意的是，优化器并不是要放弃使用这个索引。

在此案例中，放弃了树搜索功能，优化器可以选择遍历主键索引，也可以选择遍历索引 t_modified，但对比索引大小后发现，索引 t_modified 更小，遍历这个索引比遍历主键索引来得更快。因此最终还是会选择索引 t_modified。

Explain 解析

+ `key=t_modified` 表示使用了 t_modified 这个索引
+ 测试表数据中插入了 10 万行数据，rows=100335，说明这条语句扫描了整个索引的所有值
+ Extra 字段的 `Using index`， 表示使用了覆盖索引，也就是全索引扫描

SQL 可以改为

```sql
select count(*) from tradelog where 
    (t_modified >= '2016-7-1' and t_modified<'2016-8-1') or
    (t_modified >= '2017-7-1' and t_modified<'2017-8-1') or
    (t_modified >= '2018-7-1' and t_modified<'2018-8-1');
```

**例二**

```sql
select * from tradelog where id + 1 = 10000;
```

优化器在确实有“偷懒”行为，**即使是对于不改变有序性的函数，也不会考虑使用索引**。

这个加 1 操作并不会改变有序性，但优化器还是不能用 id 索引快速定位到 9999 这一行。所以，需要在写 SQL 语句时，手动改写成 `where id = 10000 -1`。

## 隐式类型转换

```sql
select * from tradelog where tradeid = 110717;
```

explain 显示要走全表扫描，tradeid 字段类型为 varchar(32)，而输入却是整型，所以需要做类型转换。MySQL 里的转换规则是**字符串和数字做比较的话，是将字符串转换成数字**。

对于优化器而言，等同于：

```sql
select * from tradelog where CAST(tradid AS signed int) = 110717;
```

## 隐式字符编码转换

**例一**

```sql
select d.* from tradelog l, trade_detail d where d.tradeid = l.tradeid and l.id = 2;
```

Explain：

| id   | select_type | table | type  | possible_keys   | key     | key_len | ref   | rows | filtered | Extra       |
| ---- | ----------- | ----- | ----- | --------------- | ------- | ------- | ----- | ---- | -------- | ----------- |
| 1    | SIMPLE      | l     | const | PRIMARY,tradeid | PRIMARY | 4       | const | 1    | 100.00   |             |
| 1    | SIMPLE      | d     | ALL   | null            | null    | null    | null  | 11   | 100.00   | Using where |

+ tradelog 使用了主键索引，扫描一行获取到 `id=2` 的行
+ 第二行 key=null，表示没有用上 trade_detail 上的 tradeid 索引，进行了全表扫描
+ 此处，tradelog 表称为驱动表，trade_detail 称为被驱动表，tradeid 称为关联字段

trade_detail 中的 tradeid 字段明明有索引，但却没有用上，原因为步骤二 sql 其实为：

```sql
-- 被驱动表操作
select * from trade_detail where tradeid = $L2.tradeid.value;
-- $L2.tradeid.value 的字符集是 utf8mb4。等同于以下语句，而对索引字段做函数操作，优化器会放弃走树搜索
select * from trade_detail where CONVERT(traideid USING utf8mb4)=$L2.tradeid.value;
```

**字符集 utf8mb4 是 utf8 的超集**，所以**当这两个类型的字符串在做比较时，MySQL 内部是先把 utf8 字符串转成 utf8mb4 字符集再做比较**。（在程序设计语言里面，做自动类型转换时，为了避免数据在转换过程中由于截断导致数据错误，也都是“按数据长度增加的方向”进行转换的）。

所以在执行上面的语句时，需要将被驱动数据表里的字段一个个地转换成 utf8mb4， 再跟 L2 做比较。字符集不同只是条件之一，**连接过程中要求在被驱动表的索引字段上加函数操作**，是直接导致对被驱动表做全表扫描的原因。

**优化策略：**

1. 把 trade_detail 表上的 tradeid 字段的字符集也改成 utf8mb4，这样就没有字符集转换的问题了

2. 若数据量比较大，或者业务上暂时不能做这个 DDL 的话，那就只能采用修改 SQL 语句的方法了。主动把 l.tradeid 转为 utf8，避免被驱动表上的字符编码转换

```sql
select d.* from tradelog l, trade_detail d where d.tradeid=CONVERT(l.tradeid USING utf8)
```

**例二**

```sql
select l.operator from tradelog l, trade_detail d where d.tradeid=l.tradeid and d.id=4;
```

Explain:

| id   | select_type | table | type  | possible_keys | key     | key_len | ref   | rows | filtered | Extra |
| ---- | ----------- | ----- | ----- | ------------- | ------- | ------- | ----- | ---- | -------- | ----- |
| 1    | SIMPLE      | d     | const | PRIMARY       | PRIMARY | 4       | const | 1    | 100.00   |       |
| 1    | SIMPLE      | l     | ref   | tradeid       | tradeid | 131     | const | 1    | 100.00   |       |

+ trade_detail 表成了驱动表，tradelog 成了被驱动表
+ 第二行显示，这次查询用上了被驱动表 tradelog 里的索引 (tradeid)，扫描行数是 1

```sql
-- 被驱动表操作
select operator from tradelog where traideid =$R4.tradeid.value;
-- 等同于，$R4.tradeid.value 的字符集是 utf8, 按照字符集转换规则，要转成 utf8mb4
select operator from tradelog where traideid =CONVERT($R4.tradeid.value USING utf8mb4);
```

**CONVERT 函数是加在输入参数上的，这样可以用上被驱动表的 traideid 索引。**

## 一行数据查询慢

大概率是表被锁住了，首先执行 `show processlist` 命令进行分析。

### 等 MDL 锁

show processlist 看到状态是，**Waiting for table metadata lock**。

该状态表示，现在有一个线程正在表上请求或持有 MDL 写锁，把 select 语句堵住了。比如线程通过 `lock table t write` 持有 MDL 锁。

解决方法，通过 `select blocking_pid from sys.schema_table_lock_waits`，查询造成阻塞的线程 pid，然后用 kill 命令杀掉。

### 等 flush

**Waiting for table flush**。当有 session 占用表，并一直处于打开状态，此时另一个线程要执行 `flush tables t`，关闭表 t 时，就需要等待上一个 session 结束，此时再有 session 读表 t 的话，就会被 flush 命令堵住，显示 `Waiting for table flush`。

flush 操作的逻辑是关闭打开的表，并加上一个读锁，直到显式地执行 `unlock tables`。该操作常用于数据备份，也就是将所有的脏页刷新到磁盘，然后对表加上读锁，此时拷贝数据文件就是安全的。

flush 可以针对一个表，也可以通过 `flush tables with read lock` 操作所有的表。

### 等行锁

```sql
select * from t where id=1 lock in share mode;
```

若执行到上述语句时，**当前行已经被加上了写锁并未释放，此时加读锁的操作就会被堵住**。

`show processlist` 显示 state 为 statistics，可以通过 `sys.innodb_lock_waits` 查到哪个线程占用写锁。

```sql
select * from t sys.innodb_lock_waits where locked_table=`'test'.'t'`
```

显示的信息很全，通过找到 **sql_kill_blocking_query**，内容显示 kill query x，表示停止 x 号线程正在执行的语句，但其实此方法无用，因为占用行锁的语句之前已经执行完了，现在 kill query 并不能让事务去掉行锁。

找到 **sql_kill_blocking_connection**，内容为 kill x，该语句有效，直接断开之前的连接，断开时，会自动会滚连接中正在执行的线程，也就释放了行锁。

## 其他原因查询慢

条件字段没有索引，导致语句只能走主键顺序扫描，一旦扫描行数过多，就表现为查询慢。

通过慢查询日志（show log），观察扫描行数 Rows_examined 和查询时间 Query_time 来进行判断。一般来说，线上配置超过 1 秒就算慢查询（set long_query_time）。

还有情况是直接查比加上 `lock in share mode` 读锁速度要慢。原因就是**加了读锁后是当前读，而不加是一致性读**。

举个例子，session A 开启事务（start transaction with consistent snapshot），此时 session B 对一行记录进行了1万条修改或自增（产生了1万个 undo log），然后 session A 开始查询，如果 session A 查询时开启读锁，直接进行当前读，读到 session B 结束的值，而如果不加读锁，因为要遵循一致性读，所以要将当前值倒退执行1万个 undo log，计算出最早的值，所以速度较慢。

## 参考资料

《MySQL 45 讲》