# dsh-narrator

> 模型想得太久时，先替它说一句话，然后让它接着干。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。解决一个很具体的问题：**模型长时间只思考、不出声时，界面上什么都没有，你不知道它是卡住了还是在干活。**

装上之后，模型静默超过 N 分钟，它会自己用一段正文说清「在做什么、做到哪了、接下来干什么」，**任务不中断**；对话区左下角浮窗同步显示这段原文。

![进度旁白浮窗：模型思考 12 分钟没有任何正文输出时，左下角浮窗显示它刚才说清的四点进展](assets/screenshot-1.png)

---

## 为什么这件事不简单

DSH 的代理循环里有这么一条（宿主源码 `dsh-agent-loop`）：

```js
const stepEnd = await this.step(decision);
if (turnEnds && decision.messages.length === 0) break;
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial("agent/turn-stopping", { turn, signal });
}
if (turnEnds && this.inbox.nextStep.length === 0) break;
```

**一条不带任何工具调用的纯文本消息，会被判定为「回合结束」。** 所以在提示词里要求模型「中途说一句」是不管用的——它真说了，回合就停了。这是宿主语义层的限制，不是插件能绕的小聪明。

本插件的做法：静默超阈值时**只记账**，什么都不做；等**下一个 step 的边界**，在 `agent/pre-step` 这个 waterfall 钩子里往请求多带一条消息。`decision.messages.length` 不为 0，回合就不关。

```
模型只思考、不出声
      │
      ▼   静默超过阈值（默认 60 秒）
只记一笔「该汇报了」          ← 界面上什么都还没动
      │
      ▼   下一个 step 边界
注入一段提示词
      │
      ▼
模型用正文说一段
      │
      ├─→ 对话区左下角浮窗显示这段原文
      └─→ 正文继续走，回合不关闭
```

## 特点

- **话是模型自己说的。** 插件只给四个要点（正在做什么 / 已完成什么 / 接下来做什么 / 卡在哪），具体内容由模型按当下情况写。模板只能拿到工具名和路径，模型知道自己刚才想明白了什么。
- **注入的消息用户看不见。** `source: { kind: 'narrator', form: 'notice' }` 会被客户端归为 context 节点，界面隐藏，但模型照样读得到。想让原文可见，设置卡里一个开关。
- **按「多久没出文字」计时，不是按「某一步跑了多久」。** 工具调用、思考都不算文字输出。模型连续调二十次工具却一句话不说，恰恰最该提示。
- **等子智能体时也说话。** 主窗口派出子代理后那一步可能挂着几分钟。浮窗分三段：**还在等** → **正在整理汇报** → **正在汇报**，会告诉你它在等什么（等子任务 / 查资料 / 跑命令 / 读文件）。
- **图形设置卡。** 分钟级滑杆、可编辑提示词、浮窗透明度与停留时长，全部即时生效不用重启。
- **浅色深色通用。** 全部颜色走宿主的 `--dsw-alias-*` 令牌，深色主题下浮窗自己切一套底色与描边。

![深色主题下的同一个浮窗](assets/screenshot-4.png)

## 安装

前置：DeepSeek Harness **0.2.1+**（`dsh.client` 与 `shell.overlay` 槽位依赖它）、Node.js **18+**。零运行时依赖，不需要 `npm install`。

> 面向普通用户的图文版说明见 [安装与功能说明.md](安装与功能说明.md)（安装 + 配置 + 排错）和 [功能介绍.md](功能介绍.md)（不读源码也能看懂它解决什么问题）。下面这段是给开发者的速览。

**1. 拷贝到 profile 的 `node_modules`**

```bash
git clone https://github.com/Asza-other/dsh-narrator.git
cp -r dsh-narrator ~/.dsh/profiles/desktop/node_modules/dsh-narrator
# Windows: %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-narrator
```

`desktop` 换成你自己的 profile 名（DSH 设置里能看到）。

**2. 改 profile 的 `package.json`，两处都要加**

