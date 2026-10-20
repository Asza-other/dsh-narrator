# GitHub 发布信息

直接复制粘贴即可。

---

## 1. 仓库名

```
dsh-narrator
```

## 2. 仓库简介（About 栏，限 350 字符）

```
DeepSeek Harness 插件：模型长时间只思考不出声时，注入提示词让它自己用正文说清在做什么、做到哪了，任务不中断；对话正文左下角浮窗同步显示这段原文。带分钟级图形设置卡，零运行时依赖。
```

英文版（可选，放 README 顶部或 About 的另一种写法）：

```
Progress narrator for DeepSeek Harness. When the model thinks silently for too long, inject a reminder so it narrates its own progress without ending the turn — and mirror that text in a lower-left overlay aligned with the message column.
```

## 3. Topics 标签

```
deepseek-harness
dsh-plugin
dsh
cordis
llm-agent
agent-ui
progress-monitor
```

## 4. 首次发布 Release

**Tag**：`v0.12.1`
**Title**：`v0.12.1 — 让模型自己汇报进度`

**Release notes**：

```markdown
## 长思考时，先让它说一句，然后接着干

模型长时间只思考不出声，界面上什么都没有，你不知道它是卡住了还是在干活。这个插件解决了这个问题，而且**不结束当前任务**。

### 为什么要绕这一圈

DSH 的代理循环里有这么一条：

```js
if (turnEnds && decision.messages.length === 0) break;
```

一条不带工具调用的纯文本消息会被判定为「回合结束」。所以「先输出一段进度」和「任务别中断」在提示词层面天然冲突。

本插件的做法：静默超阈值时**只记账**，什么都不做；等下一个 step 的边界，在 `agent/pre-step` 这个 waterfall 钩子里往请求多带一条消息。回合就不关了。

### 这个版本有什么

- **话由模型自己说**，插件只给四个要点（正在做什么 / 已完成什么 / 接下来做什么 / 卡在哪）。模板只能拿到工具名和路径，模型知道自己刚才想明白了什么。
- **注入的消息用户看不见**，`source.kind: 'narrator'` + `form: 'notice'` 会被归为 context 节点。想让原文可见，设置卡一个开关。
- **按「多久没出文字」计时**，不是按「某一步跑了多久」。工具调用和思考都不算文字输出。
- **等子智能体时也说话**：浮窗分三段——**还在等** → **正在整理汇报** → **正在汇报**，并说明在等什么。
- **图形设置卡**：分钟级滑杆、可编辑提示词、浮窗透明度与停留时长，即时生效不用重启。
- **子代理默认不汇报**：那些会话界面上看不到，注入纯属浪费一次模型调用。

### 修掉的浮窗定位问题

浮窗本该贴在**对话正文的左下角**，与正文左对齐。之前的实现是这么找参照点的：

```js
document.querySelector('[data-chat-flow]')   // ← 有坑
```

问题在于 `[data-chat-flow]` 在宿主 DOM 里**不止一处**：主聊天列挂一份，`ChatGroupSeat` 的工作步骤面板里还有一份。`querySelector` 只返回文档序第一个，一旦命中的是侧栏或折叠面板那份——它的左边界贴着窗口边缘——算出来的 `left` 只有几个像素，浮窗就贴到了整个窗口最左边、压住侧边栏。

现在按宿主自己 `mainChatRoot()` 的做法筛选：**枚举全部候选 → 排掉侧栏 / 步骤面板内的 / 不可见的 → 取宽度最大的**。主对话列一定是同屏最宽的那块。`ResizeObserver` 同样改成观察全部候选，否则拖侧边栏时浮窗不跟手。

顺带把文档里 14 处「右下角」全部改成「对话区左下角」——位置一直是对的，写错了的是描述。

### 装法

```bash
cp -r dsh-narrator ~/.dsh/profiles/desktop/node_modules/
```

profile 的 `package.json` 里 **`dependencies` 与 `dsh.profile.bundles` 两处都要加**，然后重启 DSH（`agent/pre-step` 是后端钩子，刷新页面不够）。

详见 [README](README.md#安装)。

### 测试

59 项单测 + 25 项端到端探针，全部通过。探针是复刻宿主真实事件契约写的，不是 mock 出来的假时序。

浮窗定位那一条做了变异测试：把「取最宽」改回「取第一个」，测试立刻失败——喂进去的假 DOM 是刻意构造的（`[8px 窄侧栏, 40px 窄嵌套节点, 320px 主列]`，窄的排前面），只有真按宽度筛才对得上。
```

## 5. 发布前自查清单

```bash
cd dsh-narrator

# 语法
node --check lib/index.js && node --check lib/client.js

# 版本号（应和 tag 一致）
node -p "require('./package.json').version"

# 全量测试
npm test                      # 59 项，应全绿
node test/probe.mjs           # 25 项，应全绿
node test/demo.mjs            # 四幕演示，退出码 0

# 确认没有把本机路径写进仓库
grep -rn "C:/Users\|C:\\\\Users\|/Users/ryn05" --include="*.js" --include="*.md" --include="*.mjs" . \
  | grep -v node_modules || echo "干净"
```

仓库地址已填入 README：`https://github.com/Asza-other/dsh-narrator.git`

## 6. 已知的两个发布注意事项

1. **`test/` 里的 `check-status.mjs`、`step-durations.mjs`、`recent-steps.mjs` 需要参数才能跑**（端口 / 会话存档路径）。它们是取证工具，不是自动化测试，`npm test` 不包含它们。
2. **`notes/legacy/` 是 v0.10 及以前那套机制的取证脚本**，对现在的版本无效，留作历史参考。如果不想公开，删掉这个目录即可，不影响任何功能。
