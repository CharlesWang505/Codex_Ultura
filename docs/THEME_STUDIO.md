# Codex 主题工坊

Codex Compass 1.3.25 起提供“主题工坊”，用于在不修改 Codex 安装目录、`.app`、`app.asar` 或 WindowsApps 文件的前提下，为当前 Codex 桌面界面应用本地主题。1.3.26 增加可配置的新任务首页展示区，1.3.27 增加图片主视觉专属布局和“星夜舞台”内置主题，1.3.36 将概念视觉扩展为 8 个 v3 内置主题。

## 工作方式

1. Codex Compass 通过本机 CDP 连接由 Compass 启动或接管的 Codex 页面。
2. 主题运行时只注入一段由 Compass 自己生成的样式脚本。
3. 运行时把主题参数映射到 Codex 的语义颜色变量，并处理壁纸、侧栏、会话区、输入框、菜单、编辑器和终端。
4. 新任务首页可以显示自定义品牌文字、标题、副标题、横幅、右侧装饰图和四张快捷任务卡。
5. 快捷卡只把预设提示词填入官方 Codex 输入框，不会自动发送，也不会绕过 Codex 的正常权限和审批。
6. 进入已有任务后，首页展示区会自动移除；关闭主题会清理样式、DOM、Observer 和事件状态。
7. 通过 Compass 启动 Codex 时，已保存且启用的主题会自动恢复。

当前已针对 Codex Windows 26.707 的主题变量完成验证。Codex 更新后如果内部变量发生变化，Compass 会保留配置，但部分区域可能暂时回到官方样式，需要更新兼容映射。

## 使用方法

1. 打开 Codex Compass 左侧“主题工坊”。
2. 从内置主题中选择一个预设，或点击“复制当前主题”创建自己的副本。
3. 调整颜色、透明度、模糊、圆角、字体和壁纸。
4. 在“首页展示”中修改标题、横幅、右侧图片和四张快捷任务。
5. 开启右上角主题总开关。
6. 点击“保存并应用”。
7. 状态卡显示“Codex 已连接”时，当前 Codex 窗口会立即更新。

如果 Codex 尚未连接，配置仍会保存；下次通过 Compass 启动 Codex 时自动应用。

## 主题包格式

主题包扩展名可以是 `.zip` 或 `.cc-theme`。压缩包根目录必须包含 `theme.json`，可以包含一张或多张 PNG、JPEG、WebP 图片，以及 README 和 LICENSE 文件。

```text
my-theme.cc-theme
├─ theme.json
├─ wallpaper.webp
├─ hero.webp
├─ portrait.png
├─ README.md
└─ LICENSE
```

`theme.json` 示例：

```json
{
  "schemaVersion": 3,
  "id": "my-rose-theme",
  "name": "我的蔷薇主题",
  "description": "本地浅粉壁纸与半透明面板。",
  "author": "Local user",
  "version": "1.0.0",
  "license": "Private",
  "decorativeStyle": "none",
  "wallpaper": "wallpaper.webp",
  "showcase": {
    "enabled": true,
    "eyebrow": "我的主题 · Codex Compass",
    "title": "今天想构建什么？",
    "subtitle": "选择一个方向，或在下方输入你的任务。",
    "heroImage": "hero.webp",
    "portraitImage": "portrait.png",
    "showCards": true,
    "cards": [
      {
        "title": "探索与理解代码",
        "prompt": "请先阅读当前项目，解释关键结构，并指出最值得从哪里开始。",
        "icon": "code"
      },
      {
        "title": "构建新功能",
        "prompt": "请根据当前项目实现一个完整的新功能，先分析现有结构，再编码、测试并汇报结果。",
        "icon": "build"
      },
      {
        "title": "审查代码并提出建议",
        "prompt": "请审查当前项目的代码，优先查找缺陷、回归风险和缺失测试，并给出可执行建议。",
        "icon": "review"
      },
      {
        "title": "修复问题和失败",
        "prompt": "请诊断当前项目中的问题或失败，定位根因，实施修复并运行验证。",
        "icon": "repair"
      }
    ]
  },
  "presentation": {
    "layoutStyle": "editorial",
    "cardStyle": "paper",
    "motifStyle": "roses",
    "headerBadge": "ROSE EDITION",
    "heroPosition": "far-right",
    "overlayStrength": 88,
    "taskWallpaperOpacity": 8,
    "taskMode": "ambient"
  },
  "visual": {
    "accent": "#c95f7b",
    "accentSoft": "#f7dce3",
    "background": "#fff8f9",
    "surface": "#fffdfd",
    "surfaceAlt": "#fbeef1",
    "text": "#39252c",
    "textMuted": "#806b72",
    "border": "#eacbd3",
    "sidebarOpacity": 96,
    "contentOpacity": 94,
    "wallpaperOpacity": 58,
    "blurPx": 16,
    "radiusPx": 14,
    "fontScale": 100,
    "fontFamily": "system",
    "wallpaperFit": "cover"
  }
}
```