```jsonc
{
  "dependencies": {
    "dsh-narrator": "file:../../path/to/dsh-narrator"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-narrator"]
    }
  }
}
```

> ⚠️ **`dependencies` 与 `dsh.profile.bundles` 缺一不可。** 只加 `bundles`，pnpm 重装时会被清掉；只加 `dependencies`，插件根本不加载。改完如果 DSH 自动跑了一次 `pnpm install`，**回头复查 `bundles` 数组还在不在**——插件管理器重写这个文件时有过把条目清掉的先例。

**3. 重启 DSH**

`agent/pre-step` 是后端钩子，刷新页面不够，必须重启进程。

**4. 验证**

设置里出现 **设置 → 进度旁白** 就是装好了。

```bash
curl http://127.0.0.1:<端口>/api/narrator/status
# {"ok":true,"version":"0.12.6",...}
```

端口看 DSH 窗口地址栏。这个路由只在 `127.0.0.1` 上响应，外部访问不到。

## 配置

设置页 → 左侧「进度旁白」。主要几项：

![设置卡：阈值、间隔、浮窗透明度与停留时长都是分钟/秒级滑杆，下方是可整段替换的提示词](assets/screenshot-2.png)

| 项目 | 默认 | 说明 |
|---|---|---|
| 让模型定期汇报 | 开 | 总开关 |
| 多久没有文字输出就让它说一句 | 1 分钟 | 1~60 分钟，线性滑杆或直接填数字 |
| 两次汇报至少间隔 | 1 分钟 | 防止刷屏。设得越小越频繁 |
| 汇报内容怎么给模型说 | 内置四点式 | 可整段替换；留空即用默认 |
| 在对话里显示这条提示词 | 关 | 开了之后 `source.kind` 换成 `user`，对话流里能看到注入原文 |
| 同时把汇报内容弹到对话区左下角浮窗 | 开 | 关掉后仍然注入，只是不显示浮窗 |
| 子任务里也照样汇报 | **关** | 子代理会话界面上看不到，注入纯属浪费一次模型调用 |
| 浮窗透明度 | 100% | 35%~100%，只影响浮窗底色 |
| 浮窗停留多久后自动消失 | 90 秒 | 5 秒~600 秒 |

保存和「恢复默认」固定在卡片下沿（`position: sticky`），滚到哪里都点得到。底栏还向下多涂了一截底色：宿主的滚动容器自己在滚动区里留了 24px 内边距，光靠 `bottom: 0` 盖不住那一段，滚过去的文字会从按钮底下露出来。

![滚到底时的效果：保存与恢复默认贴在卡片下沿，按钮下面的底色一直铺到面板底边，不会透出滚动过去的文字](assets/screenshot-3.png)

底部的「测试」区块可以把阈值临时压到几秒，方便当场看效果；关掉后恢复真实配置，**真实配置一个字节都没被改过**。

实测单步耗时通常 **5~7 秒**。建议：想经常看到选 1 分钟，只在明显卡住时提示选 3~5 分钟。设成 30 分钟以上基本不会触发。

配置写到 `~/.dsh/narrator/config.json`，优先级高于部署时在 `cordis.patch.yml` 里预置的值。旧版配置里的键会被**静默忽略**，不会报错。

## 已知限制

1. **注入不是硬保证。** 机制能保证回合不关闭，但模型自己写完就停下来，那还是会停。默认提示词末尾的「说完必须继续执行，不要结束任务」就是在防这个。
2. **注入有延迟。** 到点只是记账，真正注入要等下一个 step 边界。如果那一步在等子智能体，可能要多等几分钟——浮窗这期间显示「还在等」，所以不会看起来像卡死。
3. **只支持 web 端。** 没有做桌面外壳的原生 UI。
4. **前端改动要刷新页面。** 后端配置即时生效，但 `client.js` 的改动需要刷新页面重新拉 bundle。

## 开发

```bash
npm test                # 67 项单测
node test/probe.mjs     # 25 项端到端探针，模拟宿主真实事件时序
node test/demo.mjs      # 四幕演示，不需要装 DSH
node test/check-status.mjs <端口>   # 读运行中插件的自检数据，给人话诊断
```

