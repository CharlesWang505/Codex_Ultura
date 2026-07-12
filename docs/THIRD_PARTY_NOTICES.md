# 第三方组件说明

## CodexPlusPlus

Codex Compass 的 Codex 管理、配置、会话、插件和兼容层包含并修改了 CodexPlusPlus 的部分代码。

- 项目地址：https://github.com/BigPizzaV3/CodexPlusPlus
- 原作者：BigPizzaV3
- 许可证：GNU Affero General Public License v3.0 only（`AGPL-3.0-only`）
- 上游版权：Copyright (C) 2026 BigPizzaV3

Codex Compass 的对应修改源码随本仓库一并提供。CodexPlusPlus 的许可证不授予 OpenAI、ChatGPT、Codex 商标、应用资源或其他第三方内容的权利。

## OpenAI 插件市场

公开源码包不包含从本地 Codex/ChatGPT 环境提取的远程插件缓存。仓库中的远程市场 ZIP 仅保留一个不含插件内容的空清单，用于保证构建和配置迁移逻辑可运行。用户应通过自己获授权的 Codex 环境获取相应插件。

## Mihomo

代理测速页可以在用户明确点击“安装并启用”后，从 MetaCubeX 官方 GitHub 发布页下载独立的 Mihomo 可执行文件。

- 项目地址：https://github.com/MetaCubeX/mihomo
- 许可证：GNU General Public License v3.0
- 下载来源：https://github.com/MetaCubeX/mihomo/releases/latest

Mihomo 不包含在本项目源码仓库中，也不会在未获得用户操作的情况下下载。下载后的可执行文件、版本信息、隔离配置和订阅缓存保存在应用的独立敏感数据目录中。本项目通过 Mihomo 的本地 HTTP 控制接口读取节点并执行延迟测试，不修改 Mihomo 源代码。

发布本软件时应保留本说明，并遵守 Mihomo 项目当时适用的许可证及发布要求。
