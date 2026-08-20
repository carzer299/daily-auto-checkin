/**
 * 每日自动签到脚本（增强版）：杜搭子(DuMate) / WorkBuddy / Trae Work CN
 *
 * 凭据全部从各应用本地存储实时读取（应用自身负责刷新令牌），脚本不落盘任何令牌。
 *
 * 用法:
 *   node daily-checkin.js [--once] [--dry-run] [--only=trae|dumate|workbuddy]
 *   默认进入守护循环，每天自动签到；--once 只执行一轮立即退出。
 *
 * 特性:
 *   - 内置每日自动运行（常驻守护，默认每天 09:30，可用环境变量 CHECKIN_TIME=HH:MM 覆盖）
 *   - 幂等保护（已在检查查询层兜底"今日已签到"）
 *   - 防重入锁（lock 目录，避免多实例同时领取）
 *   - 合并关键日志落盘 ~/.daily-checkin/logs/ 与 CRITICAL 持久文件
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ---------------- CLI / 环境解析 ----------------
const DRY_RUN = process.argv.includes('--dry-run');
const ONCE = process.argv.includes('--once');
const LOOP = !ONCE; // 默认守护循环
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

// 每日自动签到时间点（HH:MM，24 小时制），可由环境变量覆盖
const CHECKIN_TIME = (process.env.CHECKIN_TIME || '09:30').trim();
// 多签到时间点：逗号分隔的 HH:MM 列表，可用 CHECKIN_TIMES 环境变量配置，
// 例如 "00:05,09:30,18:00"（适合想在多个时段补签的场景）。默认仅 09:30 一次。
const CHECKIN_TIMES = (process.env.CHECKIN_TIMES || CHECKIN_TIME)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

// 状态/日志基础目录；默认用户主目录，可用环境变量 CHECKIN_BASE_DIR 覆盖
const BASE_DIR = process.env.CHECKIN_BASE_DIR
  ? path.resolve(process.env.CHECKIN_BASE_DIR)
  : path.join(HOME, '.daily-checkin');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const LOCK_DIR = path.join(BASE_DIR, 'locks');
const STATE_FILE = path.join(BASE_DIR, 'state.json');
// CRITICAL 日志：仅记录"间歇性失败/凭证失效"等需要人工关注的信息，可长期保留，单文件覆盖式写入
const CRITICAL_FILE = path.join(BASE_DIR, 'critical.log');

function ensureDirs() {
  for (const d of [LOG_DIR, LOCK_DIR]) fs.mkdirSync(d, { recursive: true });
}

// ---------------- 通用工具 ----------------
function pad(n) { return String(n).padStart(2, '0'); }

function nowObj() {
  return new Date();
}

function tsOf(d = new Date()) {
  const p = (n) => pad(n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 文本形式的"今天日期"，用于幂等/状态记录去重
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function log(lines) {
  ensureDirs();
  const text = lines.map((l) => `[${tsOf()}] ${l}`).join('\n') + '\n';
  process.stdout.write(text);
  const month = `${nowObj().getFullYear()}-${pad(nowObj().getMonth() + 1)}`;
  fs.appendFileSync(path.join(LOG_DIR, `checkin-${month}.log`), text, 'utf8');
}

// 记录需要人工关注的关键问题（间歇性失败 / 凭证失效 / 频控），重叠写入以便快速查看
function logCritical(title, detail) {
  ensureDirs();
  const line = `[${tsOf()}] ${title}: ${detail}`;
  log([line]);
  fs.appendFileSync(CRITICAL_FILE, line + '\n', 'utf8');
}

// 防重入锁：以产品名为锁名，使用跨平台可靠的"独占创建"语义（不依赖文件锁权限位）
function withLock(name, fn) {
  const lockFile = path.join(LOCK_DIR, `${name}.lock`);
  const token = `${process.pid}-${Date.now()}`;
  // 使用 fs.open 的 wx 标志实现独占创建，比写文件后检查存在更可靠、无竞态
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, token);
    fs.closeSync(fd);
  } catch (err) {
    // 若锁已过期（超过 10 分钟未清理），视为残留锁并接管，避免长期卡死
    let stale = false;
    try {
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      stale = age > 10 * 60 * 1000;
    } catch { stale = true; }
    if (stale) {
      try { fs.rmSync(lockFile, { force: true }); } catch {}
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeSync(fd, token);
        fs.closeSync(fd);
      } catch (e2) {
        throw new Error(`产品 ${name} 正被另一个进程处理，已跳过（锁获取失败: ${e2.message}）`);
      }
    } else {
      throw new Error(`产品 ${name} 正被另一个进程处理，本次跳过`);
    }
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      try { fs.rmSync(lockFile, { force: true }); } catch {}
    }
  })();
}

// 读取/写入轻量状态文件（用于幂等判断，例如当日已成功领取则不再领取）
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, headers: res.headers, data, text };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 毫秒到 HH 时间文本（用于日志展示）
function hhmmOf(ms) {
  const s = Math.round(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`;
}

// 计算从此刻到下一个签到时间点（HH:MM 列表）的相对毫秒数；当天已过则顺延到明天
function msUntilNextCheckin(timeList) {
  const now = new Date();
  let best = Infinity;
  for (const timeStr of timeList) {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(timeStr).trim());
    if (!m) throw new Error(`签到时间格式错误: "${timeStr}"（应为 HH:MM）`);
    const targetH = parseInt(m[1], 10);
    const targetM = parseInt(m[2], 10);
    if (targetH > 23 || targetM > 59) throw new Error(`签到时间越界: "${timeStr}"`);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetH, targetM, 0, 0);
    let diff = today.getTime() - now.getTime();
    if (diff <= 0) diff += 24 * 3600 * 1000; // 今天该点已过，顺延到明天
    if (diff < best) best = diff;
  }
  return best;
}

// ---------------- WorkBuddy ----------------
async function checkinWorkbuddy() {
  const sessionFile = path.join(LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const token = session?.auth?.accessToken;
  const uid = session?.account?.uid;
  if (!token || !uid) throw new Error('会话文件中缺少 accessToken/uid，请先在 WorkBuddy 客户端登录');

  const base = 'https://copilot.tencent.com';
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-User-Id': uid,
    'User-Agent': 'WorkBuddy/5.3.13',
  };

  const status = await httpJson(`${base}/v2/billing/meter/checkin-activity-status`, { method: 'POST', headers, body: {} });
  if (status.status !== 200 || status.data?.code !== 0) {
    if (status.status === 401 || status.data?.code === 401) {
      throw new Error('WorkBuddy 登录态已失效，请打开 WorkBuddy 客户端重新登录');
    }
    throw new Error(`查询签到状态失败: HTTP ${status.status}, code=${status.data?.code}, msg=${status.data?.msg}`);
  }
  const st = status.data.data || {};
  if (st.today_checked_in || st.checked_in) {
    return `今日已签到（连续 ${st.streak_days ?? '?'} 天 / 累计 ${st.total_credits ?? '?'} 积分），无需重复领取`;
  }
  if (!st.active) return '签到活动未开放';
  if (DRY_RUN) return '尚未签到（dry-run，跳过领取）';

  const claim = await httpJson(`${base}/v2/billing/meter/daily-checkin`, { method: 'POST', headers, body: {} });
  if (claim.status === 200 && claim.data?.code === 0) {
    const d = claim.data.data || {};
    const credits = d.today_credit ?? d.daily_credit ?? st.daily_credit ?? '?';
    return credits !== '?' ? `签到成功，积分 +${credits}` : '签到成功';
  }
  // code=10001 表示今天已签到，不是真正的失败
  if (claim.data?.code === 10001 || (claim.data?.msg && claim.data.msg.includes('已签到'))) {
    return `今日已签到（连续 ${st.streak_days ?? '?'} 天），无需重复领取`;
  }
  throw new Error(`签到失败: HTTP ${claim.status}, code=${claim.data?.code}, msg=${claim.data?.msg}`);
}

// ---------------- 杜搭子 (DuMate) ----------------
function dumateDecryptCookies() {
  const dir = path.join(APPDATA, 'qianfan-desktop-app');
  const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  const key = fs.readFileSync(path.join(dir, '.cookie-key'));
  const buf = Buffer.from(auth.cookies, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const cipher = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

function dumateBuildCookieHeader(cookies, targetHost) {
  const now = Date.now() / 1000;
  const hostname = targetHost.replace(/^https?:\/\//, '').split('/')[0];
  const matchesDomain = (domainStr) => {
    if (!domainStr) return true;
    const d = domainStr.startsWith('.') ? domainStr.slice(1) : domainStr;
    return hostname === d || hostname.endsWith('.' + d);
  };
  const unquote = (v) => v.replace(/^["']+|["']+$/g, '');
  const live = cookies.filter((c) => !(c.expirationDate && c.expirationDate < now));
  const matched = live.filter((c) => matchesDomain(c.domain));
  const cookie = matched
    .map((c) => {
      let val = unquote(c.value);
      // 与客户端一致：值含特殊字符时用引号包裹
      if (/[:|;=\s]/.test(val)) val = `"${val}"`;
      return `${c.name}=${val}`;
    })
    .join('; ');
  // 与客户端一致：csrftoken 取 bce-user-info cookie 的值（去引号），而非名为 csrftoken 的 cookie
  const bceUserInfo = matched.find((c) => c.name === 'bce-user-info');
  const csrftoken = bceUserInfo ? unquote(bceUserInfo.value) : '';
  return { cookie, csrftoken };
}

async function checkinDumate() {
  const cookies = dumateDecryptCookies();
  const { cookie, csrftoken } = dumateBuildCookieHeader(cookies, 'console.bce.baidu.com');
  if (!cookie) throw new Error('未找到 console.bce.baidu.com 的登录 Cookie，请先在杜搭子客户端登录');

  const base = 'https://console.bce.baidu.com';
  const headers = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: base,
    Referer: base + '/',
    Cookie: cookie,
    ...(csrftoken ? { csrftoken } : {}),
  };

  const info = await httpJson(`${base}/api/dumate/points/loginBonusInfo`, { method: 'GET', headers });
  if (info.status !== 200 || info.data?.code !== 0) {
    if (info.status === 302 || info.status === 401 || info.data?.code === 401) {
      throw new Error('杜搭子登录态已失效，请打开杜搭子客户端重新登录');
    }
    throw new Error(`查询签到状态失败: HTTP ${info.status}, code=${info.data?.code}, msg=${info.data?.message}`);
  }
  const bonus = info.data.result || {};
  if (bonus.hasIssued) {
    return `今日已签到（累计 ${bonus.totalTimes ?? '?'} 天 / ${bonus.totalPoints ?? '?'} 积分），无需重复领取`;
  }
  if (DRY_RUN) return '尚未签到（dry-run，跳过领取）';

  const claim = await httpJson(`${base}/api/dumate/points/loginBonus`, { method: 'POST', headers, body: {} });
  const data = claim.data ?? {};
  // 兼容不同返回结构：有些接口用 code=0 / errno=0，有些直接返回 result/points
  const ok =
    claim.status === 200 &&
    ((typeof data.code === 'number' && data.code === 0) ||
      (typeof data.errno === 'number' && data.errno === 0) ||
      (data.result && !data.result.error) ||
      typeof data.points === 'number');
  if (ok) {
    return '签到成功，积分 +500';
  }
  const rawMsg = data.message ?? data.msg ?? data.error ?? data;
  const msg = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
  throw new Error(`签到失败: HTTP ${claim.status}, code=${data.code}, errno=${data.errno}, msg=${msg}`);
}

// ---------------- Trae Work CN ----------------
const TRAE_GTE = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const TRAE_JTE = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);

function traeDecryptBlob(b64) {
  const t = Buffer.from(b64, 'base64');
  if (t[0] !== 116 || t[1] !== 99) throw new Error('未知的加密版本，可能需要更新脚本');
  const sha512 = (buf) => new Uint8Array(crypto.createHash('sha512').update(Buffer.from(buf)).digest());
  const pad64 = new Uint8Array(64);
  for (let i = 0; i < 64; i++) pad64[i] = TRAE_GTE[i] ^ TRAE_JTE[i];
  const key = t.subarray(6, 38);
  let n = new Uint8Array(128);
  n.set(sha512(key), 0);
  n.set(pad64, 64);
  n.set(sha512(n), 0);
  const aesKey = Buffer.from(n.slice(0, 16));
  const iv = Buffer.from(n.slice(16, 32));
  const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
  const plain = Buffer.concat([decipher.update(t.subarray(38)), decipher.final()]);
  const hash = sha512(plain.subarray(64));
  for (let i = 0; i < 64; i++) if (hash[i] !== plain[i]) throw new Error('解密校验失败');
  return plain.subarray(64).toString('utf8');
}

// 提取 Trae 的 AHA 设备 ID：
// 1) storage.json 中 iCubeAuthInfo://icube-dc:<设备ID> 键名（主来源，稳定）
// 2) 回退：解析最近的 TRAE 客户端日志中 [ICDRS] 设备注册记录
// 3) 兜底：telemetry.devDeviceId（旧值，可能导致 9074 风控）
function extractTraeDeviceId(storage) {
  const keyHit = /iCubeAuthInfo:\/\/icube-dc:(\d+)/.exec(Object.keys(storage).join('\n'));
  if (keyHit) return keyHit[1];
  try {
    const logsDir = path.join(APPDATA, 'TRAE SOLO CN', 'logs');
    const sessions = fs.readdirSync(logsDir)
      .filter((n) => /^\d{8}T\d{6}$/.test(n))
      .sort()
      .reverse()
      .slice(0, 5);
    for (const s of sessions) {
      const mainLog = path.join(logsDir, s, 'main.log');
      if (!fs.existsSync(mainLog)) continue;
      const fd = fs.openSync(mainLog, 'r');
      try {
        const buf = Buffer.alloc(262144);
        const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytes).toString('utf8');
        const m = /\[ICDRS\] \(constructor\) did: (\d+)/.exec(head)
          || /\[ICDRS\] \(init\) initialization done, did: (\d+)/.exec(head);
        if (m) return m[1];
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch { /* 日志不可读时走兜底 */ }
  return storage['telemetry.devDeviceId'] || storage['telemetry.machineId'] || '';
}

