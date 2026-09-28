# daily-auto-checkin

Windows 每日自动签到：**杜搭子(DuMate) / WorkBuddy / Trae Work CN** 三合一，开机即自动领取每日积分。

一次安装，之后无需任何手动操作——每天开机（或定时）自动完成三款产品的签到领积分。

## 功能特性

- **三平台自动签到**：杜搭子(DuMate)、WorkBuddy、TRAE SOLO CN（Trae Work CN）
- **开机自动执行**：注册 Windows 计划任务，登录后 30 秒自动签到 + 每日定时双保险，错过时间点自动补签
- **全程无弹窗**：计划任务通过无窗口启动器（wscript）在后台静默运行，触发时不弹出任何窗口
- **Trae 令牌自动续期**：令牌临近过期时自动调用官方续期接口，无需每周打开客户端保活
- **零依赖**：纯 Node.js 内置模块，无任何第三方 npm 包
- **凭据不出本机**：所有登录凭据从各客户端本地存储实时读取，脚本不保存、不上传任何令牌
- **幂等安全**：已签到自动跳过，重复运行不会重复领取；产品间互不影响

## 前置要求

| 依赖 | 说明 |
|------|------|
| Windows 10/11 | 计划任务安装方式为 Windows 专属 |
| Node.js ≥ 18 | 需要 fetch API，[下载地址](https://nodejs.org/) |
| 三款客户端已登录 | 只需在各自客户端中登录过一次即可 |

支持的产品：

| 产品 | 签到奖励 |
|------|---------|
| [杜搭子 DuMate](https://yumenzhushou.baidu.com/) | 每日 +500 积分 |
| WorkBuddy（腾讯） | 每日 +100 积分 |
| TRAE SOLO CN | 每日 +150 积分 |

## 快速开始

```powershell
git clone https://github.com/Wang-JQ77/daily-auto-checkin.git
cd daily-auto-checkin
.\install-task.ps1 -RunNow
```

安装脚本会：
1. 检查 Node.js 环境
2. 将签到脚本部署到 `~\.daily-checkin\`
3. 注册计划任务 `DailyCheckin`（每天 09:30 + 每次登录后 30 秒触发）
4. `-RunNow` 参数会立即执行一轮签到验证

> 如果 PowerShell 提示脚本执行策略限制，请使用：
> `powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -RunNow`

也可在 [Release 页面](https://github.com/Wang-JQ77/daily-auto-checkin/releases) 下载 ZIP 解压后运行，无需 git。

## 手动运行

```powershell
node daily-checkin.js --once              # 执行一轮签到后退出
node daily-checkin.js --once --dry-run    # 只查询状态，不领取
node daily-checkin.js --once --only=trae  # 只签 Trae（可选 dumate / workbuddy）
node daily-checkin.js                     # 守护模式：常驻后台每天自动签到
```

### 命令行参数

| 参数 | 说明 |
|------|------|
| `--once` | 单次执行一轮后退出（计划任务使用此模式） |
| `--dry-run` | 只查询签到状态，不实际领取 |
| `--only=<name>` | 只处理名称匹配的产品：`trae` / `dumate` / `workbuddy` |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CHECKIN_TIME` | `09:30` | 每日签到时间（守护模式） |
| `CHECKIN_TIMES` | 同 `CHECKIN_TIME` | 多时间点，逗号分隔，如 `00:05,09:30,18:00` |
| `CHECKIN_BASE_DIR` | `~/.daily-checkin` | 状态/日志目录 |

## 工作原理

脚本**不保存任何密码或令牌**，全部从各客户端的本地加密存储实时解密读取：

| 产品 | 凭据来源 |
|------|---------|
| 杜搭子 | `%APPDATA%\qianfan-desktop-app`（AES-256-GCM 加密 cookie） |
| WorkBuddy | `%LOCALAPPDATA%\CodeBuddyExtension` 会话文件 |
| Trae Work CN | `%APPDATA%\TRAE SOLO CN` storage.json（AES 加密凭据） |

**Trae 令牌自动续期**：Trae 的访问令牌约 8 天过期。脚本在令牌剩余不足 24 小时时，使用客户端设备密钥对（P-256 签名）调用官方 `ExchangeToken` 接口自动续期，并把新令牌按原加密格式写回 storage.json——客户端与脚本共用同一份凭据。续期前会自动备份原文件到 `~\.daily-checkin\backups\`。

## 常见问题

**Q: 计划任务触发时会弹出黑色窗口吗？**
不会。任务通过 `wscript.exe + hidden-run.vbs` 无窗口启动器运行，node 在完全隐藏的后台执行，桌面不会出现任何弹窗；运行结果请查看日志文件。

**Q: 提示「命中风控 9074」？**
Trae 服务端的设备指纹校验未通过，重启一次 TRAE 客户端即可恢复，脚本次日也会自动重试。

**Q: 提示「凭证已过期，请重新登录」？**
长时间未打开对应客户端，登录态已失效。打开客户端重新登录一次即可恢复。

**Q: 某个产品签到失败会影响其他产品吗？**
不会。三个产品相互独立，单个失败只记录日志，不影响其余产品。

**Q: 电脑没开机错过了签到时间？**
计划任务设置了「错过后尽快补跑」，开机后自动补签；且签到以自然日为准，当天任何时间补签都有效。

**Q: 如何确认签到是否成功？**
查看日志：`Get-Content ~\.daily-checkin\logs\checkin-*.log -Tail 20`，或直接在各产品客户端查看积分记录。

## 卸载

```powershell
.\uninstall-task.ps1                # 删除计划任务，保留数据
.\uninstall-task.ps1 -RemoveData    # 删除计划任务 + 数据目录
```

## 免责声明

本项目仅供个人学习与研究，用于自动化管理**本人账号**的每日签到。请自行评估并遵守各平台的用户协议；使用本脚本产生的一切后果由使用者自行承担。

## License

MIT
