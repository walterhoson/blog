---
title: MySQL 如何应急提高性能
description: 分析如何使用应急方案解决 MySQL 性能。
toc: true
authors: 
    - WayneShen
tags: 
    - MySQL
    - Notes
categories: 
    - DataBase
series: []
date: '2020-08-28T23:50:+08:00'
lastmod: '2020-08-28T23:50:20+08:00'
draft: true
---

</br>

分析如何使用应急方案解决 MySQL 性能。

<!--more-->

## 短连接过多

正常的短连接模式是连接到数据库后，执行很少的 SQL 语句就断开，下次需要的时候再重连。如果使用的是短连接，在业务高峰期的时候，比如一旦数据库处理的慢一些，就可能出现连接数突然暴涨的情况。

MySQL 建立连接的过程成本很高。除了正常的网络连接三次握手外，还需要做登录权限判断和获得这个连接的数据读写权限。

**max_connections** 参数用来控制一个 MySQL 实例同时存在的连接数的上限，超过这个值，系统就会拒绝接下来的连接请求，并报错提示“Too many connections”。对于被拒绝连接的请求来说，从业务角度看就是数据库不可用。若机器负载比较高的时候，处理现有请求的时间变长，每个连接保持的时间也更长。这时，再有新建连接的话，就可能会超过限制。可以增大 max_connections，但有风险。**该值涉及用来保护 MySQL 的，一味的加大，适得其反**，让更多连接进来，会浪费更多时间在登陆验证上，增大系统负担，导致已连接的线程拿不到 CPU 资源去执行。

### 1. 先处理掉那些占着连接但不工作的线程（有损）

对于那些不需要保持的连接，可以通过 kill connection 主动踢掉。这个行为跟设置 wait_timeout 的效果一样。**设置 wait_timeout 参数表示的是，一个线程空闲 wait_timeout 秒之后，就会被 MySQL 直接断开连接**。

优先断开事务外空闲太久的连接；如果还不够，再考虑断开事务内空闲太久的连接，会造成未提交事务的回滚。

1. 通过 show processlist 查看 sleep 的线程及 id
2. 通过 ``select * from information_schema.inndb_trx`` 查看 trx_mysql_thread_id（表示该线程 id 仍在事务中）
3. kill connection 12345（thread id），此时这个客户端并不会马上知道。直到客户端在发起下一个请求的时
   候，才会收到这样的报错“ERROR 2013 (HY000): Lost connection to MySQL server during query”。

从数据库端主动断开连接可能是有损的，尤其是有的应用端收到这个错误后，不重新连接，而是直接用这个已经不能用的句柄重试查询。这会导致从应用端看上去，“MySQL 一直没恢复”。

### 2. 减少连接过程的消耗

如果现在数据库确认是被连接行为打挂了，那么可以让数据库跳过权限验证阶段。方法为：重启数据库，并使用–skip-grant-tables 参数启动。这样，整个 MySQL 会跳过所有的权限验证阶段，包括连接过程和语句执行过程在内。**若库外网可访问，风险极高**。MySQL 8.0 之后，启用 –skip-grant-tables 后表示数据库只能被本地客户端连接。

## 慢查询性能问题

### 1. 索引没有设计好

MySQL 5.6 之后，创建索引都支持 Online DDL，可以直接 alter table。理想情况是在备库执行，然后主备切换，再次执行。保险起见，考虑使用 gh-ost 工具。

### 2. 语句没写好

MySQL 5.7 提供了 query_rewrite 功能，可以把输入的一种语句改写成另外一种模式。

```sql
insert into query_rewrite.rewrite_rules(pattern, replacement, pattern_database) values ("select * from t where id + 1 = ?", "select * from t where id = ? - 1", "db1");

call query_rewrite.flush_rewrite_rules();
```

call query_rewrite.flush_rewrite_rules() 这个存储过程，是让插入的新规则生效，也就是所说的“查询重写”。

### 3. MySQL 选错了索引

应急方案，加上 force index ，强制走索引。

## QPS 突增问题

业务高峰或程序 bug，导致某个语句 QPS 暴增，可能导致 MySQL 压力过大。

如果因为新功能 bug 导致的，最理想的情况是先把功能下线，先让原有服务恢复。

# 小结

紧急处理手段包括：粗暴地拒绝连接和断开连接，通过重写语句来绕过一些坑的方法。首先要了解这些方法的风险。

作为业务开发需要尽量避免一些低效的方法，比如避免大量地使用短链接。同时也要知道连接异常断开是常有的事，代码中最好需要重连并重试机制。