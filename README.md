# Codex_Ultura

基于 Tauri 2、Rust、React 19、TypeScript 与 Recharts 的桌面级 API 中转监控、Codex 管理和模型热切换软件，面向 New API、One API 与 OpenAI 兼容中转站。

本项目参考并基于 [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) 与 [codex-api-hot-switch](https://github.com/BandengHu/codex-api-hot-switch) 的部分功能进行整合和完善，旨在把中转站监控、Codex 管理、供应商配置、模型热切换及常用增强集中到一个桌面工具中，让用户只需一个配套软件便能更轻松地配置和使用 Codex。

从 [GitHub Releases](https://github.com/CharlesWang505/Codex_Ultura/releases/latest) 下载最新版安装包，完整操作说明见 [Codex_Ultura 使用手册](./docs/USER_MANUAL.md)。

## 功能

- 账户数据：当前余额、历史消耗、请求次数、账户分组与订阅额度。
- 使用统计：真实 Tokens、成本、缓存创建、缓存命中、输入、输出与模型消耗分布。
- 服务状态：站点状态、兼容模型接口、管理接口可用性与延迟。
- 模型信息：当前模型分组、实时倍率、模型列表与定价兜底。
- 令牌与日志：默认 Key 与扩展 Key 统一配置，多 Key 健康检测、令牌筛选、错误识别、调用日志与 CSV 导出。
- 时间范围：今天、近 24 小时、近 7 天、近 30 天与自定义时间。
- 代理测速：导入 Clash/Mihomo 订阅，通过每个代理节点批量测试多个 Base URL 的实时延迟，并可按任一路线正序或倒序排名。
- 系统托盘：关闭窗口时可询问、隐藏到托盘或直接退出，托盘菜单支持恢复窗口和彻底退出。

## 架构

```text
src/                    React 界面、数据归一化与分析逻辑
src/features/proxyLatency/  代理订阅、节点筛选与延迟矩阵界面
src/lib/desktop.ts      Tauri invoke 调用封装
src-tauri/src/lib.rs    Rust HTTP 请求桥与敏感配置文件存储
src-tauri/src/proxy_latency.rs  订阅解析、Mihomo 控制器与单节点 delay 客户端
src-tauri/              Tauri 2 窗口、权限、图标与安装包配置
```

所有跨域中转站请求都由 Rust `reqwest` 执行，前端不直接持有系统网络权限。

## 敏感信息

站点名称、Base URL、API Key、扩展 Key、令牌名称、User ID、Cookie、登录账号和密码统一保存到系统应用数据目录的独立 `sensitive/sites.json` 文件。代理订阅 URL、Mihomo 控制器 Secret、测速目标和订阅节点名称保存在 `sensitive/proxy-latency.json`。这些数据不再写入浏览器 `localStorage`，也不会进入源码或安装包。

Windows 下目录由 Tauri 的 `app_data_dir` 决定，通常位于当前用户的 AppData 目录。非敏感的关闭窗口偏好单独保存在 `settings/app-preferences.json`。账户余额、调用日志、IP、请求 ID、模型消耗与订阅数据只保存在运行内存，不会持久化到磁盘。

## 关闭与托盘

- 默认点击关闭按钮时询问：最小化到系统托盘、直接退出或取消。
- 勾选“记住本次选择”后，下次关闭会直接执行对应操作。
- 可在“设置 → 关闭窗口行为”中恢复为每次询问或改为其他行为。
- 左键点击托盘图标恢复窗口；右键菜单可显示主窗口或退出软件。

## 开发环境

需要：

- Node.js 20+
- Rust stable
- Windows 10/11 WebView2
- Visual Studio 2022 C++ Build Tools 与 Windows SDK

安装依赖：

```bash
npm install
```

运行 Tauri 桌面开发模式：

```bash
npm run dev:tauri
```

仅运行 React/Vite 页面：

```bash
npm run dev
```

浏览器模式用于界面开发，不提供持久化敏感配置；完整功能请使用 Tauri 模式。

## 构建

前端构建与类型检查：

```bash
npm run build
```

Tauri Windows 应用与安装包：

```bash
npm run build:tauri
```

只构建 NSIS 安装包：

```bash
npm run build:installer
```

主要输出位置：

```text
src-tauri/target/release/codex-ultura.exe
src-tauri/target/release/bundle/nsis/
```

## 接口策略

应用会按站点能力并行尝试：

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

当部分管理接口不可用但兼容模型接口可用时，应用以“部分实时”模式展示可用数据。

## 代理测速

1. 可以连接 Clash Verge、Mihomo 或其他启用了 External Controller 的 Clash Meta 客户端；没有 Clash 时，可在控制器区域点击“安装并启用”使用内置测试引擎。
2. 打开“代理测速”，默认会尝试连接 Windows 命名管道 `\\.\pipe\verge-mihomo`，也可以自动发现、填写 HTTP 控制器或启动内置引擎。
3. 粘贴代理订阅 URL。软件只保存订阅地址和节点名称，不保存订阅原文中的节点协议凭据。
4. 加入当前站点、全部已配置站点或自定义 Base URL。
5. 点击“开始测速”，软件会调用 Mihomo 的 `/proxies/{节点}/delay`，并发测试全部节点与目标，不会切换当前代理。

如果控制器启用了 Secret，请在控制器区域填写；Secret 仅保存在独立敏感配置文件中。

内置测试引擎只在用户明确操作后从 MetaCubeX 官方 GitHub 下载独立 Mihomo 核心，不修改系统代理。第三方许可证说明见 [docs/THIRD_PARTY_NOTICES.md](./docs/THIRD_PARTY_NOTICES.md)。

## 版本与变更日志

项目采用语义化版本号 `主版本.次版本.修订版本`，完整记录见 [CHANGELOG.md](./CHANGELOG.md)。

每次完成代码或界面修改时必须：

1. 在 `CHANGELOG.md` 顶部增加本次版本记录，说明新增、变更与修复内容。
2. 修复和小范围优化递增修订版本，新增功能递增次版本，不兼容变更递增主版本。
3. 同步 `package.json` 与 `src-tauri/Cargo.toml`；Tauri 安装包版本自动读取 `package.json`。
4. 重新执行构建、lint、Rust 检查，并生成对应版本的 EXE 与安装包。

## 开源许可证

Codex_Ultura 以 [GNU Affero General Public License v3.0](./LICENSE) 发布，SPDX 标识为 `AGPL-3.0-only`。

本项目包含并修改了 [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) 的部分代码。分发修改后的程序，或通过网络向用户提供修改后的版本时，必须按照 AGPLv3 向相应用户提供完整对应源代码。OpenAI、ChatGPT、Codex 及其他第三方名称和商标归各自权利人所有。

详细来源与第三方组件说明见 [NOTICE.md](./NOTICE.md) 和 [docs/THIRD_PARTY_NOTICES.md](./docs/THIRD_PARTY_NOTICES.md)。

## 开源前检查

- 不提交 AppData 下的 `sensitive/` 目录。
- 不提交 `dist/`、`release/`、`src-tauri/target/` 或个人截图。
- 示例数据只能使用 `example.com`、文档保留 IP 段和虚构账号。
- README、Issue、日志与截图中不要出现完整或掩码 API Key、Cookie、请求 ID、真实余额和私有站点域名。
