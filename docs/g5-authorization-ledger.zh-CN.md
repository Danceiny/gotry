# G5 授权台账

> 定位/Role：G5 内部差旅系统（T 系统）桥入 GoTry 的唯一授权面；`ts/scripts/g5-guard.ts` 机械读取本文件
> 状态/Status：living
> 上游/Upstream：[gotry-master-outline.zh-CN.md](gotry-master-outline.zh-CN.md) G5 门 + 复用矩阵 §2；[issue #348](https://github.com/Danceiny/gotry/issues/348)
> 下游/Downstream：`ts/scripts/g5-guard.ts`（无覆盖 GRANT 时 fail closed）；创始人

## 1. 本台账是什么

- G5 门（内部差旅工具桥，T 系统侧，脱敏）**关闭中**。下方存在覆盖条目之前，任何把 G5 lane 接进代码/配置/文档的引用都会被机械闸打红（`npx tsx scripts/g5-guard.ts`，run-all §58）。
- **条目只能由创始人侧维护。**agent 不得为解锁自己而添加 GRANT；不存在自助授权通道。机械边界：本闸只证明「无授权记录 → 无桥接」；条目的作者身份靠 git review，机械不可证。
- 泛化的「内部资产可用」不算授权。按 #348 验收，每条记录须写明具体系统、业务目的、调用主体、允许的方法/字段、tenant/身份范围、保留与撤销方式。

## 2. 条目格式

每条授权一行；路径范围为 glob（`*` 单段内，`**` 跨段）：

```
- GRANT: <path-glob> — system/purpose/scope one-liner — issue/decision: #<n> or URL
```

缺 `issue/decision` 链接的 GRANT 行会被闸拒收（fail closed）。

## 3. 条目

（空——尚未授予任何内部差旅桥授权；当前产品路径 = 公共 MIT `hotelbyte-cli` 进程桥，内部 lane 仅作 reference）
