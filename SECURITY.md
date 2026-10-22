# 安全策略

## 支持版本

安全修复面向最新的 `main` 分支与最近发布版。

## 本地边界

- 应用为单用户桌面程序，不提供远程访问接口；不要在未加认证的情况下把其数据目录或 IPC 暴露给其他进程/设备。
- 渲染进程开启 contextIsolation、禁用 nodeIntegration；自定义 `rlw-*` scheme 只服务本地资源。
- 付费 AI 调用有明确的请求上限与审计（每次提交记录在 `generation_calls` / `asr_calls`），并对失败结果保持诚实区分。

## 凭据处理

- API 密钥只经 macOS Keychain 加密的 `safeStorage` 写入本机；不要把密钥粘贴进 issue、日志或提交。
- 若怀疑泄露，请先在平台侧吊销/轮换密钥，再更新本机保存。

## 报告漏洞

请使用 GitHub 私密安全通告（Security Advisory）提交，不要公开具体收藏内容、登录态、Cookie 或绝对路径。有效报告请附：受影响版本、基于合成数据的重现步骤、影响范围与建议修复方向。
