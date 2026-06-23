# 部署到 Vercel（+ Upstash 免费数据库）

Vercel 是 Serverless 平台、没有持久磁盘，所以数据存放在 **Upstash Redis**（免费、免信用卡）。
本应用已支持：未配置 Upstash 时用本地文件存储（开发），配置后自动切换到 Redis（线上）。

全程**无需信用卡**，用 GitHub / 邮箱登录即可。

---

## 第 1 步：创建 Upstash Redis 数据库（免费）
1. 打开 https://upstash.com ，用 GitHub / Google 登录。
2. **Create Database** → 类型选 **Redis** → 名称随意 → Region 选离用户近的（或离 Vercel 部署区近的）→ 免费档（Free）即可创建。
3. 进入数据库详情页，在 **REST API** 区域复制两项备用：
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

## 第 2 步：导入项目到 Vercel
1. 打开 https://vercel.com ，用 **GitHub 登录**。
2. **Add New… → Project** → 选择仓库 `smart-qr-manager` → **Import**。
3. Framework Preset 选 **Other**（项目已带 `vercel.json`，无需改构建命令）。
4. 展开 **Environment Variables**，添加：

   | 变量名 | 值 |
   |--------|----|
   | `UPSTASH_REDIS_REST_URL` | 第 1 步复制的 URL |
   | `UPSTASH_REDIS_REST_TOKEN` | 第 1 步复制的 Token |
   | `JWT_SECRET` | 一段随机字符串（见下方生成方法） |

   生成 `JWT_SECRET`（本机终端运行，任选其一）：
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   > `BASE_URL` 暂时不用填——应用会自动按访问的域名生成二维码。绑定自有域名后再回来设置（第 4 步）。

5. 点 **Deploy**，等待构建完成。

## 第 3 步：测试
部署成功后会得到一个 `https://你的项目名.vercel.app` 地址。打开它：
- 注册账号、创建二维码 / 表单、用手机扫码填写，走一遍完整流程。
- 因为用了 Upstash，数据会**持久保存**，重新部署也不丢。

## 第 4 步（可选）：绑定阿里云 .com 域名
1. Vercel 项目 → **Settings → Domains** → 输入你的域名 → **Add**。
2. Vercel 会给出需要配置的 DNS 记录（通常是：根域名一条 `A` 记录指向 `76.76.21.21`；`www` 一条 `CNAME` 指向 `cname.vercel-dns.com`，以页面实际显示为准）。
3. 到**阿里云云解析 DNS** 按上面添加对应记录（别忘了域名已做**实名认证**）。境外服务，**无需 ICP 备案**。
4. 等 Vercel 显示域名 **Valid**，它会自动签发 HTTPS 证书。
5. 绑定好后，建议把环境变量 `BASE_URL` 设为 `https://你的域名`，再 **Redeploy** 一次，确保所有二维码都统一编码这个正式域名。

---

## 日常更新
改完代码 `git push` 到 GitHub，Vercel 会**自动重新部署**，无需手动操作。

## 说明 / 限制
- 当前存储为「整库一个 JSON 文档」，适合中小规模（个人、活动报名等）。若未来数据量很大或高并发，建议改用更细粒度的存储（如 Neon Postgres），可再迭代。
- 本地开发仍可 `npm start`（不配 Upstash 时自动用 `data/` 文件存储）。
