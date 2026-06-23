# 部署到 Oracle Cloud 永久免费服务器（含域名 + HTTPS）

本指南把 Smart QR Manager 部署成一个真实、长期在线的网站。
适用：Oracle Cloud「Always Free」ARM 云主机 + 一个 .com 域名。

> 你需要动手的只有：注册 Oracle、买域名、配 DNS、复制粘贴几条命令。
> 服务器配置、反向代理、HTTPS、防火墙都由 `deploy/setup.sh` 自动完成。

---

## 第 1 步：买域名并准备 DNS
任选一家注册商：
- **国外**：Cloudflare Registrar 或 Porkbun（按成本价、便宜）。可把 DNS 托管到 Cloudflare（免费）。
- **阿里云**：注册 `.com` 后**务必完成「域名实名认证」**（国内注册商硬性要求，否则数天后会被暂停解析）。
  本项目部署在**境外** Oracle 服务器，**无需 ICP 备案**。第 4 步直接用阿里云「云解析 DNS」添加 A 记录即可。

（第 4 步拿到服务器 IP 后再来添加 A 记录。）

## 第 2 步：开通 Oracle Cloud 永久免费云主机
1. 注册 https://www.oracle.com/cloud/free/ （需一张信用卡做验证，不会扣费；选 Always Free 资源不收费）。
2. 控制台 → **Compute → Instances → Create Instance**：
   - **Image**：Ubuntu 22.04（Canonical Ubuntu）
   - **Shape**：选 **Ampere（ARM）VM.Standard.A1.Flex**，1 OCPU / 6GB 内存即可（在 Always Free 额度内）
   - **SSH keys**：上传你本机的公钥，或让它生成并下载私钥
   - 创建后记下实例的 **Public IP address**

## 第 3 步：放行 80 / 443 端口（Oracle 安全列表）
控制台 → 实例所在的 **VCN → Security Lists → Default Security List → Add Ingress Rules**，
各加一条：
- Source CIDR `0.0.0.0/0`，IP Protocol **TCP**，Destination Port **80**
- Source CIDR `0.0.0.0/0`，IP Protocol **TCP**，Destination Port **443**

## 第 4 步：把域名指向服务器
在你的 DNS 管理处添加 A 记录，内容填第 2 步的 Public IP：

- **阿里云云解析**：域名 → 解析设置 → 添加记录：类型 `A`，主机记录 `@`，记录值 = Public IP；再加一条主机记录 `www`（可选）。
- **Cloudflare**：类型 `A`，名称 `@`（和 `www`），内容 = Public IP；先设为**仅 DNS（关闭橙色云朵）**，等证书签发成功后再视需要开启代理。

等几分钟让 DNS 生效（可用 `ping your-domain.com` 验证返回的是服务器 IP）。

## 第 5 步：登录服务器并部署
```bash
# 用你的私钥 SSH 登录（Ubuntu 镜像默认用户名 ubuntu）
ssh ubuntu@你的服务器IP

# 安装 git 并克隆项目
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Liyucheng1997/smart-qr-manager.git
cd smart-qr-manager

# 一键部署（把域名换成你买的那个）
sudo bash deploy/setup.sh your-domain.com
```
脚本结束后会打印 `部署完成！访问： https://your-domain.com`。用浏览器和手机分别打开试试，注册账号、创建二维码/表单、扫码填写全流程。

---

## 日常运维

| 操作 | 命令 |
|------|------|
| 查看运行状态 | `sudo systemctl status smart-qr` |
| 实时日志 | `sudo journalctl -u smart-qr -f` |
| 重启服务 | `sudo systemctl restart smart-qr` |
| 更新代码 | `cd ~/smart-qr-manager && git pull && npm ci --omit=dev && sudo systemctl restart smart-qr` |
| 数据位置 | `~/smart-qr-manager/data/db.json`（含自动备份 `db.backup.json`） |
| 改域名 | 编辑 `/etc/smart-qr.env` 的 `BASE_URL`，再 `sudo systemctl restart smart-qr` |

### 备份数据
```bash
# 下载到本机
scp ubuntu@你的IP:~/smart-qr-manager/data/db.json ./db-backup-$(date +%F).json
```
建议偶尔备份一次，或设个 cron 定时复制 `data/` 目录。

### HTTPS 证书续期
certbot 会自动续期（systemd timer）。手动测试：`sudo certbot renew --dry-run`。

---

## 常见问题
- **打不开网站**：先确认第 3 步安全列表和脚本里的 iptables 都放行了 80/443；`sudo systemctl status smart-qr` 看服务是否在跑。
- **证书申请失败**：多半是 DNS 还没生效或 80 端口不通。等 DNS 生效后重跑 `sudo certbot --nginx -d your-domain.com --redirect`。
- **扫码地址不对**：检查 `/etc/smart-qr.env` 的 `BASE_URL` 是否为 `https://你的域名`，改完重启服务，并重新生成/分发二维码。
