---
title: RocketMQ 源码分析-NameServer
description: 主要从源码层面分析 RocketMQ 中的 NameServer 模块的原理及实现逻辑。
toc: true
authors: 
    - WayneShen
tags: 
    - Middleware
    - RocketMQ
categories: 
    - Middleware
series: [RocketMQ]
date: '2021-07-03T11:40:00+08:00'
lastmod: '2021-07-03T11:45:20+08:00'
draft: false
---

</br>
主要从源码层面分析 RocketMQ 中的 NameServer 模块的原理及实现逻辑。

<!--more-->

## 设计思路

主要为了避免消息服务器的单点故障导致的整个系统瘫痪，通常会将多台消息服务器进行分布式部署，共同承担消息的存储。
当 Broker 分布式部署，就会遇到很多问题，比如生产者需要发送到哪台 Broker，消费者从哪台 Broker 消费。当某一台 Broker 宕机后，生产者与消费者如何自动感知。而 NameServer 就是为了解决以上问题设计的。

## 功能介绍

消息服务器 Broker 在启动的时向所有 NameServer 注册，Producer 在发送消息时之前先从 NameServer 获取 Broker 服务器地址列表，然后根据负载均衡算法从列表中选择一台服务器进行发送。

NameServer 与每台 Broker 保持长连接，并间隔 10s 检测 Broker 是否存活，若 Broker 持续 120s 都没有上报信息，NameServer 认为 Broker 宕机，之后则从路由注册表中删除，但是路由变化不会马上通知消息生产者。
这样设计的目的是为了降低 NameServer 实现的复杂度，在消息发送端提供容错机制保证消息发送的可用性。

NameServer 本身的高可用是通过部署多台 NameServer 来实现，但彼此之间不通讯，也就是 NameServer 服务器之间在某一个时刻的数据并不完全相同，但这对消息发送并不会造成任何影响，这也是 NameServer 设计的一个亮点，总之，RocketMQ 设计追求简单高效。

总结来说：
1. NameServer 相当于配置中心，维护 Broker 集群、Broker 信息、Broker 存活信息、主题与队列信息等。
2. NameServer 彼此之间不通信，每个 Broker 与集群内所有的 Nameserver 保持长连接。

## 源码分析

本系列基于目前 RocketMQ LTS 版本 release-4.9.4 进行分析。

### 启动入口

![NameServer-Startup](../../../assets/RocketMQ源码分析-NameServer/NameServer启动流程.png)

启动类：``org.apache.rocketmq.namesrv.NamesrvStartup``

启动入口

```java
public static NamesrvController main0(String[] args) {
  try {
    // 创建controller
    NamesrvController controller = createNamesrvController(args);
    // 启动controller
    start(controller);
    // JSON方式序列化
    String tip = "The Name Server boot success. serializeType=" + RemotingCommand.getSerializeTypeConfigInThisServer();
    log.info(tip);
    System.out.printf("%s%n", tip);
    return controller;
  } catch (Throwable e) {
    e.printStackTrace();
    System.exit(-1);
  }
  return null;
}
```

#### 创建 NamesrvController

NamesrvController 是 NameServer 模块的核心控制类。

主要功能：解析配置文件，填充 NameServerConfig、NettyServerConfig 属性值，并创建 NamesrvController。

入口：**org.apache.rocketmq.namesrv.NamesrvController#createNamesrvController**

```java
public static NamesrvController createNamesrvController(String[] args) throws IOException, JoranException {
  // 核心配置类，创建namesrv的属性配置：NamesrvConfig
  final NamesrvConfig namesrvConfig = new NamesrvConfig();
  // 核型配置类，创建netty的属性配置：NettyServerConfig
  final NettyServerConfig nettyServerConfig = new NettyServerConfig();
  // 设置启动端口号
  nettyServerConfig.setListenPort(9876);
  // 解析命令行中带 -c 的参数后的属性配置文件，解析到 namesrvConfig、nettyServerConfig
  if (commandLine.hasOption('c')) {
      String file = commandLine.getOptionValue('c');
      if (file != null) {
          InputStream in = new BufferedInputStream(new FileInputStream(file));
          properties = new Properties();
          properties.load(in);
          MixAll.properties2Object(properties, namesrvConfig);
          MixAll.properties2Object(properties, nettyServerConfig);
          namesrvConfig.setConfigStorePath(file);
          System.out.printf("load config properties file OK, %s%n", file);
          in.close();
      }
  }
  // 解析命令行中带 -p 参数后值到 namesrvConfig、nettyServerConfig，eg：-p 属性名 = 属性值
  if (commandLine.hasOption('p')) {
      InternalLogger console = InternalLoggerFactory.getLogger(LoggerName.NAMESRV_CONSOLE_NAME);
      MixAll.printObjectProperties(console, namesrvConfig);
      MixAll.printObjectProperties(console, nettyServerConfig);
      System.exit(0);
  }
  // 记录log
  // 通过控制台解析制定 namesrvConfig 配置，将启动参数填充到 namesrvConfig,nettyServerConfig
  MixAll.properties2Object(ServerUtil.commandLine2Properties(commandLine), namesrvConfig);
  // 传入两个配置文件，创建 NamesrvController
  final NamesrvController controller = new NamesrvController(namesrvConfig, nettyServerConfig);
  // 记住所有的配置文件，防止丢弃
  controller.getConfiguration().registerConfig(properties);
  return controller;
}
```

通过构造方法，构造 NamesrvController

```java
public NamesrvController(NamesrvConfig namesrvConfig, NettyServerConfig nettyServerConfig) {
    this.namesrvConfig = namesrvConfig;
    this.nettyServerConfig = nettyServerConfig;
    this.kvConfigManager = new KVConfigManager(this);
    this.routeInfoManager = new RouteInfoManager(); 
    this.brokerHousekeepingService = new BrokerHousekeepingService(this);
    this.configuration = new Configuration(log, this.namesrvConfig, this.nettyServerConfig);
    this.configuration.setStorePathFromConfig(this.namesrvConfig, "configStorePath");
}
```

