// 虎皮椒(xunhupay) 聚合支付对接 —— 微信/支付宝扫码 + 异步回调
// 文档: https://www.xunhupay.com/doc/api/pay.html
import crypto from 'crypto';

const APPID = process.env.XUNHU_APPID || '';
const APPSECRET = process.env.XUNHU_APPSECRET || '';
const API_URL = process.env.XUNHU_API_URL || 'https://api.xunhupay.com/payment/do.html';
const VERSION = '1.1';

// 是否已配置好支付通道（没配则下单接口会明确报错，但手动开通仍可用）
export const paymentConfigured = !!(APPID && APPSECRET);

// 会员价格（元），可用环境变量覆盖
export const MEMBERSHIP_PRICE = process.env.MEMBERSHIP_PRICE || '9.90';

// 签名：非空参数(去掉 hash)按键名 ASCII 升序拼成 k=v&k=v，末尾直接接 APPSECRET，md5 小写
export function sign(params) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'hash' && params[k] !== '' && params[k] != null)
    .sort();
  const stringA = keys.map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('md5').update(stringA + APPSECRET).digest('hex');
}

// 创建订单，返回 { url, url_qrcode } 供前端展示二维码/跳转
export async function createOrder({ tradeOrderId, totalFee, title, notifyUrl, returnUrl, callbackUrl }) {
  if (!paymentConfigured) throw new Error('支付通道未配置（缺少 XUNHU_APPID/XUNHU_APPSECRET）');
  const params = {
    version: VERSION,
    appid: APPID,
    trade_order_id: tradeOrderId,
    total_fee: totalFee,
    title,
    time: Math.floor(Date.now() / 1000),
    notify_url: notifyUrl,
    nonce_str: crypto.randomBytes(8).toString('hex'),
  };
  if (returnUrl) params.return_url = returnUrl;
  if (callbackUrl) params.callback_url = callbackUrl;
  params.hash = sign(params);

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (data.errcode !== 0) {
    throw new Error(`支付下单失败: ${data.errmsg || data.errcode || '未知错误'}`);
  }
  return { url: data.url, urlQrcode: data.url_qrcode, openOrderId: data.openid };
}

// 校验回调签名是否合法
export function verifyNotify(body) {
  if (!body || !body.hash) return false;
  const expect = sign(body);
  return expect === String(body.hash).toLowerCase();
}