// Trae 凭据 blob 的加密（traeDecryptBlob 的逆运算）。
// header 保留原 blob 的前 6 字节（版本标识），随后是 32 字节随机密钥 + AES-128-CBC 密文，
// 明文 = sha512(json) 64 字节 + json。
function traeEncryptBlob(json, oldB64) {
  const old = Buffer.from(oldB64, 'base64');
  const header = old.subarray(0, 6);
  const key = crypto.randomBytes(32);
  const sha512 = (buf) => new Uint8Array(crypto.createHash('sha512').update(Buffer.from(buf)).digest());
  const pad64 = new Uint8Array(64);
  for (let i = 0; i < 64; i++) pad64[i] = TRAE_GTE[i] ^ TRAE_JTE[i];
  let n = new Uint8Array(128);
  n.set(sha512(key), 0);
  n.set(pad64, 64);
  n.set(sha512(n), 0);
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(n.slice(0, 16)), Buffer.from(n.slice(16, 32)));
  const jsonBuf = Buffer.from(json, 'utf8');
  const plain = Buffer.concat([Buffer.from(sha512(jsonBuf)), jsonBuf]);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, key, ct]).toString('base64');
}

// TRAE 客户端是否正在运行（刷新令牌时会轮换 refresh token，
// 客户端运行期间写回 storage.json 会被其退出时的内存态覆盖，导致互相失效）
function isTraeRunning() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('tasklist /NH', { encoding: 'utf8', timeout: 10000 });
    return /trae/i.test(out);
  } catch {
    return false; // 无法检测时不阻止签到（刷新逻辑自行兜底）
  }
}

