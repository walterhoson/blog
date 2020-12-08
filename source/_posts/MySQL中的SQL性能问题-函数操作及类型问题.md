---
title: MySQL性能问题分析-函数操作及类型问题
date: 2020-10-09 23:20:10
tags: [MySQL,笔记]
description: 
read_more: 阅读全文
categories: MySQL
toc: true
---


分析条件字段函数操作、隐式类型转换对MySQL性能的影响
<!--more-->


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
)
ENGINE=InnoDB DEFAULT CHARSET=utf8;

```

## 条件字段函数操作

**对索引字段做函数操作，可能会破坏索引值的有序性，因此优化器就放弃走树搜索功能。**

### 例一

```sql
select count(*) from tradelog where month(t_modified)=7;
```

| id   | select_type | table    | type  | key        | key_len | ref  | rows | filtered | Extra                    |
| ---- | ----------- | -------- | ----- | ---------- | ------- | ---- | ---- | -------- | ------------------------ |
| 1    | SIMPLE      | tradelog | index | t_modified | 4       |      | 3    | 100      | Using where; Using index |

需要注意的是，优化器并不是要放弃使用这个索引。

在这个例子里，放弃了树搜索功能，优化器可以选择遍历主键索引，也可以选择遍历索引 t_modified，但对比索引大小后发现，索引 t_modified 更小，遍历这个索引比遍历主键索引来得更快。因此最终还是会选择索引 t_modified。

Explain解析

+ key=t_modified 表示使用了 t_modified 这个索引
+ 测试表数据中插入了 10 万行数据，rows=100335，说明这条语句扫描了整个索引的所有值
+ Extra 字段的 Using index， 表示使用了覆盖索引。也就是全索引扫描

SQL可以改为

```sql
select count(*) from tradelog where
	(t_modified >= '2016-7-1' and t_modified<'2016-8-1') or
	(t_modified >= '2017-7-1' and t_modified<'2017-8-1') or
	(t_modified >= '2018-7-1' and t_modified<'2018-8-1');
```

### 例二

```sql
select * from tradelog where id + 1 = 10000;
```

优化器在确实有“偷懒”行为，**即使是对于不改变有序性的函数，也不会考虑使用索引**。这个加 1 操作并不会改变有序性，但是优化器还是不能用 id 索引快速定位到 9999 这一行。所以，需要在写 SQL 语句的时候，手动改写成 where id = 10000 -1。

 

## 隐式类型转换

```sql
select * from tradelog where tradeid=110717;
```

explain 显示要走全表扫描，tradeid 字段类型为 varchar(32)，而输入却是整型，所以需要做类型转换。MySQL里的转换规则是**字符串和数字做比较的话，是将字符串转换成数字**。

对于优化器而言，等同于

```sql
select * from tradelog where CAST(tradid AS signed int) = 110717;
```



## 隐式字符编码转换

### 例一

```sql
select d.* from tradelog l, trade_detail d where d.tradeid = l.tradeid and l.id = 2;
```

Explain：

| id   | select_type | table | type  | possible_keys   | key     | key_len | ref   | rows | filtered | Extra       |
| ---- | ----------- | ----- | ----- | --------------- | ------- | ------- | ----- | ---- | -------- | ----------- |
| 1    | SIMPLE      | l     | const | PRIMARY,tradeid | PRIMARY | 4       | const | 1    | 100.00   |             |
| 1    | SIMPLE      | d     | ALL   | null            | null    | null    | null  | 11   | 100.00   | Using where |

+ tradelog 使用了主键索引，扫描一行获取到 id=2 的行
+ 第二行 key=null，表示没有用上 trade_detail 上的 tradeid 索引，进行了全表扫描
+ 此处，tradelog 表称为驱动表，trade_detail 称为被驱动表，tradeid 称为关联字段

trade_detail 中的 tradeid 字段明明有索引，但却没有用上，原因为步骤二sql其实为：

```sql
-- 被驱动表操作
select * from trade_detail where tradeid = $L2.tradeid.value;
-- $L2.tradeid.value 的字符集是 utf8mb4。等同于以下语句，而对索引字段做函数操作，优化器会放弃走树搜索
select * from trade_detail where CONVERT(traideid USING utf8mb4)=$L2.tradeid.value;
```

**字符集 utf8mb4 是 utf8 的超集**，所以**当这两个类型的字符串在做比较时，MySQL 内部是先把 utf8 字符串转成 utf8mb4 字符集再做比较**。（在程序设计语言里面，做自动类型转换的时候，为了避免数据在转换过程中由于截断导致数据错误，也都是 “按数据长度增加的方向” 进行转换的）。

所以在执行上面的语句的时候，需要将被驱动数据表里的字段一个个地转换成 utf8mb4， 再跟 L2 做比较。字符集不同只是条件之一，**连接过程中要求在被驱动表的索引字段上加函数操作**，是直接导致对被驱动表做全表扫描的原因。

#### 优化策略：

1. 把 trade_detail 表上的 tradeid 字段的字符集也改成 utf8mb4，这样就没有字符集转换的问题了

2. 如果数据量比较大， 或者业务上暂时不能做这个 DDL 的话，那就只能采用修改 SQL 语句的方法了。主动把l.tradeid转为utf8，避免被驱动表上的字符编码转换

   ```sql
   select d.* from tradelog l , trade_detail d where d.tradeid=CONVERT(l.tradeid USING utf8)
   ```


### 例二

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



## 总结：

+ 对索引字段做函数操作，可能会破坏索引值的有序性，因此优化器就决定放弃走树搜索功能。
+ 尽量使关联表的字符集保持一致
+ 所以对新的SQL语句explain是个好习惯