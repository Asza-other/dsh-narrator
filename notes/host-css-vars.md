# 宿主真实变量清单（来自 app.asar 实测，共 405 个 --dsw-* 定义）
#
# 插件里**曾经用错**、宿主根本不存在的变量（全部 MISS，靠 fallback 硬编码值渲染，
# 这就是下拉框在浅色主题下显示黑底的原因）：
#   --dsw-text-primary      MISS
#   --dsw-text-secondary    MISS
#   --dsw-accent            MISS
#   --dsw-border-subtle     MISS
#   --dsw-surface-raised    MISS
#   --dsw-border-strong     MISS
#   --dsw-surface-overlay   MISS
#   --dsw-surface-hover     MISS
#   --dsw-danger            MISS
#   --dsw-font-mono         MISS
#   --dsw-alias-bg-elevated MISS
#
# 宿主真实存在、且浅色/深色两套主题都有定义的变量（应改用这些）：
#   --dsw-alias-bg-layer-1          卡片底色
#   --dsw-alias-bg-layer-2          浮起/悬停底色（下拉菜单用这个）
#   --dsw-alias-bg-layer-3
#   --dsw-alias-label-primary       主文字
#   --dsw-alias-label-secondary     次文字
#   --dsw-alias-border-l1          弱边框
#   --dsw-alias-border-l2          常规边框
#   --dsw-alias-border-l3          强边框
#   --dsw-alias-brand-primary      品牌主色（蓝色）
#   --dsw-alias-state-error-primary   错误色
#   --dsw-alias-state-warn-primary    警告色
#   --dsw-radius-sm / -md / -lg / -xl  圆角
#
# 校验命令：
#   python -c "import re;t=open(r'<DSH 安装目录>/resources/app.asar','rb').read().decode('utf-8','ignore');n=set(re.findall(r'--dsw-[a-z0-9-]+(?=\s*:)',t));print(len(n))"
host_vars_ok = [
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-layer-3',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-border-l3',
    '--dsw-alias-brand-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-radius-sm',
    '--dsw-radius-md',
    '--dsw-radius-lg',
    '--dsw-radius-xl',
]
