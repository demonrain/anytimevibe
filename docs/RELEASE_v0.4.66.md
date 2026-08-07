# 随码 v0.4.66

## 结论

Claude（及同类 headless 引擎）失败时，前端 SYSTEM 错误不再连刷三遍。更新客户端 **0.4.66**；Web 同步去重逻辑建议一并部署。

## 原因

同一失败会被三条路径各记一次：

1. Claude `assistant` 合成错误（含每次 `api_retry`）
2. 最终 `result.is_error`
3. 回合结束后 `runHeadlessTaskTurn` 再写一条 system

且去重用全文精确匹配：入库写成 `错误：API Error…`，后续事件仍是 `API Error…`，匹配失败 → 重复插入。

## 修复

- headless：同文案错误只 `emit` 一次（重试 / result 复用）
- Agent / Web：按去掉「错误：」前缀后的正文去重
- 回合结束不再重复追加已存在的 system 错误