##### 填充配置属性

主要指定 NameServer 的相关配置属性，其中包括 NamesrvConfig 与 NettyServerConfig。

在 createNamesrvController 中解析启动命令行中 `-c` 后面指定的键值对，将其解析到 NamesrvConfig 与 NettyServerConfig 中。

NamesrvConfig 属性列表

```java
// 加载环境变量，ROCKETMQ_HOME 是 rocketmq 主目录
private String rocketmqHome = System.getProperty(MixAll.ROCKETMQ_HOME_PROPERTY, System.getenv(MixAll.ROCKETMQ_HOME_ENV));
// 加载 kvConfig.json；NameServer 存储 KV 配置属性的持久化路径
private String kvConfigPath = System.getProperty("user.home") + File.separator + "namesrv" + File.separator + "kvConfig.json";
// 核心配置文件 namesrv.properties；nameServer 默认配置文件路径
private String configStorePath = System.getProperty("user.home") + File.separator + "namesrv" + File.separator + "namesrv.properties";
// 单测默认环境为非集群
private String productEnvName = "center";
private boolean clusterTest = false;
// 是否支持顺序消息，默认false
private boolean orderMessageEnable = false;
```

NettyServerConfig 属性列表

```java
// NameServer 监听端口，该值默认会被初始化为 9876
private int listenPort = 8888;
// Netty 业务线程池线程个数
private int serverWorkerThreads = 8;
// Netty public 任务线程池线程个数，Netty 网络设计，根据业务类型会创建不同的线程池，
// 比如处理消息发送、消息消费、心跳检测等。如果该业务类型未注册线程池，则由 public 线程池执行
private int serverCallbackExecutorThreads = 0;
// IO 线程池个数，主要是 NameServer、Broker 端解析请求、返回相应的线程个数，
// 这类线程主要是处理网路请求的，解析请求包，然后转发到各个业务线程池完成具体的操作，然后将结果返回给调用方
private int serverSelectorThreads = 3;
// send oneway 消息请求并发读（Broker 端参数）
private int serverOnewaySemaphoreValue = 256;
// 异步消息发送最大并发度
private int serverAsyncSemaphoreValue = 64;
// 网络连接最大的空闲时间，默认 120s
private int serverChannelMaxIdleTimeSeconds = 120;
// 网络 socket 发送缓冲区大小
private int serverSocketSndBufSize = NettySystemConfig.socketSndbufSize;
// 网络接收端缓存区大小
private int serverSocketRcvBufSize = NettySystemConfig.socketRcvbufSize;
// ByteBuffer 是否开启缓存；ByteBuffer 是rocketMQ 为了提升读写再堆外建立的缓冲区
private boolean serverPooledByteBufAllocatorEnable = true;
// 是否启用 Epoll IO 模型
private boolean useEpollNativeSelector = false;
```

##### 构造 KVConfigManager

将 NamesrvController 对象传入到构造的 KVConfigManager 实例中，

主要功能就是，读取或变更 NameServer 的配置属性，加载 NamesrvConfig 中的配置文件到内存；

> 此类一个亮点就是使用轻量级的非线程安全容器，再结合**读写锁**对资源读写进行保护。尽最大程度提高线程的并发度。

##### 构造 RouteInfoManager

```java
public class RouteInfoManager {

    // NameServer 与 Broker 空闲时长，默认2分钟，在2分钟内 Nameserver 没有收到 Broker 的心跳包，则关闭该连接。
    private final static long BROKER_CHANNEL_EXPIRED_TIME = 1000 * 60 * 2;

    // 保护非线程安全的 HashMap 的读写锁。
    private final ReadWriteLock lock = new ReentrantReadWriteLock();

    // Topic 消息队列路由信息；主题与队列关系，记录一个主题的队列分布在哪些 Broker 上，每个Broker上存在该主题的队列个数。
  	// 消息发送时根据路由表进行负载均衡
    private final HashMap<String/* topic */, Map<String/* brokerName */, QueueData>> topicQueueTable;

    // 所有 Broker 基础信息，brokerName 为 key, BrokerData 信息描述每一个 broker 信息；
    // 包括 brokerName、所属集群名称、主备broker地址
    private final HashMap<String/* brokerName */, BrokerData> brokerAddrTable;

    // broker 集群信息，存储集群中所有 Broker 名称，即每个集群包含哪些 Broker
    private final HashMap<String/* clusterName */, Set<String/* brokerName */>> clusterAddrTable;

    // broker 状态信息，NameServer 每次收到心跳包是会替换该信息。
  	// 其中包括上次上报的时间、数据版本、Netty的Channel、haServerAddr
    // 表示当前存活的 Broker，该信息非实时，NameServer 每10s扫描一次所有的 broker（扫描该表），根据心跳包的时间得知 broker的状态；
    // 该机制也是导致当一个 Broker 进程假死后，消息生产者无法立即感知，可能继续向其发送消息，导致失败（非高可用）。
    private final HashMap<String/* brokerAddr */, BrokerLiveInfo> brokerLiveTable;

    // Broker 上的 FilterServer 列表，用于类模式消息过滤
    private final HashMap<String/* brokerAddr */, List<String>/* Filter Server */> filterServerTable;

    public RouteInfoManager() {
      this.topicQueueTable = new HashMap<>(1024);
      this.brokerAddrTable = new HashMap<>(128);
      this.clusterAddrTable = new HashMap<>(32);
      this.brokerLiveTable = new HashMap<>(256);
      this.filterServerTable = new HashMap<>(256);
    }
}
```

利用无参构造器，初始化基础参数列表。

##### 构造 BrokerHousekeepingService

该类实现 ChannelEventListener接口；

