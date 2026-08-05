# Zotero DOI Metadata Fill（DOI 补全题录）

一个自用的 [Zotero](https://www.zotero.org/) 插件：**通过 DOI 自动补全缺失的文献题录信息**（作者、标题、期刊、年份、卷期页、ISSN、摘要、出版社等），一键解决 Zotero Connector 导入文献时题录不完整的问题。

- 数据源：DOI 官方元数据（[doi.org 内容协商](https://citation.doi.org/docs.html) 返回 CSL-JSON，覆盖 Crossref / DataCite / mEDRA 全部 DOI 注册机构，无需任何 API key）
- 兼容：Zotero 7+（在 Zotero 10.0-beta 上开发并实测验证）

[![Zotero target version](https://img.shields.io/badge/Zotero-7%2F10-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)

---

## ✨ 功能特性

- **一键补全**：右键任意文献 → 「按 DOI 补全题录」，自动补齐缺失字段
- **批量处理**：工具菜单 → 「批量补全 DOI 题录（全库）」，一键扫描整个文库中所有带 DOI 但缺字段的条目
- **数据安全（核心设计）**：
  - **只补空缺字段，绝不覆盖**你已有的任何内容（手工修正的数据神圣不可侵犯）
  - 作者仅在两种情况下替换：① 现有作者为空；② 新作者列表更长 **且** 所有现有姓氏都出现在新列表中（防止误替换）
  - 编辑器（editor）等非作者创作者**始终保留**
- **智能类型纠正**：被 Connector 误导入为「网页 / 预印本」的条目，自动纠正为期刊论文 / 会议论文 / 书籍章节
- **稳健的批量**：并发 ≤3、请求间隔 ≥300ms（礼貌调用，不触发 DOI 服务限流）；单条失败不中断整个批次
- **清晰报告**：结束时显示 补全成功 / 跳过-无DOI / 跳过-已完整 / 失败 计数，失败条目列出 DOI 与原因（最多 20 条）
- **失败容错**：404（DOI 不存在）、网络错误、限流重试（429/5xx 自动退避重试一次）均有明确分类

### 可补全的字段

| 类别 | 字段 |
|---|---|
| 作者 | 全部作者（含机构作者，如 GTEx Consortium） |
| 标题 | title（仅空缺时） |
| 期刊 | publicationTitle / proceedingsTitle / bookTitle、journalAbbreviation（缩写） |
| 年份 | date（ISO 格式 YYYY-MM-DD） |
| 卷期页 | volume、issue、pages |
| 标识 | ISSN、ISBN、DOI（自动归一化） |
| 其他 | publisher（出版社）、url、abstractNote（摘要）、language（语言） |

---

## 📦 安装

### 方法一：从 Release 安装（推荐）

1. 到 [Releases](https://github.com/virchow-zhang/zotero-doi-metadata-fill/releases) 下载最新的 `doi-metadata-fill.xpi`
2. 打开 Zotero → 菜单栏「工具」→「插件」（或 设置 → 插件）
3. 齿轮图标 → 「Install Plugin From File...」→ 选择下载的 `.xpi`
4. 重启 Zotero（安装后首次需要重启加载）

### 方法二：从源码构建

```bash
git clone https://github.com/virchow-zhang/zotero-doi-metadata-fill.git
cd zotero-doi-metadata-fill
npm install
npm run build
# 产物：.scaffold/build/doi-metadata-fill.xpi
```

---

## 🚀 使用方法

### 单条补全

1. 在 Zotero 条目列表中选中一条（或按住 Ctrl 多选）**有 DOI 但题录不完整**的文献
2. 右键 → **「按 DOI 补全题录」**
3. 完成时右下角弹出进度窗口，显示处理结果

### 全库批量补全

1. 菜单栏「工具」→ **「批量补全 DOI 题录（全库）」**
2. 弹出确认框显示候选条目数量（全库中带 DOI 且缺字段的条目）→ 确认
3. 批量处理完成后显示统计：补全成功 / 跳过-无DOI / 跳过-已完整 / 失败

> [!tip]
> 批量扫描只处理「缺作者 或 缺期刊/卷/页码」的条目，已完整的条目自动跳过，不会重复劳动。

---

## ⚠️ 数据安全说明

这个插件遵循**极保守的写入策略**：

| 场景 | 行为 |
|---|---|
| 字段已有内容 | **绝不覆盖** |
| 字段为空 | 从 DOI 元数据补齐 |
| 现有作者为空 | 补入 DOI 元数据的全部作者 |
| 现有作者非空 | 仅当新列表更长**且**所有现有姓氏都匹配时才替换 |
| 非作者创作者（编辑等） | 始终保留 |
| 条目类型 | 仅允许 网页/预印本 → 期刊/会议/书章 的升级，绝不降级 |

建议在使用前备份文库（Zotero 自带「同步」或手动备份 `zotero.sqlite`）。

---

## 🔧 工作原理

```
用户触发（右键/工具菜单）
        │
        ▼
提取条目 DOI（DOI 字段或 Extra 字段的 "DOI:" 行，自动归一化）
        │
        ▼
请求 https://doi.org/<DOI>  (Accept: application/vnd.citationstyles.csl+json)
        │  ← 自动跟随重定向到 Crossref / DataCite / mEDRA 的元数据服务
        ▼
得到 CSL-JSON（标准元数据格式，含作者/标题/期刊/年份/卷期页/ISSN/摘要/出版社）
        │
        ▼
映射为 Zotero 字段 + 补全策略决策（只补空缺，作者安全规则）
        │
        ▼
写入 Zotero 条目并保存
```

---

## 🛠️ 开发

### 技术栈

- [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)：TypeScript + esbuild 插件脚手架
- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)：插件辅助 API
- [zotero-types](https://github.com/windingwind/zotero-types)：Zotero 类型定义
- [vitest](https://vitest.dev/)：单元测试（纯函数模块在 Node 中测试）

### 目录结构

```
zotero-doi-metadata-fill/
├── src/
│   ├── modules/
│   │   ├── doi.ts              # DOI 提取与归一化（纯函数）
│   │   ├── csl-map.ts          # CSL-JSON → Zotero 字段映射（纯函数）
│   │   ├── fill-policy.ts      # 补全策略决策引擎（纯函数，数据安全核心）
│   │   ├── fetch-metadata.ts   # doi.org 内容协商客户端 + 并发池（可注入 HTTP）
│   │   ├── fill.ts             # 填充执行器（应用变更到条目）
│   │   ├── batch.ts            # 批量处理器（选中/全库 + 统计）
│   │   ├── zotero-adapters.ts  # Zotero 运行时适配层（唯一的 Zotero 全局入口）
│   │   ├── ui.ts               # 菜单注册（Zotero 10 MenuManager API）、进度、报告、自检
│   │   └── *.test.ts           # vitest 单元测试
│   ├── hooks.ts                # 生命周期钩子
│   └── index.ts                # 插件入口
├── addon/                      # 插件静态资源（manifest、locale、bootstrap）
└── .scaffold/build/            # 构建产物（.xpi）
```

### 常用命令

```bash
npm install          # 安装依赖
npm test             # 运行单元测试（vitest）
npm run build        # 生产构建，产出 .scaffold/build/*.xpi
npm start            # 开发模式：自动构建 + 加载到 Zotero + 热重载
```

### 架构设计要点

- **纯函数核心**：`doi.ts` / `csl-map.ts` / `fill-policy.ts` / `fetch-metadata.ts` / `fill.ts` / `batch.ts` **不引用 Zotero 全局**，可在 Node 中单测（87+ 用例）；只有 `zotero-adapters.ts` 和 `ui.ts` 接触 Zotero 运行时
- **依赖注入**：HTTP 层通过 `HttpGet` 接口注入，单元测试用 mock，生产环境绑定 `Zotero.HTTP`（带 `fetch` 回退）
- **Zotero 10 兼容**：菜单用官方 `Zotero.MenuManager.registerMenu` API（窗口无关、幂等注册），本地化用 Fluent（FTL）
- **内置自检模式**：设置 pref `extensions.zotero.doiMetaFill.selfTest=true` 后启动即自动跑冒烟测试（真实 DOI 补全 + 坏 DOI 零污染），结果写入 `.qa/selftest-result.json`，供自动化 QA

### 自检模式（QA）

```bash
# 在 Zotero 的 prefs.js 中设置（需先完全退出 Zotero）
user_pref("extensions.zotero.doiMetaFill.selfTest", true);
# 重新启动 Zotero，等待数秒后查看：
#   .qa/selftest-result.json  ← 全部断言结果
```

---

## ✅ 测试与验证

- **单元测试**：87+ 个 vitest 用例覆盖 DOI 提取、CSL 映射、补全策略、HTTP 重试、并发池、批量统计
- **端到端验证**：在真实 Zotero 10.0-beta 隔离 profile 中跑通——真实 DOI（10.1038/ng.3834）成功补全出 14 位作者 / Nature Genetics / 2017-04-03；坏 DOI 干净失败且零字段污染
- **数据隔离**：QA 全程在隔离数据目录进行，真实文库 0 改动

---

## 📄 许可证

本项目基于 [AGPL-3.0](LICENSE)。使用本代码时请遵守当地法律。

---

## 🙏 致谢

- [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) — 插件脚手架
- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) — 开发工具包
- [Crossref / DataCite / DOI Foundation](https://citation.doi.org/docs.html) — 元数据内容协商服务