`test/` 下的探针是复刻宿主真实事件契约写的（`agent/assistant-stream` 的 frame 结构、`agent/pre-step` 的 waterfall 语义），不是 mock 出来的假时序。

---

## 深入：四条工程约束

这几条都是踩过的坑，改代码时别踩回去。

1. **`agent/pre-step` 是 waterfall。** 签名是 `(payload, next) => decision`，必须 `await next()` 拿到下游决策，再把消息并进去。别在 `next()` 之前 return。
2. **只有 `decision.kind === 'enter'` 才能往里塞消息。** `reject` 表示宿主已经决定不进入这一步。
3. **别用 `session.append` 硬插 assistant 消息。** 除了语义错误（会被同 step 的真实回复整体覆盖），还有三条暗礁：必须带 `reasoning` block、必须带 `stream: []`、**绝不能传 `sourceEventSeqs`**（宿主 `SessionPersistence` 对 `assistant/message` 有硬校验：`raw !== void 0` 就抛）。v0.11 起已经不写这条路了。
4. **判「是不是子代理」只能看 `session.header`。** 宿主 `ReactLoopAgent` 的字段只有 `loopCtx / id / options / session / inbox / phase / activityDone / scope / ctx / dispatch`，**没有 `parent`、`parentSessionId`、`kind`、`role`**。真正的判据是两个会话头字段：`session.header.origin === 'subagent'` 与 `session.header.parentSession`。曾按那批宽松字段判断，结果 `includeSubagents: false` 在真实宿主上**永远不生效**。

### 与宿主原生格式的对照

| 本插件的做法 | 宿主原生对应 | 说明 |
| --- | --- | --- |
| `agent/pre-step` 注入 | 宿主自己的 runtime context | 同一个 waterfall，排在后面追加 |
| `source.kind: 'narrator'` + `form: 'notice'` | `webhook` / `subagent-settled` 等 | 都走「归为 context、界面隐藏」这条路 |
| `source.kind: 'user'`（显示原文时） | 用户真实发言 | 只为了让 `isVisibleChatNode` 放行 |

### 静默计时的语义

触发基准是「**距最后一次正文输出的时长**」，不是「某一步跑了多久」。这张表是定稿语义：

| 事件 | 重置计时器？ | 说明 |
| --- | --- | --- |
| `text-delta`（非空） | 重置 | 这是「文字输出」，用户能看见 |
| `block-start`（`blockType: 'text'`） | 重置 | 同上 |
| `block-start`（`blockType: 'tool-call'`） | **不重置** | 调工具不是说话 |
| `tool-call-delta` | **不重置** | 密集调工具恰恰是最该提示的场景 |
| `reasoning-delta` | **不重置** | 想多久都不算开口 |
| step `start` | 同回合内沿用，不归零 | 跨 step 累计，不因换步清零 |
| step `end` | 只记时长，不清状态 | 清状态会让定时器在换步时被取消 |
| `turn/end` | 清零 | 新回合从用户发言重新开始 |

注入成功之后同时把计时器推到现在——汇报本身算一次可见输出，否则定时器一醒就判定「仍然静默」而连发。

### 浮窗停在哪

贴在**对话正文的左下角**，与正文左对齐：纵向悬在输入框上方 16px 处，横向取消息列的左边界，读起来像一条跟着对话走的批注。

那个位置不是写死的，每次布局变化都重量一次（`ResizeObserver` + `requestAnimationFrame` 合并，拖侧边栏时不会掉帧）：

```
left   ← [data-chat-flow] 的左边界（扣掉 overlayLayer 的偏移）
bottom ← overlayLayer 底边 − [data-composer-seat] 顶边 + 16px
```

⚠ 这里有个必须知道的坑：**`[data-chat-flow]` 在宿主 DOM 里不止一处**（主聊天列一份，`ChatGroupSeat` 的工作步骤面板里还有一份）。`document.querySelector` 只返回文档序第一个，很容易命中侧栏那份——它的左边界贴近窗口边缘，算出来的 `left` 只有几个像素，浮窗就贴到整个窗口最左边、压住侧边栏，看起来像「跑到左下角了」。