```java
public class BrokerHousekeepingService implements ChannelEventListener {
  	@Override
    public void onChannelConnect(String remoteAddr, Channel channel) {
    }

    @Override
    public void onChannelClose(String remoteAddr, Channel channel) {
        this.namesrvController.getRouteInfoManager().onChannelDestroy(remoteAddr, channel);
    }

    @Override
    public void onChannelException(String remoteAddr, Channel channel) {
        this.namesrvController.getRouteInfoManager().onChannelDestroy(remoteAddr, channel);
    }

    @Override
    public void onChannelIdle(String remoteAddr, Channel channel) {
        this.namesrvController.getRouteInfoManager().onChannelDestroy(remoteAddr, channel);
    }
}
```

通道在发送异常时的回调方法（Nameserver与 Broker的连接通道在关闭、通道发送异常、通道空闲时），在上述数据结构中移除已宕机的 Broker。具体实现见“路由删除”。

##### 构造 Configuration

将 NamesrvConfig 与 NettyServerConfig 配置写到 configuration 实例中。通过读取 configStorePath 下的配置文件（namesrv.properties文件路径）

同时将 命令行 `-c` 后追加的键值对配置合并到当前对象中，防止丢失，以供后续使用。



#### 启动 controller

根据启动属性创建 NamesrvController 实例，并初始化该实例。NameServerController 实例为 NameServer 核心控制器

```java
public static NamesrvController start(final NamesrvController controller) throws Exception {
  // 初始化controller
  boolean initResult = controller.initialize();
  if (!initResult) {
    controller.shutdown();
    System.exit(-3);
  }
  // 注册 JVM 钩子函数代码；在JVM 退出时释放 Controller 资源
  Runtime.getRuntime().addShutdownHook(new ShutdownHookThread(log, (Callable<Void>) () -> {
    controller.shutdown();
    return null;
  }));
  // 启动
  controller.start();
  return controller;
}
```

##### 初始化

代码：NamesrvController#initialize

```java
public boolean initialize() {
  // 加载 KV 配置
  this.kvConfigManager.load();
  // 创建 NettyServer 网络处理对象
  this.remotingServer = new NettyRemotingServer(this.nettyServerConfig, this.brokerHousekeepingService);
  // 建立线程池，用于后续开启定时任务：每隔 10s 扫描一次 Broker, 移除不活跃的 Broker
  this.remotingExecutor = Executors.newFixedThreadPool(nettyServerConfig.getServerWorkerThreads(), 
                                                       new ThreadFactoryImpl("RemotingExecutorThread_"));
  // 注册默认 netty 请求处理器
  this.registerProcessor();
  // 创建 定时周期性的线程池，延迟5s执行，后续每10s执行一次；如果10s发现没有broker上报信息，就将它从路由列表中剔除
  this.scheduledExecutorService
    .scheduleAtFixedRate(NamesrvController.this.routeInfoManager::scanNotActiveBroker, 5, 10, TimeUnit.SECONDS);
  // 开启定时任务：每隔 10min 打印一次 KV 配置
  this.scheduledExecutorService
            .scheduleAtFixedRate(NamesrvController.this.kvConfigManager::printAllPeriodically, 1, 10, TimeUnit.MINUTES);
  return true;
}

// 扫描不活跃的broker
public int scanNotActiveBroker() {
  int removeCount = 0;
  Iterator<Entry<String, BrokerLiveInfo>> it = this.brokerLiveTable.entrySet().iterator();
  while (it.hasNext()) {
    Entry<String, BrokerLiveInfo> next = it.next();
    long last = next.getValue().getLastUpdateTimestamp();
    // 判断broker上次上报时间是否已经超时，默认2min
    if ((last + BROKER_CHANNEL_EXPIRED_TIME) < System.currentTimeMillis()) {
      // 关闭渠道
      RemotingUtil.closeChannel(next.getValue().getChannel());
      // 移除broker
      it.remove();
      log.warn("The broker channel expired, {} {}ms", next.getKey(), BROKER_CHANNEL_EXPIRED_TIME);
      // 维护其他路由表
      this.onChannelDestroy(next.getKey(), next.getValue().getChannel());
      removeCount++;
    }
  }
  return removeCount;
}
```

NameServer 定时任务执行线程池，默认定时执行两个任务：

+ 任务1：每隔 10s 扫描 broker，维护当前存活的 Broker 信息；
+ 任务2：每个 10s 打印 KVConfig 信息。

##### 注册关闭钩子

提前注册关闭钩子，用于在 JVM 进程关闭之前，先将线程池关闭，及时释放资源。

```java
// 注册 JVM 钩子函数代码；在JVM 退出时释放 Controller 资源
Runtime.getRuntime().addShutdownHook(new ShutdownHookThread(log, (Callable<Void>) () -> {
  controller.shutdown();
  return null;
}));

public void shutdown() {
  // 关闭 NettyRemotingServer。包括 eventLoopGroupBoss、eventLoopGroupSelector、nettyEventExecutor、defaultEventExecutorGroup 
  this.remotingServer.shutdown();
  // 关闭扫描并移除不活跃 broker 的线程池
  this.remotingExecutor.shutdown();
  // 关闭两个定时任务线程池：维护存活broker信息、打印kvConfig信息
  this.scheduledExecutorService.shutdown();
  // 关闭证书文件变更的监听器
  if (this.fileWatchService != null) {
    this.fileWatchService.shutdown();
  }
}
```

##### 启动

```java
public void start() throws Exception {
  // 启动 netty 远程 server
  this.remotingServer.start();
  if (this.fileWatchService != null) {
		// 启动证书文件变更的监听器
    this.fileWatchService.start();
  }
}
```



### 路由管理

NameServer 的主要作用是为生产者和消费者提供关于主题 Topic 的路由信息；

那么 NameServer 就需要**存储路由的基础信息**，还要**管理 Broker 节点**，包括**路由注册**、**路由删除**等。

在 NameServer 启动时，NamesrvController 构造器中初始化的 RouteInfoManager 就是路由管理的核心

#### 路由元信息

代码：org.apache.rocketmq.namesrv.routeinfo.RouteInfoManager

