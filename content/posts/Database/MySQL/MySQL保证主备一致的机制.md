---
title: MySQL 保证主备一致的机制
description: 主要分析 MySQL 是如何保证主备的数据一致。
toc: true
authors: 
    - WayneShen
tags: 
    - MySQL
    - Notes
categories: 
    - DataBase
series: []
date: '2020-08-29T07:51:+08:00'
lastmod: '2020-08-29T07:51:20+08:00'
draft: false
---

</br>
 
主要分析 MySQL 是如何保证主备的数据一致。

<!--more-->

## MySQL 主备的基本原理

binlog 除了用来归档，也可以用来做主备同步。

基本的主备切换流程

![master_slave](../../../assets/MySQL保证主备一致的机制/master_slave.png)

在状态 1 中，客户端的读写都直接访问节点 A，而节点 B 是 A 的备库，只是将 A 的更新都同步过来，到本地执行。这样可以保持节点 B 和 A 的数据是相同的。当需要切换时，就切成状态 2。此时客户端读写访问的都是节点 B，而节点 A 是 B 的备库。

在状态 1 中，虽然节点 B 没有被直接访问，但依然建议把节点 B（也就是备库）设置成只读（readonly）模式。（readonly 设置对 super 权限用户无效，而用于同步更新的线程拥有超级权限）这样做，有以下几个考虑：

1. 有时一些运营类的查询语句会被放到备库上去查，设置为只读可以防止误操作；
2. 防止切换逻辑有 bug，比如切换过程中出现双写，造成主备不一致；
3. 可以用 readonly 状态，来判断节点的角色

图为 **节点 A 到 B 的内部流程**

![process](../../../assets/MySQL保证主备一致的机制/process.png)

图中包含了 binlog 和 redo log 的写入机制相关，可以看到：主库接收到客户端的更新请求后，执行内部事务的新逻辑，同时写 binlog。

备库 B 跟主库 A 之间维持了一个长连接。主库 A 内部有一个线程，专门用于服务备库 B 的这个长连接。一个事务日志同步的完整过程是这样的：

1. 在备库 B 上通过 change master 命令，设置主库 A 的 IP、端口、用户名、密码，以及要从哪个位置开始请求 binlog，这个位置包含文件名和日志偏移量。
2. 在备库 B 上执行 start slave 命令，此时备库会启动两个线程，就是图中的 io_thread 和 sql_thread。其中 io_thread 负责与主库建立连接。
3. 主库 A 校验完用户名、密码后，开始按照备库 B 传过来的位置，从本地读取 binlog，发给 B。
4. 备库 B 拿到 binlog 后，写到本地文件，称为中转日志（relay log）。
5. sql_thread 读取中转日志，解析出日志里的命令，并执行。

后来由于多线程复制方案的引入，**sql_thread 演化成为了多个线程**。

## binlog 的三种格式对比

binlog 有两种格式，一种是 statement，一种是 row。第三种格式，叫作 mixed，其实它就是前两种格式的混合。

执行以下语句：

```sql
delete from t /*comment*/ where a>=4 and t_modified<='2018-11-10' limit 1
```

### statement 格式

当 `binlog_format=statement` 时，**binlog 里记录的是 SQL 语句的原文**。可以用以下命令看 binlog 中的内容。

```sql
show binlog events in 'master.000001';
```

![binlog_event](../../../assets/MySQL保证主备一致的机制/binlog_event.png)

+ 第一行 `SET @@SESSION.GTID_NEXT='ANONYMOUS’` （用于主备切换？)
+ 第二行是一个 BEGIN，跟第四行的 commit 对应，表示中间是一个事务；
+ 第三行是真实执行的语句。在真实执行命令之前，还有一个“use 'test' ”命令。这条命令不是主动执行的，而是 MySQL 根据当前要操作的表所在的数据库，自行添加的。这样做可以保证日志传到备库去执行时，不论当前的工作线程在哪个库里，都能够正确地更新到 test 库的表 t。命令之后的 delete 语句，就是输入的 SQL 原文。可以看到，binlog“忠实”地记录了 SQL 命令，甚至连注释也一并记录了。
+ 最后一行是一个 COMMIT。可以看到里面写着 xid=61。（xid 用于崩溃恢复时，去 binlog 中查找完整的事务）

这条 delete 产生了一个 warning，通过``show warnings;``可以得到。原因是当前 binlog 设置为 statement 格式，并且语句中有 limit，这个命令可能是 unsafe 的。**delete 带 limit，可能出现主备数据不一致的情况**。（匹配多行，只删除一行，可能主备库中通过不同索引，匹配出来的首行不一样）MySQL 认为是有风险的。

补充：

GTID（global transaction id）是对于一个已提交事务的编号，并且是一个全局唯一的编号。GTID 实际上是由 UUID + TID 组成的，其中 UUID 是 MySQL 实例的唯一标识, TID 表示该实例上已经提交的事务数量，并且随着事务提交单调递增，这种方式保证事务在集群中有唯一的ID，强化了主备一致及故障恢复能力。


### row 格式

当 `binlog_format= row` 时，binlog 中没有 SQL 语句原文，变为了 event：Table_map 和 Delete_rows。

![binlog_row](../../../assets/MySQL保证主备一致的机制/binlog_row.png)