// Trae 令牌自动续期：
// 逆向自客户端 oauth 模块 —— POST {host}/trae/api/v3/oauth/ExchangeToken，
// 请求需设备密钥对（存储于 iCubeAuthInfo://icube-dc:<设备ID>）对
// "POST\n路径\nClientID\nrefreshToken\n时间戳\n随机数" 做 ECDSA-P256/sha256 签名。
// 续期成功后把新令牌按原格式加密写回 storage.json（客户端下次启动直接可用）。
// 触发条件：令牌剩余有效期不足 24 小时（或已过期但 refresh token 仍有效），且客户端未运行。
async function refreshTraeTokenIfNeeded(storagePath, storage, info, deviceId) {
  const remainMs = Date.parse(info.expiredAt) - Date.now();
  if (Number.isFinite(remainMs) && remainMs > 24 * 3600 * 1000) return null; // 未到期，无需续期
  if (!info.refreshToken) throw new Error('令牌临近过期但缺少 refreshToken，请打开 TRAE 客户端登录一次');
  if (info.refreshExpiredAt && Date.now() > Date.parse(info.refreshExpiredAt)) {
    throw new Error('refresh token 已过期，请打开 TRAE 客户端重新登录');
  }
  if (isTraeRunning()) {
    log(['Trae 令牌临近有效期，但 TRAE 客户端正在运行，跳过脚本续期（客户端会自行续期）']);
    return null;
  }

  const kpKey = `iCubeAuthInfo://icube-dc:${deviceId}`;
  const kpBlob = storage[kpKey];
  if (!kpBlob) throw new Error('未找到 Trae 设备密钥对（' + kpKey + '），请打开 TRAE 客户端重新登录');
  const kp = JSON.parse(traeDecryptBlob(kpBlob));
  if (!kp.privateKeyPEM || !kp.publicKeyPEM) throw new Error('设备密钥对内容异常');

  const clientID = 'en1oxy7wnw8j9n'; // TRAE SOLO CN (Lite) 稳定渠道 ClientID
  const ideVersion = storage['iCubeLastVersion'] || '2.3.71801';
  const host = info.host || 'https://api.trae.cn';
  const urlPath = '/trae/api/v3/oauth/ExchangeToken';

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = ['POST', urlPath, clientID, info.refreshToken, String(timestamp), nonce].join('\n');
  const signature = crypto.sign('sha256', Buffer.from(payload), kp.privateKeyPEM).toString('base64');

  const cpuModel = (os.cpus()[0] || {}).model || '';
  const body = {
    ClientID: clientID,
    ClientSecret: '',
    RefreshToken: info.refreshToken,
    DeviceInfo: {
      DeviceID: deviceId,
      MachineID: storage['telemetry.machineId'] || '',
      PlatformCode: 'SOLO_PC',
      DeviceType: 'PC',
      DeviceName: process.env.USERNAME || process.env.USER || '',
      DeviceModel: '',
      ClientVersion: ideVersion,
      DevicePublicKey: kp.publicKeyPEM,
      DeviceBrand: '',
      DeviceCPU: cpuModel,
      OSInfo: 'Windows',
      OSVersion: os.release(),
    },
    DeviceProof: { Signature: signature, Timestamp: timestamp, Nonce: nonce },
    IDEVersion: ideVersion,
  };

  const res = await httpJson(`${host}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cloudide-token': info.token },
    body,
  });
  const errCode = res.data?.ResponseMetadata?.Error?.Code;
  if (errCode) {
    throw new Error(`Trae 令牌续期失败: ${errCode} ${res.data.ResponseMetadata.Error.Message || ''}`);
  }
  const r = res.data?.Result;
  if (!r || !r.Token || !r.RefreshToken) throw new Error('Trae 令牌续期响应异常: ' + JSON.stringify(res.data).slice(0, 200));

  // 校验新令牌有效（等价于客户端续期后的 GetUserInfo 步骤）
  const verify = await httpJson(`${host}/cloudide/api/v3/trae/GetUserInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cloudide-token': r.Token },
    body: { ReqSource: 'Lite', IDEVersion: ideVersion },
  });
  if (verify.data?.ResponseMetadata?.Error?.Code || !verify.data?.Result?.UserID) {
    throw new Error('Trae 新令牌校验失败: ' + JSON.stringify(verify.data).slice(0, 200));
  }
  if (verify.data.Result.UserID !== info.userId) {
    throw new Error(`续期返回的账号(${verify.data.Result.UserID})与当前账号(${info.userId})不一致，已放弃写回`);
  }

  // 按客户端 X9 结构重建令牌信息（account 保持原值，属同一账号的展示信息）
  const nowMs = Date.now();
  const expireAtMs = Number(r.TokenExpireAt);
  const expireDur = Number(r.TokenExpireDuration);
  const expiredAt = (Number.isFinite(expireAtMs) && nowMs > expireAtMs && Number.isFinite(expireDur))
    ? new Date(nowMs + expireDur).toISOString()
    : Number.isFinite(expireAtMs) ? new Date(expireAtMs).toISOString()
    : new Date(nowMs + 7 * 86400000).toISOString(); // 字段缺失时的保守兜底
  const refreshExpMs = Date.parse(r.RefreshExpireAt);
  const refreshExpiredAt = Number.isFinite(refreshExpMs)
    ? new Date(refreshExpMs).toISOString()
    : new Date(nowMs + 30 * 86400000).toISOString();
  const newInfo = {
    token: r.Token,
    refreshToken: r.RefreshToken,
    expiredAt,
    refreshExpiredAt,
    tokenReleaseAt: new Date().toISOString(),
    userId: info.userId,
    host: info.host,
    userRegion: info.userRegion,
    account: info.account,
  };

  // 备份后原子写回（保持 storage.json 的 4 空格缩进格式）
  const backupDir = path.join(BASE_DIR, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(storagePath, path.join(backupDir, `storage.json.${todayStr().replace(/-/g, '')}.${Date.now()}.bak`));
  const fresh = JSON.parse(fs.readFileSync(storagePath, 'utf8')); // 防御并发修改
  fresh['iCubeAuthInfo://icube.cloudide'] = traeEncryptBlob(JSON.stringify(newInfo), storage['iCubeAuthInfo://icube.cloudide']);
  fs.writeFileSync(storagePath, JSON.stringify(fresh, null, 4), 'utf8');

  // 写回后立即复核：能解密且令牌字段正确
  const reread = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  const check = JSON.parse(traeDecryptBlob(reread['iCubeAuthInfo://icube.cloudide']));
  if (check.token !== newInfo.token || check.refreshToken !== newInfo.refreshToken) {
    throw new Error('写回 storage.json 后复核失败，请从备份恢复: ' + backupDir);
  }
  log(['Trae 令牌自动续期成功，新有效期至 ' + expiredAt]);
  return newInfo;
}

