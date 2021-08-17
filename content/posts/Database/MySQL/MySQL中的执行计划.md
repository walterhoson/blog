---
title: MySQL 中的执行计划
description: 整理 MySQL 中的执行计划中的参数。
toc: true
authors: 
    - WayneShen
tags: 
    - MySQL
categories: 
    - DataBase
series: []
date: '2021-08-10T22:00:+08:00'
lastmod: '2021-08-10T22:00:20+08:00'
draft: false
---

</br>

整理 MySQL 中的执行计划中的参数。

<!--more-->

通过 Explain 可以分析出：

+ 表的读取顺序
+ 数据读取操作的操作类型
+ 可以被使用的索引
+ 实际被使用的索引
+ 表之间的引用
+ 每张表有多少行被优化器查询

## 语法

```sql explain <sql 语句>```

例如：

`explain select * from t3 where id=3952602`;

## 输出解释

```shell
+----+-------------+-------+-------+----------------+--------+---------+-------+------+-------+
| id | select_type | table | type  | possible_keys  | key    | key_len | ref   | rows | Extra |
+----+-------------+-------+-------+----------------+--------+---------+-------+------+-------+
```

### id

SQL 执行的顺利的标识，SQL 从大到小的执行。id 相同，则从结果从上到下执行

### select_type

select 类型，有以下几种：

**1. SIMPLE**：简单的 SELECT（不使用 UNION 或子查询等）
   
```sql
explain select * from t3 where id=3952602;
```

**2. PRIMARY**：可以理解为最外层的 select，查询中若包含任何复杂的子部分，最外层查询则被标记为 PRIMARY

```sql
explain select * from (select * from t3 where id=3952602) a ;
```

**3. UNION**：UNION 中的第二个或后面的 SELECT 语句

+ 若第二个 SELECT 出现在 UNION 之后，则被标记为 UNION；
+ 若 UNION 包含在 FROM 子句的子查询中，外层 SELECT 将被标记为：DERIVED

```sql
explain select * from t3 where id=3952602 union all select * from t3 ;
```

**4. DEPENDENT UNION**：UNION 中的第二个或后面的 SELECT 语句，取决于外面的查询

```sql
explain select * from t3 where id in (select id from t3 where id=3952602 union all select id from t3) ;
```

**5. UNION RESULT**：从 UNION 表获取结果的 SELECT

```sql
explain select * from t3 where id=3952602 union all select * from t3 ;
```

**6. SUBQUERY**：子查询中的第一个 SELECT，在 SELECT 或 WHERE 列表中包含了子查询

```sql
explain select * from t3 where id = (select id from t3 where id=3952602 ) ;
```

**7. DEPENDENT SUBQUERY**：子查询中的第一个 SELECT，取决于外面的查询

```sql
explain select id from t3 where id in (select id from t3 where id=3952602 ) ;
```

