---
title: MySQL 中 OrderBy 工作原理
description: 浅析 MySQL 中 order by 的基本实现原理。
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

浅析 MySQL 中 order by 的基本实现原理。

<!--more-->

## 全字段排序

给字段加上索引，避免全表扫描。在排序时，执行计划中 **Extra 中显示 “Using filesort” 表示需要排序**，MySQL 会给每个线程分配一块内存用于排序，称为 **sort_buffer**。

语句的执行流程如下：

1. 初始化 sort_buffer，确定放入要查询的字段；
2. 从 where 条件字段的索引上找到满足条件的主键 id；
3. 从主键 id 索引取出整行，取要查询的字段的值，存入 sort_buffer 中；
4. 从排序字段的索引树上，找到下一个记录的主键 id；
5. 重复 3，4 直到条件字段不在满足条件；
6. 对 sort_file 中的数据按照排序字段做快速排序；
7. 按照排序结果取 limit 行返回给客户端（若有 limit）。

```sql
select city,name,age from T where city = '杭州' order by name limit 1000;
```

![全字段排序](../../../assets/MySQL中OrderBy工作原理/fullField.png)

排序动作可能在内存中完成，也可能需要使用外部排序，这**取决于排序所需的内存和参数 `sort_buffer_size`**，该参数是 MySQL 为排序开辟的内存（`sort_buffer`）的大小。

如果要排序的数据量小于 `sort_buffer_size`，排序就在内存中完成。但如果排序数据量太大，内存放不下，则不得不利用磁盘临时文件辅助排序。

可以通过一下流程记录扫描的行数

```sql
-- 打开 optimizer_trace，只对本线程有效
SET optimizer_trace='enabled=on'; 
-- @a 保存 Innodb_rows_read 的初始值
select VARIABLE_VALUE into @a from performance_schema.session_status where variable_name = 'Innodb_rows_read';
-- 执行语句
select city,name,age from t where city = '杭州' order by name limit 1000; 
-- 查看 OPTIMIZER_TRACE 输出
SELECT * FROM `information_schema`.`OPTIMIZER_TRACE`\G
-- @b 保存 Innodb_rows_read 的当前值 
select VARIABLE_VALUE into @b from performance_schema.session_status where variable_name = 'Innodb_rows_read';
-- 计算 Innodb_rows_read 差值，也就是一共扫描的行数 
select @b-@a;
```

该方法通过查看 `OPTIMIZER_TRACE` 的结果来确认，可以从 `number_of_tmp_files` 中看到是否使用了临时文件。

![OPTIMIZER_TRACE](../../../assets/MySQL中OrderBy工作原理/optimizer_trace.png)

### number_of_tmp_files

该参数表示排序过程中使用的临时文件数。这里使用了 12 个文件，因为在内存放不下时，就需要使用外部排序，外部排序一般使用归并排序算法。可以理解为，MySQL 将需要排序的数据分成 12 份，每一份单独排序后存在这些临时文件中。然后把这 12 个有序文件再合并成一个有序的大文件。

若 `sort_buffer_size` 超过了需要排序的数据量的大小，`number_of_tmp_files` 就是 0，表示排序可以直接在内存中完成。否则就要通过临时文件排序。`sort_buffer_size` 越小，需要分成的份数越多，`number_of_tmp_files` 值就越大。

### examined_rows

该参数表示参与排序的行数。也就是满足 where 条件的行数。

### sort_mode

该参数中 **`packed_additional_fields` 表示排序过程对字符串做了“紧凑”处理**。即使 name 字段的定义是 varchar(16)，在排序过程中还是要按照实际长度来分配空间的。

这里需要注意的是，为了避免对结论造成干扰，把 `internal_tmp_disk_storage_engine` 设置成 MyISAM。否则 `select @b-@a` 的结果会显示为 4001。因为查询 OPTIMIZER_TRACE 这个表时，需要用到临时表，而 `internal_tmp_disk_storage_engine` 的默认值是 InnoDB。若使用 InnoDB，把数据从临时表取出来的时候，会让 Innodb_rows_read 的值加 1。

