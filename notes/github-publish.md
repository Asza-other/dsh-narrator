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

## 4. 发布 Release

**Tag**：`v0.12.3`
**Title**：`v0.12.3 — 浮窗该走时就走，设置卡不再跳`

> 已有的 Release：v0.12.2（首个公开版，底栏透字修复）。
> v0.12.3 是增量：浮窗消失语义 + 底栏上跳，并在 v0.12.2 的正文基础上
> 补了「浮窗什么时候出现、什么时候走」一节。发新 Release 时直接用下面
> 这份完整正文即可（它已包含 v0.12.2 的全部内容）。

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

### 浮窗什么时候出现、什么时候走

这三条是用户实测反馈后重做的，与早期版本的行为不同：

1. **模型重新开口，浮窗立刻撤。** 浮窗是「模型长期不出声」的信息补位；它一开口，你就有新东西可看。判据来自服务端的 `assistant-stream` 事件流（`text-delta`），不靠 DOM——虚拟滚动、代码高亮、折叠面板都会让 DOM 乱动。
2. **汇报原文本身不算「新正文」。** 写浮窗记录时会把「当时的最后一次正文时刻」冻结进记录，前端比的是「记录之后又说过话没有」。所以不会出现「模型刚写完汇报，浮窗一闪就消失」。
3. **叉掉就是叉掉。** 关闭状态按「哪一条汇报」记：切走再切回同一条汇报不再弹出；等下一条新汇报才重新出现，不会变成永久失聪。子代理的输出也进不了这个判据——等子任务那几分钟恰恰最需要这张卡。

### 修掉的浮窗定位问题

浮窗本该贴在**对话正文的左下角**，与正文左对齐。之前的实现是这么找参照点的：

```js
document.querySelector('[data-chat-flow]')   // ← 有坑
```

问题在于 `[data-chat-flow]` 在宿主 DOM 里**不止一处**：主聊天列挂一份，`ChatGroupSeat` 的工作步骤面板里还有一份。`querySelector` 只返回文档序第一个，一旦命中的是侧栏或折叠面板那份——它的左边界贴着窗口边缘——算出来的 `left` 只有几个像素，浮窗就贴到了整个窗口最左边、压住侧边栏。

现在按宿主自己 `mainChatRoot()` 的做法筛选：**枚举全部候选 → 排掉侧栏 / 步骤面板内的 / 不可见的 → 取宽度最大的**。主对话列一定是同屏最宽的那块。`ResizeObserver` 同样改成观察全部候选，否则拖侧边栏时浮窗不跟手。

顺带把文档里 14 处「右下角」全部改成「对话区左下角」——位置一直是对的，写错了的是描述。

### 修掉的设置卡两个毛病

**一、保存按钮下方的透明带会透字。**

保存栏用 `position: sticky; bottom: 0` 固定在卡片下沿，但滚到底时它被自己的包含块拽住，下沿对不上滚动视口下沿。同时宿主设置面板的滚动容器 `.wCInkW_options` 在滚动区里留了 **24px** 的 `padding-bottom`，那 24px 属于滚动区——于是按钮条下面必然空出一条带子，滚过去的提示词文字就从按钮底下露出来。

给底栏加一条向下偏移的实心 `box-shadow: 0 40px 0 0` 把那截涂成底色。试过 `::after` 绝对定位，它会把 `scrollHeight` 撑大 12px，滚到底凭空多出一截空白，所以弃用。阴影不参与布局、不拦截点击，超出的部分由宿主的 `overflow: hidden` 裁掉。浅色与深色主题走同一个 `--dsw-alias-bg-layer-1`，不需要额外分支。

**二、滚到最下面时保存按钮会上跳 4px。**

`.narr-root` 原来有 `padding: 4px 2px`，底部那 4px 内边距就是元凶：sticky 的行程受包含块 padding box 限制，滚到底时底栏最多贴到内容盒底边，于是比「贴住视口下沿」时高出 4px。改成 `padding: 4px 2px 0` 后，实测滚到底前后 `footBottom` 都是 616，不动了。

两条都有回归测试兜底，并且都做了变异验证——把关键声明改回去，测试立刻失败：

| 变异 | 失败的断言 |
|---|---|
| 删掉底栏 `box-shadow` | 必须向下外溢实心底色 |
| 把 40px 改成 8px | 向下偏移要够盖住 24px |
| 改回 `.narr-foot::after` | 不要用伪元素方案 |
| 根容器改回 `padding: 4px 2px` | 底栏上跳 4px |

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

## 7. 这个版本删掉了什么

`notes/legacy/` 下 6 个脚本（`audit-archive.mjs`、`diag-cards.mjs`、`find-narration.mjs`、`probe-reset.mjs`、`render-real-report.mjs`、`rm-choiceselect.mjs`）是 v0.10 及以前那套机制的取证工具，对现在的版本全部失效，其中 `rm-choiceselect.mjs` 更是一次性删除脚本（对着一份早已没有 `ChoiceSelect` 的代码已无意义）。公开发布前删掉，历史仍留在 git 里。
