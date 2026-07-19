# Codex Compass（法典指南针）

Codex Compass（中文名：法典指南针）是一款基于 Tauri 2、Rust、React 19 和 TypeScript 的 Windows 桌面工具，把 **New API / One API 账户监控、Codex 管理、8787 模型热切换和代理节点测速** 集中在一个应用中。

本项目参考并基于 [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) 与 [codex-api-hot-switch](https://github.com/BandengHu/codex-api-hot-switch) 的部分功能进行整合和完善，目标是让用户通过一个配套软件完成中转站查看、供应商配置、模型注入、热切换和常用 Codex 维护。

**当前稳定版：v1.3.57（2026-07-19）**

## 下载

请只从本项目的 [GitHub Releases](https://github.com/CharlesWang505/Codex_Compass_Conprehensive/releases/latest) 下载。

| 版本 | 文件 | 适用场景 |
| --- | --- | --- |
| 安装版 | [Codex.Compass_1.3.57_x64-setup.exe](https://github.com/CharlesWang505/Codex_Compass_Conprehensive/releases/download/v1.3.57/Codex.Compass_1.3.57_x64-setup.exe) | 当前用户安装，注册快捷方式和卸载信息 |
| 免安装版 | [Codex.Compass_1.3.57_x64-portable.exe](https://github.com/CharlesWang505/Codex_Compass_Conprehensive/releases/download/v1.3.57/Codex.Compass_1.3.57_x64-portable.exe) | 直接运行，适合测试或便携使用 |

SHA-256：

```text
A100BBB7CE9B5C7493473149B93A954ECB45FAFA3B008B4A97BBB5601CD9EA81  Codex.Compass_1.3.57_x64-portable.exe
2D1B1565D912801866831BBAFBE2FED5A81F7925C843EA26F38CA98A431812D3  Codex.Compass_1.3.57_x64-setup.exe
```

当前公开构建未进行商业代码签名，Windows SmartScreen 可能显示“未知发布者”。下载后应核对文件哈希。完整操作说明见 [Codex Compass 使用手册](./docs/USER_MANUAL.md)。

> **先记住这个隐藏按钮：左上角的闪电图标不是装饰。点击它可以启动 Codex；Codex 已在运行时，点击它会重启 Codex。** 重新生成模型目录或更新注入模型后，需要点击这个按钮让新目录生效。

## v1.3.57 重点更新

- **主题工坊与主题市场**：主题图片改为独立本地资源存储，支持旧主题迁移、远程市场、离线缓存、安装状态和版本更新提示。
- **ENFP 灵感宇宙主题**：重构新任务首页、左侧会话栏、项目与任务层级、字体排版、快捷任务卡、能量条和紧凑布局。
- **主题运行时稳定性**：修复侧栏抽动、行内滚动条、设置页误识别、弹层透明遮挡、图片预览不可见及按钮错位。
- **Windows 标题栏适配**：浅色主题使用深色窗口符号，深色主题使用浅色窗口符号，并周期性同步已打开的 Codex 窗口。
- **完整中文界面**：工具与插件、Codex 增强、原生菜单和插件市场使用定向中文化，Codex、ChatGPT、PDF、MCP 与第三方品牌名保持英文。
- **稳定性与诊断**：供应商切换失败可完整回滚，日志支持 50 MB 限容、尾部读取和清理，Windows 应用识别优先使用原生 AppX 接口。

## 核心模块

### 1. New API / One API 账户监控

“概览”和“分析”主要针对 **New API、One API 及其兼容分支的管理接口**开发，可集中查看：

- 当前余额、额度原值、历史消耗、请求次数和订阅额度。
- 真实 Tokens、实际成本、缓存创建、缓存命中、输入和输出。
- 使用趋势、模型消耗分布、分组倍率和模型倍率。
- API Key 健康状态、调用日志、错误信息、首字延迟和 CSV 导出。
- 站点接口、模型接口和管理接口的可用性。

只支持 `/v1/models`、`/v1/responses` 或 `/v1/chat/completions` 的普通 OpenAI 兼容站点，可能只能显示模型接口等部分数据。管理接口不可用但模型接口可用时，页面会显示“部分实时”或未知项，这不等于模型 API 本身不可用。

### 2. Codex 管理与 8787 热切换

Codex Compass 可以管理多套上游 API 供应商和 Key，将选定模型注入 Codex，并通过本地网关实现模型路由：

```text
Codex
  → http://127.0.0.1:8787/v1
  → Codex 模型别名 / 映射规则
  → 首选或备用供应商
  → 上游真实模型
```

主要能力：

- OpenAI Responses、OpenAI Chat Completions、Anthropic 原生和 Gemini 原生协议。
- 自动获取供应商模型，一次选择多个供应商生成 Codex 模型目录；同名模型按“模型 · 供应商”分别显示，不会互相覆盖。
- Codex 模型别名、上游真实模型、首选供应商、备用顺序和 Reasoning 覆盖。
- 首选供应商失败后按映射顺序切换备用供应商。
- 统一管理 `自动 / 关闭 / low / medium / high / xhigh` 推理强度。
- 可注入“Codex Compass 自动模型”，在 Codex 中选择一次后通过悬浮球实时切换供应商、实际模型和 Reasoning。
- 悬浮球和快速切换面板。
- 会话、MCP 服务器、技能、插件、Codex 增强和脚本市场。

8787 网关默认关闭。网关运行时，供应商的 Base URL、协议和 Key 会被锁定，避免运行中的路由配置被改坏；先关闭热切换即可继续编辑。

使用 Compass API 配置时，Codex 左下角账户菜单会增加“退出 API 登录”。该操作会停止热切换并清除当前 `custom` API 配置，优先恢复已有官方账号认证，但不会删除 Compass 保存的供应商、Key 和模型映射；完成后需重启 Codex。

### 3. 手机远控

手机远控通过用户自建的 HTTPS/WSS 中继网站连接本机 Codex app-server。电脑主动建立出站连接，手机可以按 Codex 左侧正式项目查看已有任务会话；未授权项目只允许读取历史，电脑端一键同步或手工授权后才可新建或继续会话、发送问题、选择本机插件和技能、加密上传附件、接收流式回复并停止生成。插件与技能在手机端使用中文名称和说明，同时保留中英文搜索。Codex 当前有效的本机认证（`apiKey` 或 `chatgpt`）由 app-server 在电脑上复用，认证文件、Cookie、Token 和 API Key 不会发送到中继。

远控默认关闭且不提供任何默认公网地址，用户必须部署并填写自己的 HTTPS/WSS 中继；维护者的私人服务器不会写入安装包或分配给其他用户。Relay ZIP 提供 Windows 上传向导和 VPS 一键安装器，可自动配置经过校验的 Node.js、systemd、Nginx、证书和健康检查。执行权限默认不授权任何工作区；“一键同步 Codex 项目”导入的新项目默认禁止修改文件、运行命令和手机上传。公网只部署中继站点，不得暴露本机 8787 或 app-server。局域网配对同样默认关闭，开启后支持电脑生成二维码/六位码邀请手机，也支持手机主动向同网电脑请求绑定；两种方式都必须在电脑端核对校验码并批准。部署前请阅读 [部署说明](./docs/REMOTE_CONTROL_DEPLOYMENT.md)、[协议文档](./docs/REMOTE_CONTROL_PROTOCOL.md)、[安全模型](./docs/REMOTE_CONTROL_SECURITY.md) 和 [app-server 兼容报告](./docs/CODEX_APP_SERVER_COMPATIBILITY.md)。
### 4. Codex 主题工坊

“主题工坊”可为 Codex 桌面界面应用本地主题，不修改官方安装包、`app.asar` 或 WindowsApps。它提供蔷薇花笺、ENFP 灵感宇宙、薄荷稿纸、墨夜星图和暖灰手稿五套内置主题，并支持主题复制、颜色与透明度调整、本地壁纸、字体、圆角、玻璃模糊，以及 `.zip` / `.cc-theme` 声明式主题包。

“我的主题”用于管理内置、复制、导入和已安装主题；“主题市场”从 CodexPlusPlus-Themes 加载社区清单，支持缓存回退、安装、重新安装和更新。市场下载限制为受信任的 HTTPS 主机，并校验主题 ID、相对路径、配置内容、图片格式和 SHA-256。

新任务首页可配置品牌文字、标题、横幅、右侧装饰图和四张快捷任务卡；快捷卡只填入提示词，不自动发送。ENFP 主题还会同步调整左侧会话栏、项目与任务层级、能量条、输入区和标题排版。

主题通过 Compass 的本机 CDP 注入链应用，Codex 重启后可自动恢复。主题运行时会保护设置页、菜单、弹层、代码、Diff、终端和图片预览的可读性，并根据主题亮度同步 Windows 原生标题栏按钮。第三方主题包不能包含 JavaScript、CSS、HTML、可执行文件或远程资源，导入时会限制压缩包路径、大小、文件数量和图片类型。完整格式和安全说明见 [Codex 主题工坊文档](./docs/THEME_STUDIO.md)。

### 5. 代理测速

代理测速用于回答一个很实际的问题：**同一个 API 中转站，经过哪个 Clash/Mihomo 节点访问最快、最稳定？**

它支持：

- 连接 Clash Verge、Mihomo 命名管道或 HTTP External Controller。
- 没有外部 Clash 时安装并使用独立的内置 Mihomo 测试引擎。
- 导入一个或多个代理订阅并选择参与测速的机场。
- 同时测试多个 Base URL，生成“节点 × Base URL”延迟矩阵。
- 按平均延迟、成功目标数或某一个 Base URL 的延迟排序。
- 加入本地直连作为基准，并导出 CSV。

测速不会切换 Clash 当前节点，也不会修改 Windows 系统代理。

## 快速开始

### 顶部闪电按钮

软件左上角的粉色闪电图标是 Codex 启动按钮：

- Codex 未运行：点击后启动 Codex。
- Codex 已运行：点击后重启 Codex。
- 重新生成模型目录或更新注入模型后：点击它重启 Codex，使新模型菜单生效。

如果点击后没有反应，先在“设置 → Codex 路径与启动”中检查 Codex/ChatGPT 程序路径。

### 配置 New API / One API 概览

1. 打开“设置”，新增或选择监控站点。
2. 填写站点名称、Base URL，以及该站点需要的 Cookie、User ID、API Key 或登录信息。
3. 保存配置；需要 Cookie 的站点可使用“登录获取 Cookie”。
4. 返回“概览”，选择时间范围后点击“手动刷新”。

这里的“监控站点”和 Codex 的“API 供应商”是两套用途不同的数据：

| 类型 | 主要字段 | 用途 |
| --- | --- | --- |
| 监控站点 | Base URL、Cookie、User ID、登录信息 | 读取余额、额度、日志、Token、分组和倍率 |
| API 供应商 | Base URL、API Key、协议、模型列表 | 发送真实模型请求、写入 Codex、参与 8787 热切换 |

同一个 New API 站点可以只建立一个监控站点，同时为不同分组的多个 Key 建立多个 API 供应商。

### 配置 8787 热切换

1. 在“供应商配置”中为每个上游或 Key 建立独立供应商。
2. 填写协议、Base URL 和 Key，点击“获取模型”，选择默认模型后点击“仅保存”。
3. 进入“热切换”，勾选需要出现在 Codex 模型菜单中的供应商。
4. 点击“重新生成并更新 Codex”，生成完整模型目录。
5. 检查模型映射中的别名、上游真实模型、首选供应商、备用供应商和 Reasoning。
6. 点击“保存配置”或“应用并开启”，让 Codex 使用 `http://127.0.0.1:8787/v1`。
7. 点击左上角闪电图标重启 Codex，再在 Codex 模型菜单中选择已注入模型。

“重新生成并更新 Codex”会以当前勾选的供应商为准完整更新注入集合。取消勾选的供应商及其旧模型会从 Codex 菜单中移除。

多个供应商拥有相同 GPT、Claude、Gemini 或自定义别名时，软件会为每个供应商保留独立路由，并生成不同的内部模型 ID；Codex 菜单仍使用“模型 · 供应商”的易读名称。

如果希望以后不再回到 Codex 模型菜单切换，可在模型映射区域点击“添加自动模型”。软件会开启 8787、显示悬浮球并重新打开 Codex；此时 Codex 模型选择器只保留“Codex Compass 自动模型”，普通映射仍安全保存在软件中。随后在悬浮面板中更换供应商、实际模型和 Reasoning，下一次请求立即生效；移除自动模型后会恢复普通映射模型。

协议选择原则：

- 中转站提供 `/v1/responses` 或 `/v1/chat/completions`：选择相应 OpenAI 兼容协议，即使背后实际是 Claude、Gemini 或 Grok。
- 直连 Anthropic `/v1/messages`：选择 Anthropic 原生协议。
- 直连 Gemini `generateContent`：选择 Gemini 原生协议。
- Grok 官方 API 通常按 OpenAI 兼容方式配置。

### 配置代理测速

1. 打开“代理测速”。
2. 使用“自动发现”连接 Clash/Mihomo；没有外部客户端时，先添加订阅，再点击内置引擎的“安装并启用”。
3. 填写订阅名称和订阅 URL，点击“导入并解析节点”，选择参与测速的机场。
4. 加入当前站点、全部站点或自定义 Base URL；目标不需要填写 API Key。
5. 建议先启用“包含本地直连”，并发设置为 4～8。
6. 点击“开始测速”，在矩阵中比较平均延迟、成功目标数和各 Base URL 单列结果。

不同节点访问不同中转站的表现可能完全不同。只看平均值可能掩盖某个站点失败，建议结合“成功目标数”并点击目标表头做单列排序。

## 功能全览

- 概览：账户、订阅、余额、真实 Token、实际成本、趋势、倍率、健康状态和调用日志。
- 分析：使用汇总、模型与时间分布、自动建议。
- 供应商配置：多供应商、多 Key、协议、模型获取、测试、聚合供应商和 Codex 配置应用。
- 热切换：8787 网关、模型注入、自动路由、映射规则、故障切换、Reasoning 和悬浮切换。
- 会话管理：搜索、筛选、打开、删除、备份和历史 Provider 修复。
- 主题工坊：本地主题、主题市场、ENFP 主题、实时预览、主题包与独立图片资源。
- 工具与插件：MCP 服务器、技能、插件以及插件市场维护。
- Codex 增强：页面增强、分步处理、图片覆盖层、原生菜单中文化和计算机操作防护。
- 脚本市场：市场脚本与本地脚本安装、更新、启停和校验。
- 代理测速：订阅、Mihomo 控制器、内置引擎、延迟矩阵和 CSV。
- 设置：站点、Codex 路径、Watcher、诊断、数据清理、版本和关于。
- 系统托盘：隐藏、恢复和彻底退出。

## 时间与刷新

概览支持今天、近 24 小时、近 7 天、近 30 天和自定义时间。手动或自动刷新会使用点击刷新时的最新结束时间；自定义时间保持用户指定的固定范围。

## 接口策略

应用会根据站点能力并行尝试：

- `/api/user/self`
- `/api/log/self/stat`
- `/api/data/self`
- `/api/log/self`
- `/api/token/`
- `/api/user/self/groups`
- `/api/pricing`
- `/api/ratio_config`
- `/api/status`
- `/v1/models`
- `/api/models`

不同 New API / One API 分支的接口和权限可能不同，应用会对可用结果进行归一化，而不是要求每个站点实现全部接口。

## 数据与安全

站点名称、Base URL、API Key、扩展 Key、令牌名称、User ID、Cookie、登录账号和密码保存在系统应用数据目录的 `sensitive/sites.json`。代理订阅 URL、Mihomo 控制器 Secret、测速目标和订阅节点名称保存在 `sensitive/proxy-latency.json`。

这些数据不会写入公开源码目录或安装包。账户余额、调用日志、IP、请求 ID、模型消耗和订阅数据只保存在运行内存，不持久化到磁盘。

主题配置和本地图片保存在应用数据目录的 `theme-studio/` 下；主题市场联网获取公开清单和资源，远程不可用时会回退到本地缓存。主题市场不会读取或上传站点 Key、Cookie、Codex 认证或本机配置。

公开 Issue、日志或截图前，仍应人工移除真实域名、Key、Cookie、订阅 URL、请求 ID、IP、余额和账户信息。

## 架构

```text
src/                                  React 界面、数据归一化与分析逻辑
src/features/proxyLatency/            代理订阅、节点筛选与延迟矩阵
src/lib/desktop.ts                    Tauri invoke 调用封装
src-tauri/src/lib.rs                  Rust HTTP 桥与敏感配置存储
src-tauri/src/proxy_latency.rs        订阅解析、Mihomo 控制器与延迟测试
src-tauri/crates/codex-plus/          Codex 管理、模型目录与 8787 网关
src-tauri/                            Tauri 2 窗口、权限、托盘与安装配置
```

跨域中转站请求由 Rust `reqwest` 执行，前端不直接持有系统网络权限。

## 开发与构建

环境要求：

- Node.js 20+
- Rust stable
- Windows 10/11 WebView2
- Visual Studio 2022 C++ Build Tools 与 Windows SDK

```bash
npm install
npm run dev:tauri
```

仅预览 React 界面可运行 `npm run dev`，但浏览器模式不提供敏感配置持久化、Codex 管理、8787 网关或真实代理测速。

```bash
npm run build
npm run build:tauri
```

主要输出：

```text
src-tauri/target/release/codex-compass.exe
src-tauri/target/release/bundle/nsis/
```

## 版本与许可证

完整版本记录见 [CHANGELOG.md](./CHANGELOG.md)，第三方组件与来源见 [NOTICE.md](./NOTICE.md) 和 [docs/THIRD_PARTY_NOTICES.md](./docs/THIRD_PARTY_NOTICES.md)。

Codex Compass 以 [GNU Affero General Public License v3.0](./LICENSE) 发布，SPDX 标识为 `AGPL-3.0-only`。本项目包含并修改了 CodexPlusPlus 的部分代码，分发修改后的程序或通过网络提供修改后的版本时，必须遵守 AGPLv3 的对应源代码提供要求。

OpenAI、ChatGPT、Codex 以及其他第三方名称和商标归各自权利人所有。

## 开源提交前检查

- 不提交 AppData 下的 `sensitive/`、`codex/` 或个人配置目录。
- 不提交 `dist/`、`release/`、`src-tauri/target/` 或个人截图。
- 示例只能使用 `example.com`、文档保留 IP 段和虚构账号。
- README、Issue、日志和截图中不要出现完整或掩码 Key、Cookie、订阅 URL、请求 ID、真实余额或私人站点域名。