```java
public class RouteInfoManager {
    // NameServer 与 Broker 空闲时长，默认2分钟，在2分钟内 Nameserver 没有收到 Broker 的心跳包，则关闭该连接。
    private final static long BROKER_CHANNEL_EXPIRED_TIME = 1000 * 60 * 2;
    // 保护非线程安全的 HashMap 的读写锁。
    private final ReadWriteLock lock = new ReentrantReadWriteLock();
    private final HashMap<String/* topic */, Map<String/* brokerName */, QueueData>> topicQueueTable;   
    private final HashMap<String/* brokerName */, BrokerData> brokerAddrTable;
    private final HashMap<String/* clusterName */, Set<String/* brokerName */>> clusterAddrTable;
    private final HashMap<String/* brokerAddr */, BrokerLiveInfo> brokerLiveTable;
    private final HashMap<String/* brokerAddr */, List<String>/* Filter Server */> filterServerTable;

}
```

![RouteInfoManager](../../../assets/RocketMQ源码分析-NameServer/RouteInfoManager.png)

其中核心属性：

**topicQueueTable**

Topic 消息队列路由信息；主题与队列关系，记录一个主题的队列分布在哪些 Broker 上，每个 Broker 上存在该主题的队列个数。
消息发送时根据路由表进行负载均衡

```json
topicQueueTable: {
    "topic1": [
        {
            "brokerName": "broker-a",
            "readQueueNums": 4,
            "readQueueNums": 4,
            "perm": 6, // 读写权限,具体含义请参考PermName
            "topicSynFlag": 0 // topic同步标记,具体含义请参考TopicsysFlag
        },
        {
            "brokerName": "broker-b",
            "readQueueNums": 4,
            "readQueueNums": 4,
            "perm": 6,
            "topicsynFlag": 0 
        }
    ],
    "topic other": []
}
```

**brokerAddrTable**

所有 Broker 基础信息，brokerName 为 key，BrokerData 信息描述每一个 broker 信息；包括 brokerName、所属集群名称、主备broker地址

```json
brokerAddrTable: {
    "broker-a": {
        "cluster": "c1",
        "brokerName": "broker-a",
        "brokerAddrs": {
            0: "192.168.56.1:10000",
            1: "192.168.56.2:10000"
        }
    },
    "broker-b": {
        "cluster": "c1",
        "brokerName": "broker-b",
        "brokerAddrs": {
            0: "192.168.56.3:10000",
            1: "192.168.56.4:10000"
        }
    }
}
```

**clusterAddrTable**

broker 集群信息，存储集群中所有 Broker 名称，即每个集群包含哪些 Broker

```json
{
    "clusterAddrTable": {
        "c1": [
            "broker-a",
            "broker-b"
        ]
    }
}
```

**brokerLiveTable**

broker 状态信息，NameServer 每次收到心跳包是会替换该信息。其中包括上次上报的时间、数据版本、Netty的Channel、haServerAddr。
用于表示当前存活的 Broker，该信息非实时，NameServer 每10s扫描一次所有的 broker（扫描该表），根据心跳包的时间得知 broker的状态；

该机制也是导致当一个 Broker 进程假死后，消息生产者无法立即感知，可能继续向其发送消息，导致失败（非高可用）。

```json
brokerLiveTable : {
    "192.168.56.1:10000": {
        "lastUpdateTimestamp": 1518270318980,
        "dataversion":versionOj1,
        "channel": channelObj,
        "haServerAddr": "192.168.56.2:10000"
    },
    "192.168.56.2:10000": {
        "lastUpdateTimestamp": 1518270318980,
        "dataversion":versionOb1,
        "channel":channelObj,
        "haserverAddr": ""
    },
    "192.168.56.3:10000": {
        "lastUpdateTimestamp": 1518270318980,
        "dataversion":versionOb1,
        "channel": channelObj,
        "haserverAddr": "192.168.56.4:10000"
    },
    "192.168.56.4:10000": {
        "lastupdateTimestamp": 1518270318980,
        "dataversion":versionOb1,
        "channel": channelObj,
        "haserverAddr":"“
    }
}
```

> RocketMQ 基于定于发布机制，一个 Topic 拥有多个消息队列，一个 Broker 为每一个主题创建 4 个读队列和 4 个写队列。多个 Broker 组成一个集群，集群由相同的多台 Broker 组成 Master-Slave 架构，brokerId 为 0 代表 Master，大于 0 为 Slave。BrokerLiveInfo 中的 lastUpdateTimestamp 存储上次收到 Broker 心跳包的时间。

**filterServerTable**

Broker 上的 FilterServer 列表，用于类模式消息过滤。

#### 路由注册

路由注册是由 broker 发起

##### 发送心跳包

RocketMQ 路由注册是通过 Broker 与 NameServer 的心跳功能实现。

Broker 启动时向集群中所有的 NameServer 发送心跳信息，之后每隔 30s 向集群中所有 NameServer 发送心跳包，心跳包包含 BrokerId，Broker 地址，Broker 名称，Broker 所属集群名称、Broker 关联的 FilterServer 列表。

NameServer 收到心跳包时会更新 brokerLiveTable 缓存中 BrokerLiveInfo 的 lastUpdataTimeStamp 信息，然后 NameServer 每隔 10s 扫描 brokerLiveTable，如果连续 120s 没有收到心跳包，NameServer 将移除 Broker 的路由信息同时关闭 Socket 连接。

![RouteRegister](../../../assets/RocketMQ源码分析-NameServer/RouteRegister.png)

代码：org.apache.rocketmq.broker.BrokerController#start