所以这里按宿主自己的做法筛选：**枚举全部候选 → 排掉 `[data-sidebar-right-session]` / `[data-step-process-body]` 内的、排掉不可见的 → 取宽度最大的那个**。主对话列一定是同屏里最宽的那块。`lib/client.js` 的 `measureSeat()` 里有完整注释，`test/client-render.test.mjs` 里有对应的回归用例（喂一份「窄的在前面、宽的在后面」的假 DOM，断言取到宽的那个）。

### 浮窗的三个阶段

静默到点后，真正的注入要等下一个 step 边界。主窗口调子代理时这个 step 可能挂着好几分钟，等它结束再亮卡，用户早就以为卡死了。所以浮窗分三段：

| 阶段 | 标题 | 正文 |
| --- | --- | --- |
| 到点，还没到 step 边界 | **等这一步跑完再汇总** / **等这一步结束再汇总** | 上一段原文（如果有）+ 一行「正在等子任务返回，已经等了 42 秒」 |
| 已注入，模型在憋那段话 | **正在整理汇报** | 同上，等待行换成「模型正在整理这次汇报」 |
| 模型开口了 | **正在汇报** | 模型的原话，替换掉整张卡 |

标题随「此刻在不在等工具返回」二选一：有工具在跑说「等这一步跑完再汇总」，没工具（等 step 边界）说「等这一步结束再汇总」。两句话说的是同一件事——**step 没结束，模型还没机会开口**，差别只在于要不要顺带点出是哪个工具在拖。

两条容易踩的细节：

- **上一段原文必须留着。** 早期实现到点后直接写一条 `text: ''` 的新记录，结果是模型刚汇报完、静默重新起算，到点那张卡「啪」地变成空白——用户眼前的信息反而变少了。现在只翻开 `pending` 标记，原文原地保留。
- **`phase` 不能被降级。** 模型已经拿到「请汇报」的提示、正憋那段话时，这段静默恰恰是它在整理汇报，界面该说「正在整理汇报」；无条件写回 `working` 会让用户以为提示词没送到。

### 浮窗怎么渲染正文

正文按空行切段、段内换行原样保留。**唯独认 GFM 表格**：

```
| 变异 | 报错 |
| --- | --- |
| 把 delete 挪回判空之前 | 「先调工具后说话的汇报原文不能丢」 |
```

模型很爱在汇报里用表格对比数据，原样渲染的话竖线和 `---` 会直接糊在正文里，比不渲染还难读。所以这里认表格，其余语法（标题 `##`、粗体 `**`、列表）一律不解析——**只认这一种，认错了顶多多出几个 `|` 字面量，不会像完整 markdown 解析那样把正文吞掉**。

三条保守判据，任意一条不满足就退回纯文本：

| 判据 | 防的是什么 |
| --- | --- |
| 表格必须从段首开始 | 正文中途冒出两行带竖线的句子（比如讲管道运算符），不该被拆成格子 |
| 第二行必须是分割行（`\|---\|:--:\|`） | 只靠「连续多行都有竖线」判表格，会把普通句子硬拆 |
| 表头与分割行列数一致 | 模型手滑多写一列时，宁可当纯文本显示，也不能丢字 |

反引号里的竖线不算分隔符（`` `a|b` `` 是一个单元格，不是两个），否则讲管道运算符的表格必错。列数不齐时补齐/截断，避免 React 渲染出缺格的行。

### 浮窗什么时候走

出现容易，消失的语义反而更难定。三条规则：