字段限制：

- 颜色只接受 `#RRGGBB` 或 `#RRGGBBAA`。
- `fontFamily` 可选 `system`、`serif`、`mono`。
- `wallpaperFit` 可选 `cover`、`contain`、`center`、`tile`。
- `decorativeStyle` 可选 `botanical`、`leaves`、`constellation`、`manuscript`、`none`。
- `showcase.heroImage`、`showcase.portraitImage` 只能指向主题压缩包内的 PNG、JPEG 或 WebP。
- 快捷卡图标可选 `code`、`build`、`review`、`repair`，最多四张。
- 快捷卡只会填写提示词，不会自动点击发送。
- `presentation.layoutStyle` 可选 `editorial`、`fortune`、`future`、`paper`、`doodle`、`cosmic`、`idol`、`stage`。
- `presentation.cardStyle` 可选 `glass`、`paper`、`solid`、`outline`；`taskMode` 可选 `ambient`、`banner`、`off`。
- `presentation.taskWallpaperOpacity` 只用于已有任务页，最大值为 28；主题运行时会优先保证对话正文可读。
- 单个壁纸最大 8 MB，主题压缩包最大 12 MB，解压后最大 18 MB。
- 最多 24 个压缩包条目，主题库最多保存 32 个主题。
- Theme v1/v2 包仍可导入；保存后会迁移为 v3。用户修改过的壁纸、标题、卡片和颜色不会被内置主题升级覆盖。

仓库内的 [主题包示例](./theme-package-example/README.md) 可以直接作为制作起点。

## 安全边界

主题包不会获得脚本执行能力。导入器会拒绝：

- JavaScript、TypeScript、CSS、HTML、可执行文件和未知文件类型。
- HTTP、HTTPS、`file:` 或 `data:` 远程/内联壁纸地址。
- 绝对路径、`..`、反斜杠路径和其他压缩包路径穿越形式。
- 超出文件数量、压缩包大小、解压大小或图片大小限制的内容。
- 自定义 SVG；SVG 只用于 Compass 内置且随程序生成的装饰壁纸。
- 超过四张快捷卡、超长标题或超长提示词。

壁纸和主题配置仅保存在当前 Windows 用户的 Codex Compass 数据目录，不会上传到中继服务器。

## 参考项目

本功能研究了以下开源项目的安装边界、主题包组织和用户工作流，但没有复制其代码、人物图片或主题资产：

- `Fei-Away/Codex-Dream-Skin`
- `tree0519/Codex-Dream-Skin-Forge`
- `charmber/codex-skin`
- `aithink001/Codex-Dream-Skin-Themes`
- `roland-luo/codex-dream-skin`
- `shuyixiao-better/codex-custom-theme-skill`

实现参考了这些仓库对 Codex 首页锚点、原生建议卡、输入框融合、宽图安全区、CDP 生命周期和声明式主题包的处理方式。导入第三方主题前，应自行检查其许可证和图片授权。参考截图中的人物、商标和装饰素材不会作为 Codex Compass 内置资产分发。