async function checkinTrae() {
  const storagePath = path.join(APPDATA, 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json');
  const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  const blob = storage['iCubeAuthInfo://icube.cloudide'];
  if (!blob) throw new Error('未找到 Trae 登录信息，请先在 Trae Work CN 客户端登录');
  const info = JSON.parse(traeDecryptBlob(blob));
  if (!info.token) throw new Error('Trae 登录信息中缺少 token');
  const deviceId = extractTraeDeviceId(storage);

  // 令牌临近过期/已过期时自动续期（客户端未运行时），续期成功则使用新令牌
  if (!DRY_RUN) {
    try {
      const refreshed = await refreshTraeTokenIfNeeded(storagePath, storage, info, deviceId);
      if (refreshed) Object.assign(info, refreshed);
    } catch (err) {
      logCritical('Trae 令牌自动续期失败', String(err.message || err));
      log(['[警告] Trae 令牌自动续期失败: ' + (err.message || err)]);
    }
  }

  if (info.expiredAt && Date.now() > info.expiredAt) {
    throw new Error('Trae 令牌已过期且自动续期未成功，请打开 Trae Work CN 客户端刷新登录');
  }

  // 应用本体发送的 x-device-id 是 AHA 设备注册服务的数字设备 ID（纯数字），
  // 不是 telemetry.devDeviceId 的 UUID。发送错误/未注册的设备 ID 会被服务端风控软拒，
  // 返回业务码 9074「当前参与用户太多」（缺失则报 9004 订单参数错误）。

  const base = 'https://api.trae.cn';
  const headers = {
    'Content-Type': 'application/json',
    authorization: `Cloud-IDE-JWT ${info.token}`,
    ...(deviceId ? { 'x-device-id': deviceId } : {}),
    'x-device-type': 'Windows',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };

  const status = await httpJson(`${base}/trae/api/v2/ug/checkin_credits/status`, { method: 'POST', headers, body: {} });
  if (!status.data || typeof status.data !== 'object') {
    throw new Error('接口响应异常(非JSON)，请检查网络');
  }
  const st = status.data;
  if (st.code === 1001) {
    throw new Error('Trae 凭证已过期，请打开 TRAE Work 客户端重新登录一次');
  }
  if (st.code === 9074 || (st.message && /频繁/.test(st.message)) || (st.msg && /频繁/.test(st.msg))) {
    return '命中风控 9074（多为设备指纹校验未通过，请重启一次 TRAE 客户端后重试）';
  }
  if (st.code !== 0) {
    throw new Error(`查询签到状态失败: code=${st.code}, message=${st.message || st.msg || ''}`);
  }
  const stData = st.data || st;
  if (stData.enable === false) {
    return '签到功能未开放';
  }
  if (stData.checked_in) {
    const credits = stData.credits ?? stData.points ?? '?';
    const days = stData.continuous_days ?? stData.continuousDays ?? stData.streak ?? '?';
    const extras = [];
    if (credits !== '?') extras.push(`积分 ${credits}`);
    if (days !== '?') extras.push(`连签 ${days} 天`);
    return `今日已签到${extras.length ? `（${extras.join(' / ')}）` : ''}，无需重复领取`;
  }
  const DRY = DRY_RUN;
  if (DRY) return '尚未签到（dry-run，跳过领取）';

  // 领取命中服务端量控(9074)时，做有界间隔重试：9074 是瞬时并发/容量闸门，
  // 未必立刻解锁。采用递增间隔、限制次数，避免高频盲试触发更严风控；仍失败则留给次日。
  const retryDelays = [10, 15, 22, 30, 40, 55];
  let cl = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    const claim = await httpJson(`${base}/trae/api/v2/ug/checkin_credits/claim`, {
      method: 'POST', headers, body: {},
    });
    if (!claim.data || typeof claim.data !== 'object') {
      throw new Error('接口响应异常(非JSON)，请检查网络');
    }
    cl = claim.data;
    if (cl.code === 1001) {
      throw new Error('Trae 凭证已过期，请打开 TRAE Work 客户端重新登录一次');
    }
    const isThrottle =
      cl.code === 9074 ||
      (cl.message && /频繁/.test(cl.message)) ||
      (cl.msg && /频繁/.test(cl.msg));
    if (!isThrottle) break; // 非频控结果，跳出重试
    if (attempt < retryDelays.length) await sleep(retryDelays[attempt] * 1000);
  }
  if (cl.code === 9074 || (cl.message && /频繁/.test(cl.message)) || (cl.msg && /频繁/.test(cl.msg))) {
    return '命中风控 9074（设备指纹校验未通过；重启 TRAE 客户端可刷新设备注册），余下次日定时任务自动重试';
  }
  if (cl.code !== 0) {
    throw new Error(`签到失败: code=${cl.code}, message=${cl.message || cl.msg || ''}`);
  }
  const clData = cl.data || cl;
  // claim 响应通常只含 code/message，积分数取自先前 status 查询结果
  const credits = clData.credits ?? stData.credits ?? '?';
  return credits !== '?' ? `签到成功，积分 +${credits}` : '签到成功';
}

