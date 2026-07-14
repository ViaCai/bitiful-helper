# 🌈 缤纷云助手 (Bitiful Helper)

> A plugin for managing [Bitiful](https://www.bitiful.com/) cloud storage in Obsidian. Supports file browsing, drag-and-drop upload, image compression, watermark, capacity statistics, EXIF viewing, and bucket replication.

> 在 Obsidian 中管理 [缤纷云](https://www.bitiful.com/) 存储，支持文件浏览、上传、图片压缩与水印、容量统计、EXIF 查看、存储桶复制等功能。

---

## 什么是缤纷云？

[缤纷云](https://www.bitiful.com/) 是一款国内云存储服务，提供 **50GB 免费存储空间**，支持 S3 兼容 API，非常适合作为：

- 🖼️ **图床** — 存放笔记中的图片、音频、视频、PDF 等附件
- 📦 **文件仓库** — 备份文档、资料、素材
- 🌐 **CDN 加速** — 文件访问速度快，支持自定义域名

**为什么选择缤纷云作为 Obsidian 图床？**

| 优势 | 说明 |
|-----|------|
| 免费 50GB | 足够存放数万张笔记图片 |
| S3 兼容 API | 与 AWS S3 协议兼容，生态丰富 |
| 国内访问快 | 服务器在国内，无需翻墙 |
| 支持多种文件 | 图片、视频、音频、PDF、文档均可 |
| 自定义域名 | 可绑定自己的域名，链接更专业 |

---

## ✨ 插件功能

- 📂 **文件浏览器** — 侧边栏浏览缤纷云存储桶，支持文件夹导航
- ⬆️ **拖拽上传** — 拖拽文件到侧边栏直接上传，支持剪贴板粘贴图片
- 🖼️ **图片压缩** — 上传时自动压缩图片，节省存储空间
- 💧 **图片水印** — 上传图片自动添加文字水印
- 📷 **EXIF 查看** — 查看图片的拍摄信息（相机型号、拍摄时间等）
- 📊 **容量统计** — 实时统计存储分布，显示免费 50G 容量使用情况
- 🔍 **全局搜索** — 跨目录搜索所有文件
- 📋 **批量操作** — 批量复制、插入、删除文件
- 🔄 **存储桶复制** — 跨存储桶复制文件
- 🔗 **智能链接** — 根据文件类型自动生成正确的 Markdown 语法
  - 图片 → `![name](url)`
  - 视频 → `<video controls>`
 - 音频 → `<audio controls>`
  - PDF → `[📄 name](url)`
- 📝 **笔记反查** — 扫描当前笔记中的缤纷云图片，在侧边栏高亮定位

---

## 📦 安装

### 方式一：手动安装（推荐当前使用）

1. 下载最新版本的 `main.js`、`styles.css`、`manifest.json`
2. 放到 Obsidian 仓库目录 `.obsidian/plugins/bitiful-helper/` 下
3. 在 Obsidian 设置 → 第三方插件中启用「缤纷云助手」

### 方式二：BRAT 安装

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. 命令面板 → **BRAT: Add Beta plugin**
3. 输入 `https://github.com/ViaCai/bitiful-helper`
4. 安装完成后在第三方插件里启用

> 💡 社区插件市场审核中，审核通过后可直接在「浏览」中搜索安装。

---

## 🚀 快速开始：将缤纷云作为 Obsidian 图床

### 第一步：注册缤纷云账号

1. 访问 [缤纷云官网](https://www.bitiful.com/)
2. 点击注册，完成账号创建
3. 登录后进入控制台

### 第二步：创建存储桶

1. 在缤纷云控制台，点击「创建存储桶」
2. 输入存储桶名称（如 `obsidian-notes`）
3. 选择区域，点击创建

### 第三步：获取 S3 API 凭证

1. 进入「Bucket 设置」页面
2. 点击「创建子账户」
3. 为子账户分配权限：
   - ✅ `ListBucket` — 列出文件
   - ✅ `GetObject` — 下载文件
   - ✅ `PutObject` — 上传文件
   - ✅ `DeleteObject` — 删除文件
4. 保存并复制 **Access Key** 和 **Secret Key**

> ⚠️ **重要**：Secret Key 只显示一次，请妥善保存！

### 第四步：配置插件

1. 在 Obsidian 中打开「缤纷云助手」设置
2. 填入以下信息：

| 配置项 | 值 | 说明 |
|-------|-----|------|
| Access Key ID | 你的 Access Key | 从缤纷云控制台获取 |
| Secret Access Key | 你的 Secret Key | 从缤纷云控制台获取 |
| Bucket 名称 | `obsidian-notes` | 你创建的存储桶名 |
| Endpoint | `https://s3.bitiful.net` | 默认即可 |
| Region | `cn-east-1` | 默认即可 |

3. 点击「测试连接」，显示 ✅ 连接成功即可使用

### 第五步：开始使用

**上传图片到图床**：
- 在编辑器中 **粘贴图片**（Ctrl+V），自动上传并插入链接
- 或拖拽图片到侧边栏的拖拽区域
- 或点击侧边栏「⬆️ 上传」按钮选择文件

**在笔记中插入文件**：
- 在侧边栏找到文件 → 点击「⬇️ 插入笔记」
- 或右键文件 → 「复制 Markdown」→ 粘贴到笔记

---

## ⚙️ 高级配置

### 图片压缩

开启后，上传的图片会自动压缩为 JPEG 格式，大幅减少文件体积：

- **压缩质量**：1-100，推荐 80（质量与体积的平衡点）
- **自动重命名**：上传时按时间戳重命名，避免文件名冲突

### 图片水印

- **水印文字**：支持自定义文字，如你的名字或版权信息
- **位置**：左上角、右上角、左下角、右下角、居中
- **透明度**：0.1-1.0，推荐 0.5
- **字体大小**：12-72px，推荐 24

### 自定义链接模板

默认模板：`![{{filename}}]({{url}})`

可用变量：
- `{{filename}}` — 完整文件名
- `{{basename}}` — 不带扩展名的文件名
- `{{ext}}` — 扩展名
- `{{url}}` — 文件访问链接

示例：
- `![{{basename}}]({{url}})` — 只显示文件名
- `<img src="{{url}}" alt="{{filename}}" width="600">` — 自定义 HTML

### 自定义域名

如果你在缤纷云绑定了自定义 CDN 域名（如 `https://cdn.example.com`），在设置中填写后，所有生成的链接都会使用你的域名。

---

## 📊 容量管理

侧边栏实时显示存储桶容量分布：

```
📊 容量分布
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
● 总计   18.5%  ███          9.25 GB / 50G
✅ 免费容量 50G，剩余 40.75 GB
共 156 个文件，23 个文件夹

● 图片    1.4%  █            129.75 MB
● 音频   90.0%  ████████████  8.44 GB
● 文档    8.6%  █             830.93 MB
```

- 🟢 **青色**（< 90%）：正常使用
- 🟠 **橙色**（≥ 90%）：即将用完，注意清理
- 🔴 **红色**（> 100%）：已超出免费额度

---

## 🛠️ 开发

```bash
# 克隆仓库
git clone https://github.com/ViaCai/bitiful-helper.git
cd bitiful-helper

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build
```

---

## 📄 许可证

[MIT](LICENSE)

---

> 本插件为第三方社区作品，与缤纷云官方无直接关联。

## ☕ 支持我

![微信收款码](images/wechat-pay.png)
