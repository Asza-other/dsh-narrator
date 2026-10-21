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

已有 Release：**v0.12.2**（首个公开版）、**v0.12.4**。

> v0.12.3 曾打过 tag 与 Release，后来撤掉了；它的全部改动都含在 v0.12.4 里，下面的记录留着当过程稿。

**当前要发**：`v0.12.5`

---

### v0.12.5

**Tag**：`v0.12.5`
**Title**：`v0.12.5 — 修掉六个 bug，浮窗不再自己把自己撤掉`

**Release notes**：

```markdown
## 这个版本只修 bug

六处，全部来自实际跑起来之后发现的毛病。

### 一、浮窗在模型正写总结时消失

最严重的一个。插件让模型开口汇报，模型刚写出第一段总结，浮窗就没了。

原因是撤卡判据把「模型又开口了」当成「浮窗该走了」，而汇报原文自己也是一串文字输出。于是浮窗被它正在展示的那段话撤掉。

现在区分了两件事：插件截取窗口**之内**的文字是「被要求说的汇报」，不推进撤卡时钟；窗口**之外**的文字才是模型自发开口，那时才撤。总结写完浮窗留着，你什么时候看见都行，等下一次真开口才走。

### 二、模型先干完活再说话时，汇报原文被丢

截取窗口有超时。模型被要求汇报后常先把手上的工具调完，这期间缓冲区一直空着，等到真开口时窗口已经过期关掉了，那段话就落空。

超时只是防泄漏的兜底，不代表模型不会晚一步说话。现在超时只清状态，不丢已经等在那里的窗口。

### 三、浮窗标题每几秒翻一次

「等这一步跑完再汇总」和「正在整理汇报」来回跳。两条规则打架：工具调用会推进相位，冷却到点又推回去。

现在相位一旦推进到「整理汇报」就稳住，只有窗口超时才退回。两害相权，一个稳定的标题好过一个每几秒跳一次的。

### 四、分支会话被当成子代理，一次都不汇报

从某个对话分叉出来的会话同样带 `parentSession`，被误判成子代理直接跳过。实测累计跳过 28 万次，等于插件对这类会话完全失效。

判据改成看 `origin === 'subagent'`；有 `parentSession` 时还要配合 `delegationDepth > 0` 才算。

### 五、等待态正文重复一遍标题

标题已经写了「等这一步跑完再汇总」，第二行又来一句「等它返回后，这一步才会汇总」，白占一行高度。删掉。

### 六、代码块后面的表格退化成竖线文字

代码块紧跟着表格时，表格认不出来。切开围栏后文字段开头留着一个空行，导致第一行是空串、真表头被当成第二行，表格判据直接判定失败。

空行本来就是分段用的，不属于任何一段内容，现在剥掉。

### 顺带

浮窗现在也认得了表格、标题、列表、粗体和斜体——之前是原样把 `##`、`**`、`|` 印在脸上。这部分不是 bug 修复，只是终于能看了。

### 装法

```bash
cp -r dsh-narrator ~/.dsh/profiles/desktop/node_modules/
```

profile 的 `package.json` 里 **`dependencies` 与 `dsh.profile.bundles` 两处都要加**，然后重启 DSH（`agent/pre-step` 是后端钩子，刷新页面不够）。

