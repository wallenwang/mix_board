# 第三方组件与许可

本项目自身以 MIT 许可发布（见 `LICENSE`）。以下是随本项目一起分发的第三方组件，
它们各自保留原有版权与许可，本项目不对它们主张任何权利。

## 运行时依赖（前端）

| 组件 | 许可 | 项目地址 |
| --- | --- | --- |
| Vue 3 | MIT | https://github.com/vuejs/core |
| Pinia | MIT | https://github.com/vuejs/pinia |
| Element Plus | MIT | https://github.com/element-plus/element-plus |
| Vditor | MIT | https://github.com/Vanessa219/vditor |
| vue-draggable-plus | MIT | https://github.com/Alfred-Skyblue/vue-draggable-plus |
| @tauri-apps/api | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |

## 运行时依赖（Rust）

| 组件 | 许可 | 项目地址 |
| --- | --- | --- |
| Tauri 2 | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |
| serde / serde_json | MIT / Apache-2.0 | https://github.com/serde-rs/serde |
| rusqlite | MIT | https://github.com/rusqlite/rusqlite |
| SQLite | Public Domain | https://www.sqlite.org/copyright.html |

## 随仓库分发的静态资源

`app/public/vditor/dist/` 是 **Vditor** 官方发布包（MIT 许可），用于离线加载编辑器资源
（不依赖 CDN）。分发时请保留其版权声明；详见上述 Vditor 项目地址中的 LICENSE。

## 字体

本项目不打包任何字体文件，界面只引用操作系统自带的字体族（如系统中文黑体 / 宋体）。