## rowid 排序

针对全字段排序，只对原表的数据读了一遍，如果查询要返回的字段很多的话，sort_buffer 里要放的字段数太多，内存中同时能放下的行数就很少，要分成多个临时文件，排序性能变差。

```sql
SET max_length_for_sort_data = 16;
```

**max_length_for_sort_data** 是 MySQL 中专门控制用于排序的行数据长度的参数。如果单行的长度超过这个值，MySQL 就认为单行太大，要换一个算法。

新的算法，放入 sort_buffer 的字段，只有要排序的列和主键 id，此时就少了结果列字段的值。流程变成了：

1. 初始化 sort_buffer，确定放入两个字段，即 排序列 和 id；
2. 从 where 条件字段的索引找到第一个满足条件的主键 id；
3. 到主键索引取出整行，取排序字段和主键 id 存入 sort_buffer 中（若条件字段索引已存在排序字段即可减少本次回表操作?）；
4. 从条件字段的索引取下一个记录的主键 id；
5. 重复步骤 3、4 直到不满足条件为止；
6. 对 sort_buffer 中的数据按照排序字段进行排序；
7. 遍历排序结果，取前 limit 行，并按 id 的值回到原表中取出所有字段返回给客户端（不占用内存，直接返回）

![Rowid 排序](../../../assets/MySQL中OrderBy工作原理/rowid.png)

rowid 排序多访问了一次表的主键索引（步骤 7），因此 `select@b-@a` 的值变成 5000，因为处理排序，还有 limit 1000，所以多读 1000 行。examined_rows 表示用于排序的数据，所以仍是 4000。

OPTIMIZER_TRACE 的结果中

+ sort_mode 变成了 <sort_key, rowid>，表示参与排序的只有 name 和 id 这两个字段。
+ number_of_tmp_files 变成 10 了，是因为这时参与排序的行数虽然仍然是 4000 行，但每一行都变小了，因此需要排序的总数据量就变小了，需要的临时文件也相应地变少了。

## 全字段排序 VS rowid 排序

+ 若 MySQL 担心排序内存太小影响排序效率，才会采用 rowid 排序算法，这样排序过程中一次可以排序更多行，但需要再回表去取数据。
+ 若 MySQL 认为内存足够大，会优先选择全字段排序，把需要的字段都放到 sort_buffer 中，这样排序后就会直接从内存里返回查询结果了，不用再回原表取数据。

MySQL 的一个设计思想：**如果内存够，就要多利用内存，尽量减少磁盘访问**。

对于 InnoDB 表来说，**rowid 排序会要求回表多造成磁盘读**，因此不会被优先选择。而且 MySQL 做排序是一个成本比较高的操作，不排序就能得到正确的结果，那对系统的消耗会小很多，语句的执行时间也更短。

**比如使用联合索引**。where 条件字段和排序字段组成联合索引，可以保证条件字段相同的情况下，排序字段一定有序。此时排序不需要临时表，也不需要排序（Explain.Extra 中没有 Using filesort 了）。如此一来，流程就变成了：

1. 从联合索引（cond_field,sort_field）树上，找到 cond_field 满足条件的主键 id；
2. 到主键 id 索引取出整行，取出需要的结果字段，作为结果集的一部分直接返回。
3. 从联合索引上取下一个记录主键 id
4. 重复 2，3 步骤，直到查到 limit 行，或不满足 cond_field 条件时，循环结束。

![联合索引下的排序](../../../assets/MySQL中OrderBy工作原理/combation_sort.png)

再次优化，**使用覆盖索引，去除回表操作，性能上会快很多**。当然也需要权衡是否把语句中涉及到字段都建立联合索引，毕竟索引有维护代价。

## 参考资料

《MySQL 45 讲》