详见 [README](README.md#安装)。

### 测试

67 项单测 + 25 项端到端探针，全部通过。上面六个 bug 每一个都有回归测试兜底，并且都做了变异验证——把关键判据改回去，测试立刻失败。
```

---

### v0.12.4（历史，已发布）

**Tag**：`v0.12.4`
**Title**：`v0.12.4 — 修掉两个 bug：分支会话不汇报、浮窗刚亮就消失`

**Release notes**：

```markdown
## 这个版本只修 bug

两个，都是线上跑起来之后才暴露的。

### 一、分支会话被当成子代理，一次都不汇报

从某个对话分叉出来的新会话，用户正常查看、正常使用，但它同样带着 `parentSession` 字段。旧判据把「有 `parentSession`」直接当成子代理，于是这类会话被静默跳过。

线上表现是 `skipped.subagent` 一路涨到 28 万，插件等于完全没工作。

拿 58 个会话存档的 header 对比之后才看清区别：分支会话 `origin` 是 `undefined`、`delegationDepth` 是 `0`；真子代理 `origin` 是 `'subagent'`、`delegationDepth` 是 `1`。

现在以 `origin === 'subagent'` 为准；有 `parentSession` 时还要配合 `delegationDepth > 0` 才算子代理。修复后 `skipped.subagent` 归零。

### 二、浮窗刚亮起就被自己撤掉

浮窗重新亮卡时会带上一条旧记录，里面冻着「上一次模型说话的时刻」。但模型后来说过话，服务端的时钟早就往前走了。前端判据是「现在的最后正文时刻 > 记录里的时刻」，一比就成立——卡片刚立起来就被判定为「模型又开口了」，立刻消失。

实测差 7341 毫秒。

现在重新亮卡时刷新基准：这张卡诞生时，此前所有正文都已经被听见了，不该再拿它们当撤卡理由。

### 装法

```bash
cp -r dsh-narrator ~/.dsh/profiles/desktop/node_modules/
```

profile 的 `package.json` 里 **`dependencies` 与 `dsh.profile.bundles` 两处都要加**，然后重启 DSH（`agent/pre-step` 是后端钩子，刷新页面不够）。

详见 [README](README.md#安装)。

### 测试

61 项单测 + 25 项端到端探针，全部通过。新增两条 `isSubagent` 回归，用的是真实的 header 形状。
```

---

### v0.12.3（已撤，未发布）

**Tag**：`v0.12.3`
**Title**：`v0.12.3 — 修掉两个毛病：浮窗该走不走、保存栏上跳`

**Release notes**：

```markdown
## 这个版本只修 bug

两个，都是长时间用下来才注意到的。

### 一、模型早就说话了，浮窗还赖着

长任务跑到一半，模型明明已经输出过正文，浮窗却不消失。

原因是判据里混进了「任务还在跑吗」这个条件。长任务期间的 `running` 一直是真，于是浮窗永远不会被撤掉，设定的停留时长形同虚设。

现在只看「模型是否重新开口」：插件注入的汇报原文不算，那之后又说过话才算。

### 二、叉掉浮窗后，切走再切回又冒出来

用户叉掉浮窗就是在说「我看过了」。但代码里有个 effect，一换会话就把关闭状态清零，于是切走再切回来，同一张卡又弹一次——叉按钮等于没生效。

现在关闭状态按「哪一条汇报」记：切走再切回同一条汇报不再弹出，等下一条新汇报才重新出现。不是永久失聪。

### 三、设置卡滚到底时保存栏上跳 4px

`position: sticky` 的行程受包含块 padding box 限制。

根容器原来是 `padding: 4px 2px`，底部那 4px 内边距让底栏最多只能贴到内容盒底边，于是滚到底的一瞬间比平时高出 4px，看着像按钮自己往上跳了一下。

改成 `padding: 4px 2px 0` 后实测：滚到底前后底栏位置都是 616，不动了。

### 顺带修掉的设置卡底栏透字

保存按钮条下面空着一条约 26 像素的带子，滚过去的提示词文字从按钮底下露出来。

那 26 像素是宿主滚动容器的 `padding-bottom`（24px）加 1px 边框，属于滚动区，不是插件的错。给底栏加一条向下外溢的实心阴影把那截涂成底色，不参与布局、不拦截点击，超出的部分由宿主裁掉。

试过绝对定位的伪元素方案，它会把滚动高度撑大 12 像素，滚到底凭空多出一截空白，所以没用。

### 装法

```bash
cp -r dsh-narrator ~/.dsh/profiles/desktop/node_modules/
```

profile 的 `package.json` 里 **`dependencies` 与 `dsh.profile.bundles` 两处都要加**，然后重启 DSH（`agent/pre-step` 是后端钩子，刷新页面不够）。

详见 [README](README.md#安装)。

### 测试

59 项单测 + 25 项端到端探针，全部通过。底栏那条有回归测试：删掉阴影、把 40px 改成 8px、改回伪元素，三种变异都会让测试失败。
```

## 5. 发布前自查清单

```bash
cd dsh-narrator

# 语法
node --check lib/index.js && node --check lib/client.js

# 版本号（应和 tag 一致）
node -p "require('./package.json').version"

# 全量测试
npm test                      # 67 项，应全绿
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
