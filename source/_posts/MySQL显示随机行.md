---
title: MySQL显示随机行-深入理解排序
date: 2020-10-04 23:11:26
tags: [MySQL,note]
description: 将从显示随机行的需求切入，深入理解MySQL排序的原理、排序的流程，及排序的性能对比...
read_more: 阅读全文
categories: MySQL
toc: true
---

MySQL中如何从字典表中随机查出几个单词

## 内存临时表

### rand() 函数

<!--more-->

```sql
CREATE TABLE `words` (
	`id` int(11) NOT NULL AUTO_INCREMENT,
	`word` varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

select word from words order by rand() limit 3;
```

Explain.extra：Using temporary; Using filesort。表示需要使用临时表，并要在临时表上排序。

对于innoDB来说，执行全字段排序会减少磁盘访问，因此会被优先选择。而**对于内存表，回表过程只是简单地根据数据行的位置，直接访问内存得到数据，不会导致多访问磁盘**。优化器没有此顾虑，此时用于排序的行越小就会优先考虑，所以MySQL 这时就会选择 rowid 排序。

所以语句的执行流程为：

1. 创建一个临时表。该临时表用的是 memory 引擎，表里有两个字段，第一个是 double 类型，先记为 R，第二个是 varchar(64) 类型，记为 W。并且这个表没有建索引。
2. 从 words 表中，按主键顺序取出所有的 word 值。对于每一个 word 值，调用 rand() 函数生成一个大于 0 小于 1 的随机小数，并把这个随机小数和 word 分别存入临时表的 R 和 W 字段，到此扫描行数是 10000。
3. 此时临时表有 10000 行数据，接下来要在这个没有索引的内存临时表上，按照字段 R 排序。
4. 初始化 sort_buffer。sort_buffer 中有两个字段，double 类型和整型。
5. 从内存临时表中遍历取出 R 值和位置信息（rowid），分别存入 sort_buffer 中的两个字段里。这个过程要对内存临时表做全表扫描，此时扫描行数增加 10000，变为 20000。
6. 在 sort_buffer 中根据 R 的值进行排序。注意，此过程没有涉及到表操作，所以不会增加扫描行数。
7. 排序完成后，取出前三个结果的 rowid，到内存临时表中取出 word 值，返回给客户端。这个过程中，访问了表的三行数据，总扫描行数变为 20003。

通过慢查询日志（slow log）验证 Rows_examined=20003

![内存临时表排序](image-20201117165521326.png)

rowid（每个引擎用来唯一标识数据行的信息）：

+ 有主键的 InnoDB 表来说，rowid 就是主键 ID；
+ 没有主键的 InnoDB 表来说，rowid 是由系统生成的，长度为 6 字节的隐藏主键；
+ MEMORY 引擎不是索引组织表。在这个例子，可以认为就是一个数组。因此，这个 rowid 其实就是数组的下标。

所以，order by rand() 使用了内存临时表，内存临时表排序的时候使用了 rowid 排序方法。

## 磁盘临时表

并不是所有的临时表都是内存表，**tmp_table_size 这个配置限制了内存临时表的大小，默认值是 16M**。若临时表大小超过了 tmp_table_size，那么内存临时表就会转成磁盘临时表。

磁盘临时表使用的引擎默认是 InnoDB，是由参数 internal_tmp_disk_storage_engine 控制。当使用磁盘临时表时，对应的就是一个没有显式索引的 InnoDB 表的排序过程。

为了复现这个过程，可以把 tmp_table_size 设置成 1024，把 sort_buffer_size 设置成 32768,max_length_for_sort_data 设置成 16。

```shell
set tmp_table_size=1024;
set sort_buffer_size=32768;
set max_length_for_sort_data=16;
/* 打开 optimizer_trace，只对本线程有效 */
SET optimizer_trace='enabled=on';
/* 执行语句 */
select word from words order by rand() limit 3;
/* 查看 OPTIMIZER_TRACE 输出 */
SELECT * FROM `information_schema`.`OPTIMIZER_TRACE`\G
```

![OPTIMIZER_TRACE](image-20201117173508303.png)

因为将 max_length_for_sort_data 设置小于 word 字段的长度定义，所以看到sort_mode 里面显示的是 rowid 排序，这个是符合预期的，参与排序的是随机值 R 字段和 rowid 字段组成的行。R 字段存放的随机值就 8 个字节，rowid 是 6 个字节，数据总行数是 10000，这样算出来就有140000 字节，超过了 sort_buffer_size 定义的 32768 字节了。但是，number_of_tmp_files 的值居然是 0，没有用到临时文件。此SQL语句采用 MySQL 5.6 版本引入的一个新的排序算法，即：**优先队列排序算法**。

其实，现在的 SQL 语句，只需要取 R 值最小的 3 个 rowid。但若使用归并排序算法，虽然最终也能得到前 3 个值，但这个算法结束后，已经将 10000 行数据都排好序了。也就是说，后面的 9997 行也是有序的了。但其实并不需要这些数据是有序的。浪费了非常多的计算量。