**8. DERIVED**：派生表的 SELECT(FROM 子句的子查询），在 FROM 列表中包含的子查询被标记为 DERIVED（衍生），MySQL 会递归执行这些子查询，把结果放在临时表中

```sql
explain select * from (select * from t3 where id=3952602) a ;
```

### table

表示当前执行的表。即这一行的数据是关于哪张表。

有时不是真实的表名字，看到的是 derivedx(x 是个数字，可以理解是第几步执行的结果）

```sql
explain select * from (select * from ( select * from t3 where id=3952602) a) b;
```

### type

这列很重要，显示连接使用了哪种类别，有无使用索引

从最好到最差的连接类型为 system > const > eq_ref > ref > range > index > ALL

**1. system**：是 const 联接类型的一个特例，表（系统表）仅有一行满足条件。

**2. const**：表最多有一个匹配行，它将在查询开始时被读取。因为仅有一行，在这行的列值可被优化器剩余部分认为是常数。const 表很快，因为它们只读取一次！

const 用于用常数值比较 PRIMARY KEY 或 UNIQUE 索引的所有部分时。即**通过索引一次就找到了结果，并匹配上一行**。

在下面的查询中，tbl_name 可以用于 const 表：

```sql
explain select * from (select * from t3 where id = 1) d3;
+----+-------------+----------+--------+---------------+---------+---------+------+------+-------+
| id | select_type | table    |  type  | possible_keys | key     | key_len | ref  | rows | Extra |
| 1  | PRIMARY     |<derived2>| system | NULL          | NULL    | NULL    | NULL |      |       |
| 2  | DERIVED     | t3       |  type  | conts         | PRIMARY | 4       |      |      |       |
+----+-------------+----------+-------+----------------+---------+---------+------+------+-------+
```

**3. eq_ref**：

唯一性索引扫描，对于每个索引键，表中只有**一条记录与之匹配**。常见于主键或唯一索引扫描，比如主键的关联查询。

**4. ref**：

非唯一性索引扫描，返回匹配某个单独值的所有行，本质上也是一种**索引访问**，**返回所有匹配某个单独值的行**，然而，它可能会找到多个符合条件的行，所以他应该属于查找和扫描的混合体。

ref 可以用于使用=或<=>操作符的带索引的列。

在下面的例子中，MySQL 可以使用 ref 联接来处理 ref_tables：

```sql
create index idx_t3_id on t3(name);
explain select * from t3 where name="zhangsan";
```

**5. ref_or_null**：

该联接类型如同 ref，但添加了 MySQL 可以专门搜索包含 NULL 值的行。在解决子查询中经常使用该联接类型的优化。

在下面的例子中，MySQL 可以使用 ref_or_null 联接来处理 ref_tables：

```sql
SELECT * FROM ref_table WHERE key_column=expr OR key_column IS NULL;
```

**6. index_merge**：

该联接类型表示使用了索引合并优化方法。在这种情况下，key 列包含了使用的索引的清单，key_len 包含了使用的索引的最长的关键元素。

```sql
explain select * from t4 where id=3952602 or accountid=31754306 ;
```

**7. unique_subquery**：

该类型替换了下面形式的 IN 子查询的 ref：

```sql
value IN (SELECT primary_key FROM single_table WHERE some_expr)
```

unique_subquery 是一个索引查找函数，可以完全替换子查询，效率更高。

**8. index_subquery**：

该联接类型类似于 unique_subquery。可以替换 IN 子查询，但只适合下列形式的子查询中的非唯一索引：

```sql
value IN (SELECT key_column FROM single_table WHERE some_expr)
```

**9. range**：

只检索给定范围的行，使用一个索引来选择行。key 列显示使用了哪个索引。key_len 包含所使用索引的最长关键元素。在该类型中 ref 列为 NULL。

当使用=、<>、>、>=、<、<=、IS NULL、<=>、BETWEEN 或 IN 操作符，用常量比较关键字列时，可以使用 range。

这种范围扫描索引比全表扫描要好，因为它只需要开始于索引的某一点，而结束于另一点，不用扫描全部索引。

```sql
explain select * from t3 where id in (1,2,3);
```

**10. index**：

Full Index Scan。Index 与 All 区别为 index 类型只遍历索引树。这通常比 ALL 快，因为索引文件通常比数据文件小。

也就是说虽然 all 和 Index 都是读全表，但 index 是从索引中读取的，而 all 是从硬盘读取的。

当查询只使用作为单索引一部分的列时，MySQL 可以使用该联接类型。

**11. ALL**：

Full Table Scan，将遍历全表以找到匹配的行。

对于每个来自于先前的表的行组合，**进行完整的表扫描**。若表是第一个没标记 const 的表，这通常不好，并且通常在它情况下很差。通常可以增加更多的索引而不要使用 ALL，使得行能基于前面的表中的常数值或列值被检索出。

### possible_keys
   
possible_keys 列指出 MySQL 能使用哪个索引在该表中找到行。注意，该列完全独立于 EXPLAIN 输出所示的表的次序。这意味着在 possible_keys 中的某些键实际上不能按生成的表次序使用。

如果该列是 NULL，则没有相关的索引。在这种情况下，可以通过检查 WHERE 子句看是否它引用某些列或适合索引的列来提高你的查询性能。如果是这样，创造一个适当的索引并且再次用 EXPLAIN 检查查询

### key

key 列显示 MySQL 实际决定使用的键（索引）。若没有选择索引，键是 NULL。要想强制 MySQL 使用或忽视 possible_keys 列中的索引，在查询中使用 FORCE INDEX、USE INDEX 或者 IGNORE INDEX。

### key_len

key_len 列显示 MySQL 决定使用的键长度。如果键是 NULL，则长度为 NULL。
   
使用的索引的长度。在不损失精确性的情况下，长度越短越好。索引最大长度是 768 字节。

### ref

ref 列显示使用哪个列或常数与 key 一起从表中选择行。常见的有：const（常量），func，NULL，字段名（例：film.id）

### rows

rows 列显示 MySQL 认为它执行查询时必须检查的行数，注意这个不是结果集里的行数。

### filtered

显示了通过条件过滤出的行数的百分比估计值。

### extra

该列包含 MySQL 解决查询的详细信息，下面详细

1. Distinct：一旦 MYSQL 找到了与行相联合匹配的行，就不再搜索了。

2. Not exists：MYSQL 优化了 LEFT JOIN，一旦它找到了匹配 LEFT JOIN 标准的行，就不再搜索了

3. Range checked for each：Record（index map:#）没有找到理想的索引，因此对于从前面表中来的每一个行组合，MYSQL 检查使用哪个索引，并用它来从表中返回行。这是使用索引的最慢的连接之一

4. Using filesort：看到这个时，查询**需要优化**了。MYSQL 需要进行额外的步骤来发现如何对返回的行排序。它根据连接类型以及存储排序键值和匹配条件的全部行的行指针来排序全部行。可使用索引优化

5. Using index：列数据是从仅仅使用了索引中的信息而没有读取实际的行动的表返回的，这发生在对表的全部的请求列都是同一个索引的部分的时候，性能高的表现。

6. Using temporary：看到这个时，查询**需要优化**了。这里，MYSQL 需要创建一个临时表来存储结果，这通常发生在对不同的列集进行 ORDER BY 上，而不是 GROUP BY 上。可使用索引优化

7. Using where：Server 将在存储引擎检索行后再进行过滤。就是先读取整行数据，再按 where 条件进行检查，符合就留下，不符合就丢弃
   
8. Using join buffer：表明使用了连接缓存，比如说在查询时，多表 join 的次数非常多，那么将配置文件中的缓冲区的 join buffer 调大一些