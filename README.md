# 🌈 缤纷云助手

> 管理缤纷云存储，支持文件浏览、上传、图片压缩与水印、容量统计、EXIF 查看、存储桶复制等功能。

[!\[Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian\&color=%23483699\&label=downloads\&query=%24%5B%22bitiful-helper%22%5D.downloads\&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=bitiful-helper)
[!\[GitHub release](https://img.shields.io/github/v/release/ViaCai/bitiful-helper?logo=github\&color=blue)](https://github.com/YOUR_USERNAME/bitiful-helper/releases/latest)

\---

## ✨ 功能特性

* 📂 **文件浏览器** — 侧边栏浏览缤纷云存储桶，支持文件夹导航
* ⬆️ **拖拽上传** — 拖拽文件到侧边栏直接上传，支持剪贴板粘贴图片
* 🖼️ **图片压缩** — 上传时自动压缩图片，节省存储空间
* 💧 **图片水印** — 上传图片自动添加文字水印
* 📷 **EXIF 查看** — 查看图片的拍摄信息（相机型号、拍摄时间等）
* 📊 **容量统计** — 实时统计存储分布，显示免费 50G 容量使用情况
* 🔍 **全局搜索** — 跨目录搜索所有文件
* 📋 **批量操作** — 批量复制、插入、删除文件
* 🔄 **存储桶复制** — 跨存储桶复制文件
* 🔗 **智能链接** — 根据文件类型自动生成正确的 Markdown 语法

  * 图片 → `!\[name](url)`
  * 视频 → `<video controls>`
  * 音频 → `<audio controls>`
  * PDF → `\[📄 name](url)`（obsidian好像不支持这种方式，看大家是否有可实现的方法）
* 📝 **笔记反查** — 扫描当前笔记中的缤纷云图片，在侧边栏高亮定位

\---

## 📦 安装

### 方式一：社区插件市场（推荐）

1. 打开 **设置 → 第三方插件 → 浏览**
2. 搜索 **"缤纷云助手"**
3. 点击安装并启用

### 方式二：手动安装

1. 下载最新版本的 `main.js`、`styles.css`、`manifest.json`
2. 放到仓库目录 `.obsidian/plugins/bitiful-helper/` 下
3. 在设置中启用插件

### 方式三：BRAT 安装

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. 点击「Add Beta plugin」
3. 输入 `https://github.com/ViaCai/bitiful-helper`

\---

## ⚙️ 配置

首次使用需要在插件设置中配置缤纷云 S3 API 凭证：

|配置项|说明|
|-|-|
|Access Key ID|缤纷云控制台创建的子账户 Access Key|
|Secret Access Key|对应的 Secret Key|
|Bucket 名称|你的存储桶名称|
|Endpoint|`https://s3.bitiful.net`（默认）|
|Region|`cn-east-1`（默认）|

### 获取 S3 凭证

1. 登录 [缤纷云控制台](https://console.bitiful.com/)
2. 进入「Bucket 设置」页面
3. 创建子账户并分配权限（ListBucket、GetObject、PutObject、DeleteObject）
4. 复制 Access Key 和 Secret Key 到插件设置

\---

## 🚀 使用指南

### 侧边栏文件浏览器

点击左侧边栏的 🌈 图标打开缤纷云助手侧边栏：

* **单击文件夹** → 进入目录
* **单击文件** → 查看文件
* **双击图片** → 预览大图
* **右键文件** → 复制链接 / 插入笔记 / 删除

### 上传文件

* **拖拽上传**：将文件拖拽到侧边栏的拖拽区域
* **剪贴板上传**：在编辑器中粘贴图片，自动上传到缤纷云并插入链接
* **按钮上传**：点击侧边栏的「⬆️ 上传」按钮选择文件

### 批量操作

1. 点击「☐ 批量」进入批量选择模式
2. 勾选需要操作的文件
3. 使用批量工具栏进行复制 Markdown、插入笔记或删除

\---

## 📊 容量分布

侧边栏会实时显示存储桶的容量分布：

* **总计**：显示已用容量 / 免费 50G，带颜色预警

  * 🟢 青色：正常使用（< 90%）
  * 🟠 橙色：即将用完（≥ 90%）
  * 🔴 红色：已超出限制（> 100%）
* **分类统计**：图片、视频、音频、文档、其他

\---

## 🛠️ 开发

```bash
# 克隆仓库
git clone https://github.com/ViaCai/bitiful-helper.git
cd bitiful-helper

# 安装依赖
npm install

# 开发模式（自动编译）
npm run dev

# 构建
npm run build
```

\---

## 📄 许可证

[MIT](LICENSE)

\---

> 本插件为第三方社区作品，与缤纷云官方无直接关联。