```java
if (!messageStoreConfig.isEnableDLegerCommitLog()) {
  startProcessorByHa(messageStoreConfig.getBrokerRole());
  handleSlaveSynchronize(messageStoreConfig.getBrokerRole());
  // 注册 Broker 信息
  this.registerBrokerAll(true, false, true);
}
// 延迟10s执行，之后默认每隔 30s 向 Namesrv 发送 broker 注册信息
this.scheduledExecutorService.scheduleAtFixedRate(() -> {
  try {
    BrokerController.this.registerBrokerAll(true, false, brokerConfig.isForceRegister());
  } catch (Throwable e) {
    log.error("registerBrokerAll Exception", e);
  }
}, 1000 * 10, Math.max(10000, Math.min(brokerConfig.getRegisterNameServerPeriod(), 60000)), TimeUnit.MILLISECONDS);
```

org.apache.rocketmq.broker.out.BrokerOuterAPI#registerBrokerAll

```java
public List<RegisterBrokerResult> registerBrokerAll(
        final String clusterName,
        final String brokerAddr,
        final String brokerName,
        final long brokerId,
        final String haServerAddr,
        final TopicConfigSerializeWrapper topicConfigWrapper,
        final List<String> filterServerList,
        final boolean oneway,
        final int timeoutMills,
        final boolean compressed) {
  final List<RegisterBrokerResult> registerBrokerResultList = new CopyOnWriteArrayList<>();
  // 获得 nameServer 地址信息
  List<String> nameServerAddressList = this.remotingClient.getNameServerAddressList();
  // 遍历所有 nameserver 列表
  if (nameServerAddressList != null && nameServerAddressList.size() > 0) {
    // 封装请求头
    final RegisterBrokerRequestHeader requestHeader = new RegisterBrokerRequestHeader();
    requestHeader.setBrokerAddr(brokerAddr);
    requestHeader.setBrokerId(brokerId);
    requestHeader.setBrokerName(brokerName);
    requestHeader.setClusterName(clusterName);
    requestHeader.setHaServerAddr(haServerAddr);
    requestHeader.setCompressed(compressed);
    // 封装请求体
    RegisterBrokerBody requestBody = new RegisterBrokerBody();
    requestBody.setTopicConfigSerializeWrapper(topicConfigWrapper);
    requestBody.setFilterServerList(filterServerList);
    final byte[] body = requestBody.encode(compressed);
    final int bodyCrc32 = UtilAll.crc32(body);
    requestHeader.setBodyCrc32(bodyCrc32);
    final CountDownLatch countDownLatch = new CountDownLatch(nameServerAddressList.size());
    // 向所有 nameServer 地址发送消息
    for (final String namesrvAddr : nameServerAddressList) {
      brokerOuterExecutor.execute(() -> {
        try {
          // 异步注册，向 namesrv 发送心跳请求
          RegisterBrokerResult result = 
            registerBroker(namesrvAddr, oneway, timeoutMills, requestHeader, body);
          if (result != null) {
            // 将 masterAddr 和 haServerAddr 收集起来
            registerBrokerResultList.add(result);
          }

          log.info("register broker[{}]to name server {} OK", brokerId, namesrvAddr);
        } catch (Exception e) {
          log.warn("registerBroker Exception, {}", namesrvAddr, e);
        } finally {
          countDownLatch.countDown();
        }
      });
    }
    try {
      countDownLatch.await(timeoutMills, TimeUnit.MILLISECONDS);
    } catch (InterruptedException e) {
    }
  }
  return registerBrokerResultList;
}
```

org.apache.rocketmq.broker.out.BrokerOuterAPI#registerBroker

```java
// oneway方式不接受返回值
if (oneway) {
    try {
        this.remotingClient.invokeOneway(namesrvAddr, request, timeoutMills);
    } catch (RemotingTooMuchRequestException e) {
        // Ignore
    }
    return null;
}
// 同步调用
RemotingCommand response = this.remotingClient.invokeSync(namesrvAddr, request, timeoutMills);
```

##### 处理心跳包

![NameServer处理路由注册](../../../assets/RocketMQ源码分析-NameServer/NameServer处理路由注册.png)

`org.apache.rocketmq.namesrv.processor.DefaultRequestProcessor` 属于网络处理类，其功能是解析请求类型。

**DefaultRequestProcessor#processRequest**

若请求类型为 `REGISTER_BROKER`，则将请求转发到 `RouteInfoManager#registerBroker`，完成 broker 的注册。

```java
// 判断是注册 Broker 信息类型请求
case RequestCode.REGISTER_BROKER:
  Version brokerVersion = MQVersion.value2Version(request.getVersion());
  if (brokerVersion.ordinal() >= MQVersion.Version.V3_0_11.ordinal()) {
    // 注册 broker
    return this.registerBrokerWithFilterServer(ctx, request);
  } else {
    return this.registerBroker(ctx, request);
  }
```

**DefaultRequestProcessor#registerBrokerWithFilterServer**

从 namesrvController 获取路由管理器 routeInfoManager，进行 broker 注册操作。传入当前 broker 信息（集群名称、broker地址、brokerId、haServerAddr、topicConfigWrapper 等），其中 haServerAddr 属性初始时为空，slave 注册后进行填充 master 地址。

```java
RegisterBrokerResult result = this.namesrvController.getRouteInfoManager().registerBroker(
    requestHeader.getClusterName(),
    requestHeader.getBrokerAddr(),
    requestHeader.getBrokerName(),
    requestHeader.getBrokerId(),
    requestHeader.getHaServerAddr(),
    registerBrokerBody.getTopicConfigSerializeWrapper(),
    registerBrokerBody.getFilterServerList(),
    ctx.channel());
```

**RouteInfoManager#registerBroker**

该方法为注册 broker，首先加上写锁，路由注册属于同步操作。

