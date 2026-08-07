# 随码 v0.4.68

## 结论

修复 Cursor 选 **Auto** 时残留 effort/fast 参数，导致下发成 `Auto-xhigh` 等非法 `--model`。需更新客户端 **0.4.68**（Web 建议同步）。

## 修复

- Agent：`Auto` 规范化；持久化只用家族 id；Auto 不带 reasoning effort
- Web：切模型立刻清 effort；picker 不注入 `id[fast=…]` 脏选项