BEGIN 和 COMMIT 与 statement 一致。

1. Table_map event，用于说明接下来要操作的表是 test 库的表 t；
2. Delete_rows event，用于定义删除的行为

图中看不到详细信息借助 mysqlbinlog 工具查看。

由于事务的 binlog 是从 8900 位置开始的，可以通过 start-position 参数指定从这个位置开始解析``mysqlbinlog -vv data/master.000001 --start-position=8900;``

![mysqlbinlog](../../../assets/MySQL保证主备一致的机制/mysqlbinlog.png)

+ server id 1，表示这个事务是在 `server_id=1` 的这个库上执行的。
+ 每个 event 都有 CRC32 的值，这是因为把参数 binlog_checksum 设置成了 CRC32。
+ Table_map event 跟在上上图中看到的相同，显示了接下来要打开的表，map 到数字 226。现在这条 SQL 语句只操作了一张表，如果要操作多张表，每个表都有一个对应的 Table_map event、都会 map 到一个单独的数字，用于区分对不同表的操作。
+ 在 mysqlbinlog 的命令中，使用了 -vv 参数是为了把内容都解析出来，所以从结果里面可以看到各个字段的值（比如，@1=4、 @2=4 这些值）。
+ binlog_row_image 的默认配置是 FULL，因此 Delete_event 里面，包含了删掉的行的所有字段的值。如果把 binlog_row_image 设置为 MINIMAL，则只会记录必要的信息，在这个例子里，只会记录 id=4 这个信息。
+ 最后的 Xid event，用于表示事务被正确地提交了。

使用 row 格式时，binlog 里面记录了真实删除行的主键 id，这样 binlog 传到备库去的时候，就肯定会删除 id=4 的行，不会有主备删除不同行的问题。

现在越来越多的场景要求把 MySQL 的 binlog 格式设置成 row。最直接的好处：**恢复数据**。

+ delete：row 格式 binlog 会把被删除的整行保存起来，若发现删错了，将 delete 转为 insert 语句，就可以恢复；
+ insert：binlog 记录所有字段信息，通过精确定位到刚刚插入的行，转为 delete，删除即可；
+ update：binlog 中会记录修改前整行数据和修改后的整行数据，只需要把 event 前后两行信息对调一下，就可以恢复。

### mixed 格式

mixed 格式的 binlog 存在的场景

+ statement 格式可能会导致主备不一致，row 格式不会
+ **row 格式缺点是很占用空间**，比如删除 10 万行数据，statement 格式是记录 SQL，只占用即使字节空间，但 row 格式，要把 10 万条记录都写到 binlog。不仅占用空间，同时写 binlog 还耗费 IO 资源，影响执行速度。
+ MySQL 取了折中方案，mixed 格式是 MySQL 自己判断这条 SQL 会不会导致主备不一致，如果有可能（如 limit，now() ），就是用 row 格式，否则使用 statement。

线上环境至少使用 mixed。

## 重放 binlog

由于有些语句执行结果依赖上下文命令，直接执行可能导致结果错误。

恢复数据的标准做法是，用 mysqlbinlog 工具解析出来，然后把解析结果整个发给 MySQL 执行。类似下面的命令：
 
```sql
mysqlbinlog master.000001 --start-position=2738 --stop-position=2942 | mysql -u user -p
```

意思是，将 master.000001 文件里面从第 2738 字节到第 2942 字节中间这段内容解析出来，放到 MySQL 去执行。

## 循环复制问题

生产上使用比较多的是 双 M 结构

![double_master](../../../assets/MySQL保证主备一致的机制/double_master.png)

双 M 结构和 M-S 结构，其实区别只是多了一条线，即：**节点 A 和 B 之间总是互为主备关系**。这样在切换的时候就不用再修改主备关系。

但，双 M 结构还有一个问题需要解决：

业务逻辑在节点 A 上更新了一条语句，然后再把生成的 binlog 发给节点 B，节点 B 执行完这条更新语句后也会生成 binlog。（建议把参数 `log_slave_updates` 设置为 on，表示备库执行 relay log 后生成 binlog）。那么，若节点 A 同时是节点 B 的备库，相当于又把节点 B 新生成的 binlog 拿过来执行了一次，然后节点 A 和 B 间，会不断地循环执行这个更新语句，也就是循环复制了。

**解决循环复制：MySQL 在 binlog 中记录了这个命令第一次执行时所在实例的 server id。**

1. 规定两个库的 server id 必须不同，若相同，则它们之间不能设定为主备关系；
2. 一个备库接到 binlog 并在重放的过程中，生成与原 binlog 的 server id 相同的新的 binlog；
3. 每个库在收到从自己的主库发过来的日志后，先判断 server id，如果跟自己的相同，表示这个日志是自己生成的，就直接丢弃这个日志。

这样的逻辑下，双 M 结构，日志的执行流就会变成这样：
1. 从节点 A 更新的事务，binlog 里面记的都是 A 的 server id；
2. 传到节点 B 执行一次以后，节点 B 生成的 binlog 的 server id 也是 A 的 server id；
3. 再传回给节点 A，A 判断到这个 server id 与自己的相同，就不会再处理这个日志。所以，死循环在此就断掉了。

## 参考资料

《MySQL 45 讲》