1. 将当前的 borkerName 维护到 clusterAddrTable 中的 clusterName 下的 Set 中。
2. 在基础信息维护到 brokerData 中，并放回到 brokerAddrTable。第一次注册时 brokerData 为空，直接创建一个
3. 对比 BrokerAddrs 中信息与当前的 borkerId、brokerAddr、brokerName 等，将当前 brokerId 与集合中的 brokerId 不相等，但 brokerAddr 一样的记录移除。
4. 将当前的 brokerAddr 更新到 brokerData 中的 BrokerAddrs 地址信息中。
5. 若当前 broker 是主节点（brokerId=0），则关联当前的 brokerName，维护队列信息映射列表（Map<String, QueueData>）到 topicQueueTable，数据源从 topicConfigTable 中解析获取。（RouteInfoManager#createAndUpdateQueueData）
6. 构建 BrokerLiveInfo，维护到 brokerLiveTable 中，挂在当前 brokerAddr 下。
7. 若当前 broker 非主节点（brokerId1=0），则将当前主节点的地址信息维护到 masterAddr 和 haServerAddr 中作为结果返回，主节点地址信息是，从 brokerData.brokerAddrs 中获取主节点的地址，再关联 brokerLiveTable 获取 brokerLiveInfo 中取得。

```java
public RegisterBrokerResult registerBroker(
        final String clusterName,
        final String brokerAddr,
        final String brokerName,
        final long brokerId,
        final String haServerAddr,
        final TopicConfigSerializeWrapper topicConfigWrapper,
        final List<String> filterServerList,
        final Channel channel) {
    RegisterBrokerResult result = new RegisterBrokerResult();
  try {
    try {
      // 打开写锁，说明路由注册是同步的行为
      this.lock.writeLock().lockInterruptibly();
      // 维护 clusterAddrTable 
      Set<String> brokerNames = this.clusterAddrTable.computeIfAbsent(clusterName, k -> new HashSet<>());
      brokerNames.add(brokerName);

      boolean registerFirst = false;
      BrokerData brokerData = this.brokerAddrTable.get(brokerName);
      // 第一次注册，则创建一个 brokerData
      if (null == brokerData) {
        registerFirst = true;
        brokerData = new BrokerData(clusterName, brokerName, new HashMap<>());
        // 维护到 brokerAddrTable
        this.brokerAddrTable.put(brokerName, brokerData);
      }
      // 非第一次注册，更新 Broker
      Map<Long, String> brokerAddrsMap = brokerData.getBrokerAddrs();
      //Switch slave to master: first remove <1, IP:PORT> in namesrv, then add <0, IP:PORT>
      //The same IP:PORT must only have one record in brokerAddrTable
      // 官方注释：主从切换，首先移除编号为1的从节点，再增加主节点(brokerId=0)
      // 相同IP:PORT 在brokerAddrTable中只能仅存在一条记录
      Iterator<Entry<Long, String>> it = brokerAddrsMap.entrySet().iterator();
      while (it.hasNext()) {
        Entry<Long, String> item = it.next();
        if (null != brokerAddr && brokerAddr.equals(item.getValue()) && brokerId != item.getKey()) {
          log.debug("remove entry {} from brokerData", item);
          it.remove();
        }
      }

      String oldAddr = brokerData.getBrokerAddrs().put(brokerId, brokerAddr);
      registerFirst = registerFirst || (null == oldAddr);
      if (null != topicConfigWrapper && MixAll.MASTER_ID == brokerId) {
        // 判断 broker 信息是否发生了变更，通过对比 brokerLiveTable 中的版本（dataVersion）
        if (this.isBrokerTopicConfigChanged(brokerAddr, topicConfigWrapper.getDataVersion())
            || registerFirst) {
          // 维护 topicQueueTable
          ConcurrentMap<String, TopicConfig> tcTable = topicConfigWrapper.getTopicConfigTable();
          if (tcTable != null) {
            for (Map.Entry<String, TopicConfig> entry : tcTable.entrySet()) {
              this.createAndUpdateQueueData(brokerName, entry.getValue());
            }
          }
        }
      }

      // 维护 brokerLiveTable
      BrokerLiveInfo prevBrokerLiveInfo = this.brokerLiveTable.put(brokerAddr,
                                                                  new BrokerLiveInfo(
                                                                     System.currentTimeMillis(),
                                                                     topicConfigWrapper.getDataVersion(),
                                                                     channel,
                                                                     haServerAddr));
      if (null == prevBrokerLiveInfo) {
        log.info("new broker registered, {} HAServer: {}", brokerAddr, haServerAddr);
      }
      // V3_0_11 处理 filterServerTable
      if (filterServerList != null) {
        if (filterServerList.isEmpty()) {
          this.filterServerTable.remove(brokerAddr);
        } else {
          this.filterServerTable.put(brokerAddr, filterServerList);
        }
      }

      if (MixAll.MASTER_ID != brokerId) {
        String masterAddr = brokerData.getBrokerAddrs().get(MixAll.MASTER_ID);
        if (masterAddr != null) {
          BrokerLiveInfo brokerLiveInfo = this.brokerLiveTable.get(masterAddr);
          if (brokerLiveInfo != null) {
            result.setHaServerAddr(brokerLiveInfo.getHaServerAddr());
            result.setMasterAddr(masterAddr);
          }
        }
      }
    } finally {
      this.lock.writeLock().unlock();
    }
  } catch (Exception e) {
    log.error("registerBroker Exception", e);
  }
	return result;
}
```

RouteInfoManager#createAndUpdateQueueData

该方法是注册 broker 中的一环，维护 topic/Queue 信息。

1. 首先创建队列信息（QueueData），传入brokerName、writeQueueNums（写队列数）、readQueueNums（读队列数）、perm（权限操作）、topicSysFlag（消息存储服务标识）
2. 获得 topicQueueTable 中队列集合，若第一次增加，集合为空，则以 brokerName 为 key，queueData 为 value 新建集合，并将集合追加到当前 topicQueueTable 中，以 topic 为 key。非第一次增加则修改当前 topic 下的 queueDataMap