// ---------------- 签到编排 ----------------
const TASKS = [
  ['杜搭子(DuMate)', checkinDumate],
  ['WorkBuddy', checkinWorkbuddy],
  ['Trae Work CN', checkinTrae],
];

function parseOnly() {
  let only = '';
  const onlyEq = process.argv.find((a) => a.startsWith('--only='));
  if (onlyEq) {
    only = onlyEq.split('=')[1].toLowerCase();
  } else {
    const onlyIdx = process.argv.indexOf('--only');
    if (onlyIdx >= 0 && process.argv[onlyIdx + 1]) only = process.argv[onlyIdx + 1].toLowerCase();
  }
  return only;
}

function filterTasks() {
  const only = parseOnly();
  if (!only) return TASKS;
  const filtered = TASKS.filter(([name]) => name.toLowerCase().includes(only));
  return filtered;
}

// 执行一轮签到，返回结果数组
async function runRound() {
  const tasks = filterTasks();
  if (tasks.length === 0) {
    log([`未找到匹配 --only=${parseOnly()} 的产品`]);
    return [];
  }
  const results = [];
  for (const [name, fn] of tasks) {
    try {
      // 每个产品之间加随机 2~8 秒间隔，避免整齐划一的请求特征
      await sleep(2000 + Math.floor(Math.random() * 6000));
      const msg = await withLock(name, fn);
      results.push({ name, ok: true, msg });
    } catch (err) {
      const msg = err.message || String(err);
      results.push({ name, ok: false, msg });
      // 凭证失效/登录态失效/频控均可间歇发生，写入 CRITICAL 以便人工关注
      if (/(过期|失效|频控|重新登录|强制退出|未登录)/.test(msg)) {
        logCritical(name, msg);
      }
    }
  }
  return results;
}

