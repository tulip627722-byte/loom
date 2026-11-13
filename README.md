# Loom

Loom 是一个本地优先的 Windows 多智能体桌面工作台。它拥有自己的持久化 Agent 编排内核，不依赖任何单一模型厂商或第三方 Agent Runtime。

## 当前能力

- Tauri 2 + React 简洁对话式桌面界面
- Planner、Executor、UI、Research、Reviewer 五个独立角色
- CC Switch 模型发现，以及 OpenAI Responses / Chat 模型适配
- Plan 审批、命令审批、SSE 实时事件和中断恢复
- 每个写任务使用独立 Git worktree
- SQLite WAL、FTS5 项目隔离记忆和 Markdown 备份
- Windows Credential Manager 原生凭证接口
- 旧 LoomData 业务数据备份与迁移工具

GitHub 与飞书属于第二阶段；当前连接器包只定义边界，不会伪装成已连接。

## 目录

```text
E:\Loom\
  source\       本仓库
  data\         SQLite、记忆和配置
  worktrees\    隔离执行工作树
  artifacts\    交付产出
  previews\     临时预览
  backups\      迁移和记忆备份
  logs\         运行日志
```

运行数据不进入 Git。密钥与 Token 应保存到 Windows Credential Manager。

## 开发与验证

要求 Node.js 24+、Windows 11 和 Git。构建桌面安装包还需要 Rust stable 与 WebView2。

```powershell
cd E:\Loom\source
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

安装 Rust 后运行 `npm run desktop -- build` 构建 MSI/NSIS。

开发地址：UI `127.0.0.1:1420`、Runtime `127.0.0.1:3210`、CC Switch `127.0.0.1:15721`。

## 使用流程

1. 保持 CC Switch 本地路由运行，或在设置中添加直连模型。
2. 重新探测模型，为五个 Agent 角色分别绑定模型。
3. 添加 Git 项目，选择“先计划”或“直接执行”并发送任务。

建议把 SOL 类模型绑定计划角色、Luna 类模型绑定执行角色、Kimi K3 绑定界面角色。Loom 只使用实时发现或用户登记的模型 ID。

## 旧数据迁移

迁移会先备份旧目录，再导入项目、Markdown 记忆和业务记录；旧 Runtime 原始会话不会续跑。

```powershell
npm --workspace @loom/runtime run migrate -- C:\Users\<用户名>\LoomData
```

Runtime 重启时会把执行中的副作用步骤标记为 `interrupted`，不会自动重复执行。