```java
private void createAndUpdateQueueData(final String brokerName, final TopicConfig topicConfig) {
  // 创建 QueueData
  QueueData queueData = new QueueData();
  queueData.setBrokerName(brokerName);
  queueData.setWriteQueueNums(topicConfig.getWriteQueueNums());
  queueData.setReadQueueNums(topicConfig.getReadQueueNums());
  queueData.setPerm(topicConfig.getPerm());
  queueData.setTopicSysFlag(topicConfig.getTopicSysFlag());

  // 获得 topicQueueTable 中队列集合
  Map<String, QueueData> queueDataMap = this.topicQueueTable.get(topicConfig.getTopicName());
  // topicQueueTable 为空，则直接添加 queueData 到队列集合
  if (null == queueDataMap) {
    queueDataMap = new HashMap<>();
    queueDataMap.put(queueData.getBrokerName(), queueData);
    // 维护到 topicQueueTable 中，topic为key，value 为 brokerName 与队列信息映射
    this.topicQueueTable.put(topicConfig.getTopicName(), queueDataMap);
    log.info("new topic registered, {} {}", topicConfig.getTopicName(), queueData);
  } else {
    // 判断是否是新的队列
    QueueData old = queueDataMap.put(queueData.getBrokerName(), queueData);
    // put的对象与结果不相同表示修改成功
    if (old != null && !old.equals(queueData)) {
      log.info("topic changed, {} OLD: {} NEW: {}", topicConfig.getTopicName(), old, queueData);
    }
  }
}
```

#### 路由删除

Broker 从启动开始，每隔 30s 向 NameServer 发送一个心跳包，NameServer 收到心跳包时会更新 brokerLiveTable 缓存中 BrokerLiveInfo 的 lastUpdataTimeStamp 信息。但如果 broker 宕机，NameServer 无法收到心跳包，此时 NameServer 就需要剔除这些失效的 Broker。

NameServer 每隔 10s 扫描 brokerLiveTable，若连续 120s 没有收到心跳包（BrokerLive 的 `lastUpdateTimestamp` 的时间戳距当前时间超过 120s），则认为 Broker 失效，移除该 Broker。NameServer 将移除 Broker 的路由信息同时关闭 与 broker 之间的 Socket 连接。同时更新 topicQueueTable 、 brokerAddrTable 、 brokerLiveTable 、 filterServerTable 等信息。

**RocketMQ 有两个触发点来删除路由信息**

* NameServer 定期扫描 brokerLiveTable 检测上次心跳包与当前系统的时间差，如果时间超过 120s，则要移除 broker。
* Broker 在正常关闭的情况下，会执行 unregisterBroker 指令

这两种方式路由删除的方法都是一样的，即从相关路由表中删除与该 broker 相关的信息。

![路由删除](../../../assets/RocketMQ源码分析-NameServer/路由删除.png)

NamesrvController#initialize

```java
//每隔 10s 扫描一次为活跃 Broker
this.scheduledExecutorService.scheduleAtFixedRate(NamesrvController.this.routeInfoManager::scanNotActiveBroker, 5, 10, TimeUnit.SECONDS);
```

RouteInfoManager#scanNotActiveBroker

利用迭代器遍历 brokerLiveTable，获取 brokerLiveInfo，判断里面的 LastUpdateTimestamp 距离当前时间戳是否超过120s，是则关闭连接，维护 broker 集合和路由表。

```java
public void scanNotActiveBroker() {
  int removeCount = 0;
  // 获得 brokerLiveTable
  Iterator<Entry<String, BrokerLiveInfo>> it = this.brokerLiveTable.entrySet().iterator();
  // 遍历 brokerLiveTable
  while (it.hasNext()) {
    Entry<String, BrokerLiveInfo> next = it.next();
    long last = next.getValue().getLastUpdateTimestamp();
    // 如果收到心跳包的时间距当时时间是否超过 120s
    if ((last + BROKER_CHANNEL_EXPIRED_TIME) < System.currentTimeMillis()) {
      // 关闭渠道
      RemotingUtil.closeChannel(next.getValue().getChannel());
      // 移除broker
      it.remove();
      log.warn("The broker channel expired, {} {}ms", next.getKey(), BROKER_CHANNEL_EXPIRED_TIME);
      // 维护其他路由表
      this.onChannelDestroy(next.getKey(), next.getValue().getChannel());
      removeCount++;
    }
  }
  return removeCount;
}

```

RouteInfoManager#onChannelDestroy

首先申请读锁，从 brokerLiveTable 中找到当前 channel 下的 broker 的地址。

```java
try {
  // 读锁
  this.lock.readLock().lockInterruptibly();
  Iterator<Entry<String, BrokerLiveInfo>> itBrokerLiveTable =
    this.brokerLiveTable.entrySet().iterator();
  while (itBrokerLiveTable.hasNext()) {
    Entry<String, BrokerLiveInfo> entry = itBrokerLiveTable.next();
    if (entry.getValue().getChannel() == channel) {
      brokerAddrFound = entry.getKey();
      break;
    }
  }
} finally {
  this.lock.readLock().unlock();
}
```

申请写锁，开启 broker 信息的维护工作。表明整个更新过程需要同步进行，需要操作许多共享变量（各种路由列表信息）

将找到的 broker 地址，从 brokerLiveTable 和 filterServerTable 移除

```JAVA
this.lock.writeLock().lockInterruptibly();
this.brokerLiveTable.remove(brokerAddrFound);
this.filterServerTable.remove(brokerAddrFound);
```

遍历 brokerAddrTable，获取其中的 brokerData，再遍历其中的 brokerAddrs 集合，若匹配到当前待移除的 broker 地址，则将其移除。此时在判断若 brokerData 中的 brokerAddrs 已经为空，则直接其从 brokerAddrTable 中移除。

