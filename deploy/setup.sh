#!/usr/bin/env bash
# =====================================================================
# Smart QR Manager — 一键部署脚本（Ubuntu / Oracle Cloud ARM 适用）
#
# 用法（在克隆下来的项目目录里运行）：
#     sudo bash deploy/setup.sh your-domain.com
#
# 作用：安装 Node + Nginx + Certbot，配置 systemd 常驻服务、反向代理、
#       HTTPS 证书与防火墙端口。
# 前提：1) 域名的 A 记录已指向本机公网 IP
#       2) Oracle 安全列表已放行 80/443 入站
# =====================================================================
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "用法: sudo bash deploy/setup.sh your-domain.com"
  exit 1
fi

# 以普通用户身份运行服务（取调用 sudo 的用户）
RUN_USER="${SUDO_USER:-$(whoami)}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="/etc/smart-qr.env"

echo "==> 应用目录: $APP_DIR"
echo "==> 运行用户: $RUN_USER"
echo "==> 域名:     $DOMAIN"

# ---------- 1. 安装 Node.js 20 LTS ----------
if ! command -v node >/dev/null 2>&1; then
  echo "==> 安装 Node.js 20 LTS ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "==> Node 版本: $(node -v)"

# ---------- 2. 安装 Nginx / Certbot ----------
echo "==> 安装 Nginx 与 Certbot ..."
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx

# ---------- 3. 安装依赖 ----------
echo "==> 安装项目依赖 ..."
cd "$APP_DIR"
sudo -u "$RUN_USER" npm ci --omit=dev
mkdir -p "$APP_DIR/data"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR/data"

# ---------- 4. 环境变量文件 ----------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> 生成环境变量文件 $ENV_FILE ..."
  SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
JWT_SECRET=$SECRET
BASE_URL=https://$DOMAIN
DATA_DIR=$APP_DIR/data
EOF
  chmod 600 "$ENV_FILE"
else
  echo "==> $ENV_FILE 已存在，跳过（如需改域名请手动编辑 BASE_URL）"
fi

# ---------- 5. systemd 服务 ----------
echo "==> 配置 systemd 服务 ..."
sed -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__USER__|$RUN_USER|g" \
    "$APP_DIR/deploy/smart-qr.service" > /etc/systemd/system/smart-qr.service
systemctl daemon-reload
systemctl enable smart-qr
systemctl restart smart-qr

# ---------- 6. Nginx 反向代理 ----------
echo "==> 配置 Nginx ..."
sed "s|__DOMAIN__|$DOMAIN|g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/smart-qr
ln -sf /etc/nginx/sites-available/smart-qr /etc/nginx/sites-enabled/smart-qr
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ---------- 7. 防火墙（Oracle 镜像默认 iptables 只放行 SSH）----------
echo "==> 放行 80/443 端口 ..."
iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save || true; fi

# ---------- 8. 申请 HTTPS 证书 ----------
echo "==> 申请 Let's Encrypt 证书 ..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --redirect || {
  echo "!! 证书申请失败：请确认域名 A 记录已指向本机、且 80 端口可从公网访问后，重跑："
  echo "   sudo certbot --nginx -d $DOMAIN --redirect"
}

echo ""
echo "======================================================"
echo " 部署完成！ 访问： https://$DOMAIN"
echo " 查看服务状态： sudo systemctl status smart-qr"
echo " 查看日志：     sudo journalctl -u smart-qr -f"
echo "======================================================"
