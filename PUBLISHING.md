# GitHub 发布说明

## 仓库内容

将本目录中的文件上传到 GitHub 仓库。不要把同级的 `Codex-Compass-Release-1.3.2` 目录提交到源码仓库。

推荐仓库设置：

- 可见性：Public
- License：AGPL-3.0
- 默认分支：main
- 建议启用 GitHub Secret Scanning 和 Dependabot

## Release 资产

在 GitHub Releases 创建 `v1.3.2`，从同级 `Codex-Compass-Release-1.3.2` 上传：

- `Codex_Compass_1.3.2_x64-portable.exe`
- `Codex_Compass_1.3.2_x64-setup.exe`
- `Codex_Compass_1.3.2_source.zip`
- `SHA256SUMS.txt`

## 不得上传

- AppData 中的 `sensitive`、`settings`、`codex` 数据目录
- `.env`、`auth.json`、`config.toml`、站点配置、Cookie、API Key 和代理订阅
- `node_modules`、`dist`、`release`、`src-tauri/target`
- 个人截图、调用日志、请求 ID、余额、真实站点域名和代码签名证书

本公开副本已经移除旧界面截图、支付二维码、未授权的远程插件缓存和私人站点默认地址。
