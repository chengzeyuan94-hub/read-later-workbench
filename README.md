# 收藏阅读工作台

一个本地优先的桌面应用（Electron，macOS / Windows / Linux）：把你自己的 小红书 / B站 / 微博 / 知乎 / X 收藏同步到本地，自动下载正文与媒体供离线阅读，再用 OCR / 语音转写（ASR）+ AI 把长内容整理成可编辑的导图和 Markdown 笔记，并支持知识卡片与复习回顾。

> 单用户、本机运行。数据保存在本机，不上传到任何自有服务器；AI 处理需要你在设置里自备密钥并显式开启联网。

## 功能

- **多平台收藏同步**：应用内登录后，按可配置范围同步 小红书 / B站 / 微博 / 知乎 / X 的收藏列表，增量确认、去重、失败重试与平台冷却。
- **离线保存**：正文、图片、音视频逐条落地本地；首页与收藏夹可完全离线浏览；真实删除会释放空间并留墓碑。
- **消化管线**：下载 → 图片 OCR → 音视频转写（硅基流动 ASR）→ AI 整理（DeepSeek）→ 可编辑导图 + Markdown 文稿。
- **消化库**：AI 整理、手动整理与早期标记分区展示；导图可在画布上编辑、导出 XMind / Markdown / 图片。
- **知识卡片**：在导图里点任意节点即可生成 3:4 像素风海报卡（1080×1440），以节点观点为主体、子节点为要点，可编辑后导出 PNG 或复制图片。
- **首页回顾**：「继续 / 最近同步到的 / 该回顾了」三栏，把读过但没整理、该回看的内容推到眼前。
- **队列与用量**：顶栏一个入口集中展示所有进行中的消化任务、每分钟转写进度与具体阻塞原因；设置页显示本月与累计用量（不设上限，只显示用量）。
- **诚实的状态**：下载未完成、待转写、失败、未知、已取消与已完成严格区分；付费调用只在提交后才计数。

## 平台差异

- **图片 OCR 仅支持 macOS**（本机 Apple Vision，经 Swift 辅助进程）。在 Windows / Linux 上该能力显示为「此系统暂不支持本机图片文字识别，图片未参与整理」，收藏仍可按正文与转写正常消化（text-only）。
- **密钥保存**：所有平台都走应用内弹窗 + 系统安全存储（macOS Keychain / Windows DPAPI / Linux Secret Service）。Linux 需要 GNOME Keyring 或 KWallet；未检测到时会拒绝保存并提示改用 `SILICONFLOW_API_KEY` / `DEEPSEEK_API_KEY` 环境变量。
- 其余功能（收藏同步、离线阅读、转写、AI 整理、导图/文稿编辑、导出）三平台一致。

## 安装

**普通用户**：从 [Releases](https://github.com/chengzeyuan94-hub/read-later-workbench/releases) 下载对应安装包（macOS `.dmg`/`.zip`，Windows `.exe` NSIS 安装包，Linux `.AppImage`/`.deb`）。签名与公证尚未配置，macOS 首次打开需在「系统设置 → 隐私与安全性」允许，Windows 可能提示未知发布者。

**从源码运行**：

- Node.js 24（`>=24 <25`，见 `.nvmrc`）
- macOS：Xcode Command Line Tools（构建本机 OCR helper 时）
- ffmpeg / ffprobe：转写音视频时需要；打包版本自带 `@ffmpeg-installer`/`@ffprobe-installer` 二进制，也可用 `RLW_FFMPEG` / `RLW_FFPROBE` 或 PATH 提供
- 自备 API 密钥：硅基流动（音视频转写）、DeepSeek（正文与导图生成）——没有它们也能浏览与手动整理

```bash
npm ci
node node_modules/electron/install.js   # 下载 Electron 二进制（npm 不自动执行）
npm run native:prepare   # 准备原生绑定与 ASR 测试工具（ffmpeg/ffprobe）
npm run dev              # typecheck + build + 启动 Electron
```

数据保存在 Electron `userData` 目录（macOS `~/Library/Application Support/收藏阅读工作台`，Windows `%APPDATA%`，Linux `~/.config`）。

## 常用命令

```bash
npm test           # node --test 全部单元测试（测试夹具全部为合成数据）
npm run typecheck  # tsc --noEmit
npm run build      # renderer + main + preload 完整构建
npm run verify     # typecheck + test + build + native:verify
npm run fixture:prepare   # 生成一个合成演示收藏库（.acceptance-data/）
npm run dist       # 打包当前平台安装包到 dist/packages/
npm run dist:mac / dist:win / dist:linux   # 指定目标平台
```

`native:prepare` 依次从 `RLW_FFMPEG`/`RLW_FFPROBE`、PATH、`@ffmpeg-installer`/`@ffprobe-installer` 依赖中准备 ffmpeg/ffprobe；没有它们，ASR 媒体相关测试会失败（其余功能不受影响）。

`batch:*` 脚本（`scripts/batch-*.mjs`、`start-batch-e42.sh`）是 macOS/Linux 开发用的批量隔离验收工具（zsh），Windows 不可用，普通使用无需接触。

签名 / 公证：未配置。macOS 需开发者证书 + notarization，Windows 需代码签名证书 —— 发布前在 `electron-builder.yml` 中补齐（见文件内 TODO）。

## 架构

```
src/main/       Electron 主进程：SQLite 存储、平台采集、OCR/ASR/生成流水线、批量调度
src/renderer/   React 界面：首页、收藏夹、消化库、编辑器、设置
src/shared/     主进程与渲染进程共享的契约与校验
src/editor-core/ 导图/文稿数据模型、画布渲染、保存协调
tests/          node:test + tsx 单元测试（全部使用合成夹具）
scripts/        构建、打包准备、批量隔离启动、本机 helper 与稳定性工具
native/         Apple Vision OCR 辅助程序（Swift，仅 macOS）
build/          应用图标（由 L叔 头像 SVG 渲染：electron scripts/icon.cjs）
spikes/editor-e0/ 编辑器早期原型，被部分测试复用
```

## CI 与发布

- `.github/workflows/ci.yml`：push / PR 时在 macOS / Windows / Ubuntu 三平台跑 `npm ci`、`native:prepare`、typecheck、`npm test`、build 与 `native:verify`。
- `.github/workflows/release.yml`：`v*` tag 或手动触发，三平台构建安装包并上传为 workflow artifacts；tag 构建会通过 GitHub Release 附加产物。

## 已知限制

- 微博图片偶发返回 403（平台侧防盗链），正文与元数据仍正常保存。
- X 的全量历史同步基于滚动翻页，完整度受平台返回影响。
- 图片 OCR 仅 macOS（见「平台差异」）。
- `npm test` 中 4 个 E112 附件权限注入测试被标记为 skip，因为它们需要隔离运行根（`.acceptance-data/editor-e112` 下的专用 TMPDIR runner），普通 `npm test` 与 CI 下均显式跳过。
- 暂无云同步、多设备或协作能力；数据迁移靠手动拷贝数据目录。

## 合规说明

本应用只在用户自己已登录的浏览器会话内读取其收藏，能力等效于用户本人浏览。请遵守各平台服务条款，勿用于抓取他人数据、绕过权限或任何违规用途。

## 相关项目

- [lshu-workbench](https://github.com/chengzeyuan94-hub/lshu-workbench)：同作者的桌面工作台（待办/财务/热点等连接器），风格与图标体系一致。

## License

[MIT](LICENSE)。字体与图标等第三方资源沿用其各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