1. **模型重新开口，浮窗立刻撤。** 浮窗是「模型长期不出声」时的信息补位；它一开口，你就有新东西可看。判据来自服务端的 `assistant-stream` 事件流（`text-delta` 上的时间戳），不靠 DOM——虚拟滚动、代码高亮、折叠面板都会让 DOM 乱动。
2. **汇报原文本身不算「新正文」。** 写浮窗记录时会把「当时的最后一次正文时刻」冻结进记录（`textAt` 字段），前端比的是「记录之后又说过话没有」。所以不会出现「模型刚写完汇报，浮窗一闪就消失」。
3. **叉掉就是叉掉。** 关闭状态按「哪一条汇报」记（记录的 `at`）：切走再切回同一条汇报不再弹出，等下一条新汇报才重新出现，不会变成永久失聪。子代理的输出也进不了这个判据——等子任务那几分钟恰恰最需要这张卡。

第 1 条的判据在服务端，所以**升级到 v0.12.6 后必须重启 DSH 进程**（不只是刷新页面）才会生效。前端会回落到 `at` 兜底，功能不坏，但对「模型中途说了句话」不如新版敏感。

### 运行期自检

设置卡填不出效果时，先看统计：

```
GET /api/narrator/status
```

```json
{
  "ok": true,
  "version": "0.12.6",
  "config": { "silentSeconds": 60, "cooldownSeconds": 60, "lingerSeconds": 90 },
  "stats": {
    "startFrames": 41, "chunkFrames": 22793, "endFrames": 41,
    "stepsSeen": 41, "preSteps": 40, "injected": 3, "captured": 2,
    "skipped": {
      "disabled": 0, "subagent": 0, "cooldown": 12,
      "maxPerTurn": 0, "notSilent": 24, "notDue": 1,
      "badShape": 0, "overlayOff": 0
    },
    "lastError": null
  }
}
```

| 现象 | 看哪个字段 | 含义 |
| --- | --- | --- |
| 一次都没触发 | `stepsSeen` / `startFrames` 是否在涨 | 为 0 说明事件没派发到插件 |
| 涨了但 `injected: 0` | `skipped.notSilent` | 步骤都太短，没到阈值。把阈值调小或开测试模式 |
| | `skipped.notDue` | 到点了但还没等到 step 边界（正常状态） |
| | `skipped.cooldown` | 被冷却挡住 |
| `injected` 涨了但浮窗空 | `captured` | 为 0 说明模型被提醒后没输出正文（或直接调了工具） |
| 全都没动 | `stats === undefined` | 宿主跑的是旧代码，重启 |

也可以直接跑 `node test/check-status.mjs <端口>`，它会打印人话诊断。

### 测试的五条铁律

1. **必须隔离配置。** 所有测试都要在 `import` 插件**之前**设 `process.env.DSH_NARRATOR_CONFIG`，否则用户真实配置会污染断言（曾因此 12 项假失败）。
2. **`node --test test/` 会失败**，必须显式列出文件。
3. **断言不许用 `?.` 包住核心判断。** 曾写 `ctx._latestBySession?.set?.()` 这种不存在的对象，断言静默跳过，测试绿着但什么都没验。
4. **浮层测试必须清定时器。** 组件里有 `setInterval`，不清理 node 永不退出。
5. **CSS 修复要能拦住「改回去」。** 修完 bug 顺手把变异试一遍——删掉关键声明、把数值调小、换成被否决的写法，测试都必须失败。设置卡底栏那条缝就是这么验的（见 `test/client-render.test.mjs` 里 `.narr-foot` 的 box-shadow 断言）。

---

## 和其它插件的边界

| 插件 | 关系 |
|---|---|
| [`dsh-step-pause`](https://github.com/cxv117793-blip/dsh-step-pause) | 触发机制参考了它（`agent/pre-step` 注入）。差别：它按**步数**触发，本插件按**静默时长**触发，且把模型说的那段抽出来显示在浮窗 |
| `dsh-call-guard` | 互补。它管「工具调用被烧成文字导致回合假完成」，本插件管「长时间不说话」 |
| `dsh-thinking-guard` | 反向。它在纯思考超时后 `agent.cancel()` **中止**回合，本插件是让任务**继续** |
| `dsh-gap-feed` | 同床异梦。它也往对话流插卡片，但内容是外部新闻 |

## License

MIT
