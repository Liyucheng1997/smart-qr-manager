# Smart QR Manager

生成与管理二维码、追踪扫码统计，并支持自定义信息收集表单（多主题）的全栈应用。

> v1.0

## 功能

### 动态二维码
- 创建可统计的动态二维码，扫码先经后端记录再跳转目标。
- 二维码印好后仍可随时修改跳转链接，无需重新打印。
- 扫码统计：累计次数、最近 14 天趋势曲线、设备类型（手机 / 平板 / 电脑）分布。

### 收集表单
- 自定义要收集的字段，支持 9 种类型：单行/多行文本、邮箱、电话、数字、日期、下拉、单选、多选。
- 字段可设必填、排序、删除，并提供"姓名/电话"常用预设。
- 生成表单二维码，扫码者填写后，后台可查看全部提交记录并导出 CSV（带 BOM，Excel 中文不乱码）。
- **6 套填写页风格**，适配不同场景：简约 / 商务 / 优雅 / 活力 / 自然 / 暗夜。
- 可上传 Logo 叠加到二维码中心（采用高纠错等级 H，仍可正常扫描）。

### 账号与个人中心
- 邮箱注册 / 登录，密码以 bcrypt 哈希存储，JWT 存于 httpOnly Cookie。
- "我的信息"页集中展示账号信息与全部二维码 / 表单项目及数据概览。

### 数据安全
- 本地 JSON 存储，每次写入自动备份到 `data/db.backup.json`，主文件损坏或丢失时启动自动恢复。

## 技术栈
- 后端：Node.js + Express
- 存储：本地 JSON 文件（零额外依赖）
- 认证：bcryptjs + JWT
- 二维码：`qrcode`（服务端生成 PNG），首页快速生成 + 中心 Logo（客户端 canvas 合成）
- 前端：原生 HTML/CSS/JS + Chart.js（统计图表）

## 快速开始

```bash
npm install
npm start          # 访问 http://localhost:3000
# 或 npm run dev   （文件改动自动重启）
```

### 环境变量
- `PORT`：端口（默认 3000）
- `BASE_URL`：对外访问地址，二维码会编码 `BASE_URL/r/:id` 或 `BASE_URL/f/:id`
- `JWT_SECRET`：生产环境务必设置为自己的密钥

### 让别人扫码（公网访问）
本地 `localhost` 只有自己能访问。要让别人扫码，需要一个公网地址：

- **同一 WiFi**：用局域网 IP 启动，例如 `BASE_URL=http://192.168.1.10:3000 npm start`
- **公网临时隧道**：运行 `./start-public.ps1`（基于 Cloudflare Tunnel，自动获取公网网址并以该地址启动服务）。适合演示/短期活动，地址重启会变。
- **永久部署**：部署到云服务器并绑定自有域名 + HTTPS，见 [deploy/DEPLOY.md](deploy/DEPLOY.md)（含 Oracle Cloud 永久免费方案与一键脚本）。

## 页面
| 页面 | 路径 | 说明 |
|------|------|------|
| 首页 | `/` | 介绍 + 快速生成（静态二维码） |
| 登录/注册 | `/login.html` | 同页切换 |
| 二维码控制台 | `/dashboard.html` | 二维码列表 |
| 创建二维码 | `/create.html` | 标题 + 目标链接 |
| 二维码详情 | `/detail.html?id=` | 图片、追踪短链、扫码数 |
| 二维码编辑 | `/edit.html?id=` | 修改标题/链接 |
| 二维码统计 | `/stats.html?id=` | 次数、趋势、设备分布 |
| 表单列表 | `/forms.html` | 表单列表 |
| 表单设计器 | `/form-builder.html` | 自定义字段 + 选择风格 |
| 表单二维码 | `/form-detail.html?id=` | 二维码 + Logo 上传 |
| 收集结果 | `/form-submissions.html?id=` | 提交记录 + CSV 导出 |
| 填写页（公开） | `/f/:id` | 扫码者填写 |
| 我的信息 | `/profile.html` | 账号信息 + 全部项目 |

## API 速览
- 认证：`POST /api/auth/register|login|logout` · `GET /api/auth/me` · `GET /api/profile`
- 二维码：`GET/POST /api/qrcodes` · `GET/PUT/DELETE /api/qrcodes/:id` · `GET /api/qrcodes/:id/image|stats`
- 表单：`GET/POST /api/forms` · `GET/PUT/DELETE /api/forms/:id` · `GET /api/forms/:id/image|submissions|export`
- 公开：`GET /api/public/forms/:id` · `POST /api/public/forms/:id/submit` · `GET /r/:id`（扫码重定向）· `GET /f/:id`（填写页）· `GET /api/quick?text=`（快速生成）

## 许可
MIT
