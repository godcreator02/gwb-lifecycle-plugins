# tasklist 在这台机器上一次要多久：按单个 pid 过滤查、不过滤列整张表

## 问什么

`devkit.home.list` 对每个有运行时记录的 home 各调一次 `tasklist /FI "PID eq <pid>"`，二十几个 home 要三十到八十秒。
想知道慢在 tasklist 本身，还是在别处；以及不加过滤、一次列出整张进程表要多久。

## 怎么跑

```powershell
node --no-deprecation probes/2609251235_tasklist-cost/run.mjs
```

只在 Windows 上有意义。两种写法各跑五次，打印每次的毫秒数、输出行数、是否全部成功。

## 结果

`runs/01-tasklist-cost.txt`：按 pid 过滤一次 1.5～1.7 秒，列整张表（约 600 个进程）一次 1.9～2.2 秒。
过滤不省时间，tasklist 本身就慢；列二十几个 home，一次整张表比逐个查快十倍以上。