### 优先队列算法

上面的例子中，可以精确地只得到三个最小值，执行流程如下：

1. 对于这 10000 个准备排序的 (R,rowid)，先取前三行，构造成一个堆；
2. 取下一个行 (R’,rowid’)，跟当前堆里面最大的 R 比较，如果 R’小于 R，把这个 (R,rowid) 从堆中去掉，换成 (R’,rowid’)；
3. 重复第 2 步，直到第 10000 个 (R’,rowid’) 完成比较。

![优先队列算法](image-20201117173907830.png)

模拟 6 个 (R,rowid) 行，通过优先队列排序找到最小的三个 R 值的行的过程。整个排序过程中，为了最快地拿到当前堆的最大值，总是保持最大值在堆顶，因此这是一个最大堆

上上图，OPTIMIZER_TRACE 结果中，**filesort_priority_queue_optimization 这个部分的 chosen=true，表示使用了优先队列排序算法**，这个过程不需要临时文件，因此 number_of_tmp_files 是 0。

```sql
select city,name,age from t where city='杭州' order by name limit 1000 ;
```

此语句没有用到优先队列排序算法，因为 limit 1000，如果使用优先队列算法的话，需要维护的堆的大小就是 1000 行的 (name,rowid)，超过了设置的 sort_buffer_size 大小，所以只能使用归并排序算法。

总之，不论是使用哪种类型的临时表，order by rand() 这种写法都会让计算过程非常复杂，需要大量的扫描行数，因此排序过程的资源消耗也会很大。

## 随机排序

### 随机算法1

先把问题简化一下，如果只随机选择 1 个 word 值，思路上是这样的：

1. 取得这个表的主键 id 的最大值 M 和最小值 N;
2. 用随机函数生成一个最大值到最小值之间的数 X = (M-N)*rand() + N;
3. 取不小于 X 的第一个 ID 的行。

执行语句的序列:

```sql
select max(id),min(id) into @M,@N from t ;
set @X= floor((@M-@N+1)*rand() + @N);
select * from t where id >= @X limit 1;
```

这个方法效率很高，因为取 max(id) 和 min(id) 都是不需要扫描索引的，而第三步的 select 也可以用索引快速定位，可以认为就只扫描了 3 行。但实际上，这个算法本身并不严格满足题目的随机要求，因为 ID 中间可能有空洞，因此选择不同行的概率不一样，不是真正的随机。

比如有 4 个 id，分别是 1、2、4、5，如果按照上面的方法，那么取到 id=4 的这一行的概率是取得其他行概率的两倍。如果这四行的 id 分别是 1、2、40000、40001 呢？这个算法基本就是 bug 了。

### 随机算法2

为了得到严格随机的结果，可以用下面这个流程:

1. 取得整个表的行数，并记为 C。
2. 取得 Y = floor(C * rand())。 floor 函数是为了取整数部分。
3. 再用 limit Y,1 取得一行。

下面这段代码，就是上面流程的执行语句的序列。

```sql
select count(*) into @C from t;
set @Y = floor(@C * rand());
set @sql = concat("select * from t limit ", @Y, ",1");
prepare stmt from @sql;
execute stmt;
DEALLOCATE prepare stmt;
```

MySQL 处理 limit Y,1 的做法就是按顺序一个个地读出来，丢掉前 Y 个，然后把下一个记录作为返回结果，因此需要扫描 Y+1 行。再加上，第一步扫描的 C 行，总共需要扫描 C+Y+1 行，执行代价比随机算法 1 的代价要高。

当然，随机算法2 跟直接 order by rand() 比起来，执行代价还是小很多。

### 随机算法3

如果按照这个表有 10000 行来计算的话，C=10000，要是随机到比较大的 Y 值，那扫描行数也跟 20000 差不多了，接近 order by rand() 的扫描行数，比随机算法2 的代价要小很多。按照随机算法 2 的思路，要随机取 3 个 word 值，可以这么做：

1. 取得整个表的行数，记为 C；
2. 根据相同的随机方法得到 Y1、Y2、Y3；
3. 再执行三个 limit Y, 1 语句得到三行数据

执行语句的序列

```sql
select count(*) into @C from t;
set @Y1 = floor(@C * rand());
set @Y2 = floor(@C * rand());
set @Y3 = floor(@C * rand());
select * from t limit @Y1，1； // 在应用代码里面取 Y1、Y2、Y3 值，拼出 SQL 后执行
select * from t limit @Y2，1；
select * from t limit @Y3，1；
```

## 总结

如果直接使用 order by rand()，这个语句需要 Using temporary 和 Using filesort，查询的执行代价往往比较大。所以，在设计的时候要量避开这种写法。

在实际应用的过程中，比较规范的用法就是：尽量将业务逻辑写在业务代码中，让数据库只做“读写数据”的事情。因此，这类方法的应用还是比较广泛的。