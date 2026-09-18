# Loom DeepSeek Harness

React 工作台 + TypeScript 本地服务 + DeepSeek Harness 原生运行时。保留对话入口，承载讨论、Coding、项目连续性、个人管理与能力扩展。第一版不引入 LangGraph，不移植整个 OnvoClaw。

## 启动

需要 Node.js 24+，两个项目目录相邻，分别执行 `npm ci` 安装依赖。沿用已配置的 DeepSeek。

```sh
npm start
```

默认在 <http://127.0.0.1:3080> 打开。

启动器构建相邻 UI，独立运行本地服务（3080）和 Harness（3081），不再向依赖包复制构建文件。端口冲突时退出，不杀死其他进程。UI 保留 Sites 构建契约，但完整 Agent 功能需要本地服务，不是纯静态网站。

## 初次配置

新电脑先按官方 Harness 流程配置 DeepSeek；已有电脑直接沿用。工作台侧栏添加项目文件夹。启动后的原生 Harness 在 3081，可用于维护模型配置。

API Key 由 Harness 的本地设置页保存，不要提交到 Git。

## 工程分层

| 层 | 实现与职责 |
| --- | --- |
| 运行适配 | `server/harness.ts`：HTTP RPC、WebSocket 事件、选择题/审批、重连；真实 turn/end 判定结果 |
| 工作数据 | `server/store.ts`：SQLite WAL、项目/任务/运行/方案/产出/待办/安排/通知/草稿、事件游标 |
| 管理与调度 | `server/service.ts`：上下文、同项目串行、唯一触发键、状态对账、草稿确认、迁移 |
| 可读记忆 | `server/files.ts`：Markdown、版本冲突检查、写前备份、路径校验 |
| Agent 能力桥 | `server/loom-plugin.mjs`：原生 context/work/skill_draft 工具 |
| 能力装配 | `server/presets.ts`：工作与 Skill 草稿两种原生 preset，不修改第三方包 |
| 本地入口 | `server/main.ts`：同源 HTTP、静态托管、事件恢复、业务接口 |
| 工作台 | UI `src/Workbench.jsx`：Today、会话、确认、协作者、方案和记忆面板 |

普通工作和独立评审共享 Harness；Skill 设计会话没有终端或文件写入工具，只能读取上下文、询问、规划与提交草稿。确认保存才安装。原生委派深度为一层，每个评审会话最多两次委派；同项目顶层任务串行。协作者结果来自真实子会话。执行任务保存选定方案版本的内容快照。

输入区的“先规划 / 直接做”使用 Harness 原生、可回放的 plan projection，不是前端模拟开关。`exit_plan_mode` 提交的方案会作为独立审阅卡显示，确认前不进入执行。工作台同时读取 Harness 原生 Token/上下文投影；多 Agent 方案确认后，子会话只获得最终决策摘要、工程交接与自己的执行项，不复制整段创新/评审讨论。

## 本地数据

默认 `~/LoomData`，可用 `LOOM_DATA_DIR` 指定；Harness 使用已有 `DSH_HOME`（默认 `~/.dsh`）。

```text
LoomData/
  state/loom.sqlite        工作数据与事件
  memory/MEMORY.md          可直接编辑的个人偏好
  memory/projects/<id>/    overview.md / decisions.md / progress.md
  memory/.history/         修改前内容备份
  skills/<name>/SKILL.md   用户确认的能力
  artifacts/               个人产出
  imports/                 原始迁移文件暂存
```

旧会话与用户 Skills 保留。每次派发读取当前个人/项目记忆；不默认注入其他项目记忆。Markdown 是资料，不构成执行授权。

安排按到期时间唯一认领。关机或休眠时不运行；超过两分钟的错过执行只通知，不自动补跑。可手动运行，结果可在原会话继续。未知执行状态标为中断，避免重启重放副作用。提醒目前为工作台内通知，不是系统推送。

## 迁移与平台边界

设置里导出/导入记忆、Skills、项目标题、待办、方案、安排、产出索引与小型个人产出。项目目录不打包，导入后重新绑定；安排默认暂停。不会打包 Harness 设置、环境变量、凭证或原始会话历史。文档内用户自行写入的敏感内容仍可能进入包，分享前需要检查。

旧设备的原始会话保留；第一版迁移包不能在新设备恢复原始 Harness 会话。项目文件需另行复制或 Git 同步，大于 2 MB 的个人产出不打包。

Mac 已开展真实运行验收；Windows 使用跨平台路径与启动方式，但尚无真机验收，不标记已支持。源码接收方应在自己的隔离目录重新执行端到端验收。

本地服务仅监听回环地址，校验 Host/Origin 和请求标识；不是多用户安全隔离系统。工作 preset 保留本地代码执行能力。电脑操控 Skill 不等于屏幕控制工具，当前尚未接入后者。

## 验证

运行 `npm test`、`npm run typecheck`；UI 运行 `npm run build`、`npm run test:sites`。参考来源及许可边界见 `THIRD_PARTY.md`。
