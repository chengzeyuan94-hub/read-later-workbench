# 收藏阅读工作台

一个本地优先的 macOS 桌面应用（Electron）：把你自己的 小红书 / B站 / 微博 / 知乎 / X 收藏同步到本地，自动下载正文与媒体供离线阅读，再用 OCR / 语音转写（ASR）+ AI 把长内容整理成可编辑的导图和 Markdown 笔记，并支持知识卡片与复习回顾。

> 单用户、本机运行。数据保存在本机，不上传到任何自有服务器；AI 处理需要你在设置里自备密钥并显式开启联网。

## 功能

- **多平台收藏同步**：应用内登录后，按可配置范围同步 小红书 / B站 / 微博 / 知乎 / X 的收藏列表，增量确认、去重、失败重试与平台冷却。
- **离线保存**：正文、图片、音视频逐条落地本地；首页与收藏夹可完全离线浏览；真实删除会释放空间并留墓碑。
- **消化管线**：下载 → 图片 OCR（本机 Apple Vision，经 Swift 辅助进程）→ 音视频转写（硅基流动 ASR）→ AI 整理（DeepSeek）→ 可编辑导图 + Markdown 文稿。
- **消化库**：AI 整理、手动整理与早期标记分区展示；导图可在画布上编辑、导出 XMind / Markdown / 图片。
- **知识卡片**：在导图里点任意节点即可生成 3:4 像素风海报卡（1080×1440），以节点观点为主体、子节点为要点，可编辑后导出 PNG 或复制图片。
- **首页回顾**：「继续 / 最近同步到的 / 该回顾了」三栏，把读过但没整理、该回看的内容推到眼前。
- **队列与用量**：顶栏一个入口集中展示所有进行中的消化任务、每分钟转写进度与具体阻塞原因；设置页显示本月与累计用量（不设上限，只显示用量）。
- **诚实的状态**：下载未完成、待转写、失败、未知、已取消与已完成严格区分；付费调用只在提交后才计数。

## 运行要求

- macOS 13+，Apple Silicon
- Node.js 24（`>=24 <25`，见 `.nvmrc`）
- Xcode Command Line Tools（仅构建本机 OCR helper 时需要）
- ffmpeg / ffprobe（仅处理音视频转写时需要，可经 `RLW_FFMPEG` / `RLW_FFPROBE` 指定）
- 自备 API 密钥：硅基流动（音视频转写）、DeepSeek（正文与导图生成）——没有它们也能浏览与手动整理

## 快速开始

```bash
npm ci
npm run native:prepare   # 准备原生绑定与 ASR 测试工具（ffmpeg/ffprobe）
npm run dev              # typecheck + build + 启动 Electron
```

常用命令：

```bash
npm test           # node --test 全部单元测试
npm run typecheck  # tsc --noEmit
npm run build      # renderer + main + preload 完整构建
npm run verify     # typecheck + test + build + native:verify
npm run fixture:prepare   # 生成一个合成演示收藏库（.acceptance-data/）
```

`native:prepare` 依次从 `RLW_FFMPEG`/`RLW_FFPROBE`、PATH、`@ffmpeg-installer`/`@ffprobe-installer` 开发依赖中准备 ffmpeg/ffprobe；没有它们，ASR 媒体相关测试会失败（其余功能不受影响）。

`npm run dev` 默认以正式本地模式启动（数据在系统 `Application Support` 下）。批量隔离模式（独立资料根、五平台独立会话）见 `scripts/start-batch-e42.sh` 与 `npm run batch:*`，用于验收与迁移演练。

## 架构

```
src/main/       Electron 主进程：SQLite 存储、平台采集、OCR/ASR/生成流水线、批量调度
src/renderer/   React 界面：首页、收藏夹、消化库、编辑器、设置
src/shared/     主进程与渲染进程共享的契约与校验
src/editor-core/ 导图/文稿数据模型、画布渲染、保存协调
tests/          node:test + tsx 单元测试（全部使用合成夹具）
scripts/        构建、批量隔离启动、本机 helper 与稳定性工具
native/         Apple Vision OCR 辅助程序（Swift）与夹具生成
spikes/editor-e0/ 编辑器早期原型，被部分测试复用
```

## 已知限制

- 微博图片偶发返回 403（平台侧防盗链），正文与元数据仍正常保存。
- X 的全量历史同步基于滚动翻页，完整度受平台返回影响。
- 干净 clone 上 `npm test` 有 4 个已知环境性失败（642/646 通过）：3 个 E112 附件权限注入测试要求隔离运行根（`.acceptance-data/editor-e112` 下的 TMPDIR），1 个凭据隔离测试依赖特定模块加载行为；均为环境问题而非功能回归。
- 暂无云同步、多设备或协作能力；数据迁移靠手动拷贝数据目录。

## 合规说明

本应用只在用户自己已登录的浏览器会话内读取其收藏，能力等效于用户本人浏览。请遵守各平台服务条款，勿用于抓取他人数据、绕过权限或任何违规用途。

## 相关项目

- [lshu-workbench](https://github.com/chengzeyuan94-hub/lshu-workbench)：同作者的桌面工作台（待办/财务/热点等连接器），风格与图标体系一致。

## License

[MIT](LICENSE)。字体与图标等第三方资源沿用其各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