function summarize(results) {
  if (results.length === 0) return;
  // 落盘状态：记录最后一次全天执行的状态，便于外部/后续轮次感知
  const state = readState();
  const successCount = results.filter((r) => r.ok).length;
  state.lastRun = {
    when: tsOf(),
    date: todayStr(),
    mode: DRY_RUN ? 'dry-run' : 'real',
    success: successCount,
    total: results.length,
    detail: results.map((r) => ({ name: r.name, ok: r.ok, msg: r.msg })),
  };
  writeState(state);

  log(results.map((r) => `${r.ok ? '[成功]' : '[失败]'} ${r.name}: ${r.msg}`));
  log([`本轮汇总: ${successCount}/${results.length} 成功${DRY_RUN ? '（dry-run 模式）' : ''}`]);
}

// 守护循环：常驻后台，按多个签到时间点自动签到
async function daemonLoop() {
  log([`守护模式已启动，每天在 [${CHECKIN_TIMES.join(', ')}] 自动签到。可用 Ctrl+C 退出。`]);
  // 启动时先跑一轮（幂等：若今天已签到会自动跳过），之后按时间点触发
  const results = await runRound();
  summarize(results);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let ms;
    try {
      ms = msUntilNextCheckin(CHECKIN_TIMES);
    } catch (err) {
      log([`配置错误: ${err.message}，30 分钟后重试`]);
      await sleep(30 * 60 * 1000);
      continue;
    }
    log([`距下次签到约 ${hhmmOf(ms)}，睡等待中…`]);
    await sleep(ms);

    // 醒来后（可能因休眠跨时间点）直接执行一轮
    const roundResults = await runRound();
    summarize(roundResults);
    // 若恰好跨过一天边界，则本次执行已覆盖"今天"，sleep 会在下一轮重新计算
  }
}

// 单次执行：跑一轮然后按结果退出码返回
async function onceRound() {
  const results = await runRound();
  summarize(results);
  if (results.length > 0 && results.every((r) => !r.ok)) return 1; // 全部失败
  return 0;
}

// ---------------- 入口 ----------------
(async () => {
  ensureDirs();
  try {
    if (LOOP) {
      await daemonLoop();
    } else {
      const code = await onceRound();
      process.exit(code);
    }
  } catch (err) {
    log([`运行时错误: ${err.message || String(err)}`]);
    logCritical('运行时错误', err.message || String(err));
    process.exit(1);
  }
})();