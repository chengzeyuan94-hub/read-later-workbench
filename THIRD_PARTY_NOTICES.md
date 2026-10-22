# 第三方声明

本项目源码以 MIT 发布；依赖与打包资源的各自许可证保留。

## 主要依赖（package.json）

React / React DOM、Electron、Vite、TypeScript、tsx、esbuild、better-sqlite3、fflate、ProseMirror（model/state/view/commands/history/keymap）等，许可证以各上游包为准（大多为 MIT / ISC / Apache-2.0 / BSD）。

## 打包资源

- **Fusion Pixel 字体**：`src/renderer/assets/pixel.woff2`，按 SIL Open Font License 1.1 再分发；完整文本见 `src/renderer/assets/OFL.txt`（上游：https://github.com/TakWolf/fusion-pixel-font）。
- **L叔头像与像素图标**：`src/renderer/assets/avatar/` 及 `icons.tsx` 中的手绘图形，随本项目 MIT 发布；与兄弟项目 lshu-workbench 的视觉体系一致。
- 未包含任何平台截图、用户下载的媒体、账号信息或私密文档。

## 系统服务

OCR 经 `native/ocr-helper.swift` 调用本机 Apple Vision 框架；ffmpeg/ffprobe 由用户本机自备并按其各自许可证使用。