```JAVA
// 维护 brokerAddrTable
String brokerNameFound = null;
boolean removeBrokerName = false;
Iterator<Entry<String, BrokerData>> itBrokerAddrTable = this.brokerAddrTable.entrySet().iterator();
// 遍历 brokerAddrTable
while (itBrokerAddrTable.hasNext() && (null == brokerNameFound)) {
    BrokerData brokerData = itBrokerAddrTable.next().getValue();
    // 遍历 broker 地址
    Iterator<Entry<Long, String>> it = brokerData.getBrokerAddrs().entrySet().iterator();
    while (it.hasNext()) {
        Entry<Long, String> entry = it.next();
        Long brokerId = entry.getKey();
        String brokerAddr = entry.getValue();
        // 根据 broker 地址移除 brokerAddr
        if (brokerAddr.equals(brokerAddrFound)) {
            brokerNameFound = brokerData.getBrokerName();
            it.remove();
            log.info("remove brokerAddr[{}, {}] from brokerAddrTable, because channel destroyed",
                brokerId, brokerAddr);
            break;
        }
    }
		// 如果当前主题只包含待移除的 broker, 则移除该 topic
    if (brokerData.getBrokerAddrs().isEmpty()) {
        removeBrokerName = true;
        itBrokerAddrTable.remove();
        log.info("remove brokerName[{}] from brokerAddrTable, because channel destroyed",
            brokerData.getBrokerName());
    }
}
```

接着遍历 clusterAddrTable 集合，从其中的 set 集合中移除当前待移除的 broker。若此时整个 broker 列表（set）都为空，则直接移除 Set。

```JAVA
// 维护 clusterAddrTable
if (brokerNameFound != null && removeBrokerName) {
    Iterator<Entry<String, Set<String>>> it = this.clusterAddrTable.entrySet().iterator();
    // 遍历 clusterAddrTable
    while (it.hasNext()) {
        Entry<String, Set<String>> entry = it.next();
        // 获得集群名称
        String clusterName = entry.getKey();
        // 获得集群中 brokerName 集合
        Set<String> brokerNames = entry.getValue();
        // 从 brokerNames 中移除 brokerNameFound
        boolean removed = brokerNames.remove(brokerNameFound);
        if (removed) {
            log.info("remove brokerName[{}], clusterName[{}] from clusterAddrTable, because channel destroyed", brokerNameFound, clusterName);
            if (brokerNames.isEmpty()) {
                log.info("remove the clusterName[{}] from clusterAddrTable, because channel destroyed and no broker in this cluster", clusterName);
                // 如果集群中不包含任何 broker, 则移除该集群
                it.remove();
            }
            break;
        }
    }
}
```

维护 topic 路由列表（topicQueueTable），遍历 topicQueueTable，找出所有 topic 下对应不活跃的 broker 及其下面挂的队列信息（QueueData）。若移除完后 topic 队列为空，则直接移除 topicQueueTable 中对应的 topic，因为已经没有 broker 处理topic了。

```JAVA
// 维护 topicQueueTable 队列
if (removeBrokerName) {
  String finalBrokerNameFound = brokerNameFound;
  Set<String> needRemoveTopic = new HashSet<>();
	// 遍历 topicQueueTable
  topicQueueTable.forEach((topic, queueDataMap) -> {
		// 从队列中移除不活跃 broker 信息
    QueueData old = queueDataMap.remove(finalBrokerNameFound);
    log.info("remove topic[{} {}], from topicQueueTable, because channel destroyed", topic, old);
    // 若队列为空，则移除topicQueueTable，没有 broker 处理 topic
    if (queueDataMap.size() == 0) {
      log.info("remove topic[{}] all queue, from topicQueueTable, because channel destroyed", topic);
      needRemoveTopic.add(topic);
    }
  });

  needRemoveTopic.forEach(topicQueueTable::remove);
}
```

最后一步，释放写锁，维护工作结束。

```JAVA

finally {
    this.lock.writeLock().unlock();
}
```



#### 路由发现

RocketMQ 路由发现是非实时的，当 Topic 路由出现变化后，NameServer 不会主动推送给客户端，而是由客户端定时拉取主题最新的路由。

DefaultRequestProcessor#getRouteInfoByTopic

```JAVA
public RemotingCommand getRouteInfoByTopic(ChannelHandlerContext ctx,
    RemotingCommand request) throws RemotingCommandException {
    final RemotingCommand response = RemotingCommand.createResponseCommand(null);
    final GetRouteInfoRequestHeader requestHeader =
        (GetRouteInfoRequestHeader) request.decodeCommandCustomHeader(GetRouteInfoRequestHeader.class);
		// 调用 RouteInfoManager 的方法，从路由表 topicQueueTable、brokerAddrTable、filterServerTable 中分别填充 TopicRouteData 的 List<QueueData>、List<BrokerData>、filterServer
    TopicRouteData topicRouteData = this.namesrvController.getRouteInfoManager().pickupTopicRouteData(requestHeader.getTopic());
		// 如果找到主题对应的路由信息并且该主题为顺序消息，则从 NameServer KVConfig 中获取关于顺序消息相关的配置填充路由信息
    if (topicRouteData != null) {
      if (this.namesrvController.getNamesrvConfig().isOrderMessageEnable()) {
        String orderTopicConf = this.namesrvController.getKvConfigManager()
          .getKVConfig(NamesrvUtil.NAMESPACE_ORDER_TOPIC_CONFIG, requestHeader.getTopic());
        topicRouteData.setOrderTopicConf(orderTopicConf);
      }
      byte[] content;
      Boolean standardJsonOnly = requestHeader.getAcceptStandardJsonOnly();
      if (request.getVersion() >= Version.V4_9_4.ordinal() || (null != standardJsonOnly && standardJsonOnly)) {
        content = topicRouteData.encode(SerializerFeature.BrowserCompatible,
                                        SerializerFeature.QuoteFieldNames, SerializerFeature.SkipTransientField,
                                        SerializerFeature.MapSortField);
      } else {
        content = RemotingSerializable.encode(topicRouteData);
      }
    }
    response.setCode(ResponseCode.TOPIC_NOT_EXIST);
    response.setRemark("No topic route info in name server for the topic: " + requestHeader.getTopic()
        + FAQUrl.suggestTodo(FAQUrl.APPLY_TOPIC_URL));
    return response;
}
```

