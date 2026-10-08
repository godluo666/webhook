# Webhook Radar

支持多用户的通知与监控工作台。每个账户独立管理 Webhook、AI 设置、监控规则、自动下单、活动记录和排查日志。概览、智能创建、任务与提醒、快速发送、通知渠道、AI 设置、读取设置、活动与日志、账户安全分别占用独立页面；左侧导航可折叠，手机上可横向滑动切换。页面地址中的锚点可直达相应功能，浏览器前进后退也会切换页面。Docker 镜像包含所需依赖及监控浏览器。

## Docker Compose 部署

安装 Docker 后，在服务器运行一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/godluo666/webhook/main/install.sh | bash
```

安装脚本会检查 Docker 和 Compose，先尝试拉取 GHCR 中最新的预构建镜像并更新容器；若镜像不可拉取，就从公开仓库自动构建。脚本会临时取得 Compose 配置并在结束时删除，不会遇到远程 Compose 配置的交互确认；无需手动下载文件或执行 `git clone`。**以后升级时重新运行同一条命令即可**，数据卷不会删除。只想从源码构建时，可直接执行：

```bash
docker compose -p webhook-radar -f https://github.com/godluo666/webhook.git#main:compose.build.yaml up -d --build --wait --wait-timeout 90
```

默认仅服务器本机可打开 <http://127.0.0.1:3000>。需要从其他设备访问时，明确开放 3000 端口并重建容器：

```bash
curl -fsSL https://raw.githubusercontent.com/godluo666/webhook/main/install.sh | env RADAR_BIND=0.0.0.0 bash
```

然后打开 `http://服务器IP:3000`。若仍无法连接，请检查服务器防火墙和云平台安全组是否放行 TCP 3000。数据保存在 Docker 命名卷中，重建后仍会保留；更新时再次运行所选的命令即可。对外开放注册时建议设置 `SIGNUP_CODE`。

仓库中的 `compose.yaml` 使用预构建的 GHCR 镜像。镜像包公开后，或服务器已经登录 GHCR 时，可以直接用 Compose 拉取并升级：

```bash
docker compose -p webhook-radar -f https://github.com/godluo666/webhook.git up -d --pull always --wait --wait-timeout 90
```

GitHub 仓库公开与 GHCR 镜像包公开是两项独立设置。镜像包仍为私有时，直接拉取镜像需要先登录有权限的 GitHub 账户；一键脚本会自动改用本机构建。升级时沿用原来的 `RADAR_BIND`、`RADAR_PORT` 等环境变量，以保持访问地址不变。

## 在 1Panel 中更新镜像

镜像地址固定为 `ghcr.io/godluo666/webhook:latest`。`main` 分支每次构建成功都会更新这个标签。1Panel 要从 GHCR 拉取，镜像包必须允许服务器访问：到 GitHub 账户的 **Packages → webhook → Package settings → Change visibility**，设为 **Public**。仅将代码仓库设为公开不会改变镜像包的可见性。公开后先在服务器验证：

```bash
docker pull ghcr.io/godluo666/webhook:latest
```

之前一键安装若回退到 `webhook-radar:local`，请再运行一次上面的一键命令，让现有容器改用 GHCR 镜像；数据仍在 `webhook-radar_radar_data` 卷中。之后在 1Panel 的**容器列表**选中 `webhook-radar` 对应的容器，使用容器的**升级／更新镜像**操作，拉取 `latest` 并重建容器。只在**镜像列表**点“拉取”不会更新已经运行的容器。若要由 1Panel 管理整个编排，可以将仓库的 `compose.yaml` 粘贴到 1Panel 新建编排的编辑器中；请在编排变量中设置 `RADAR_BIND=0.0.0.0`，沿用相同的数据卷，先停止旧容器以免 3000 端口冲突。

## 自动下单验证

生成阶段遇到认证失败时，任务保持 `needs_validation`，不会启用或提交订单；恢复认证后需重新验证。AI 仅返回缺货且没有可用 SOP 时，保留准备线索并进入 `waiting_stock`，不重复请求同一份 AI 计划；已有或同时返回的 SOP 仍可探索可访问阶段。缺货不跳过两次试跑和审批，其他可修复的生成或试跑错误仍按有界次数恢复。

## 启动

需要 Node.js 20.18.1 或更新版本，建议使用 Node.js 24。

```bash
npm ci --ignore-scripts
node server.js
```

打开 <http://127.0.0.1:3000>，注册账户后使用。`PORT` 可设置端口，`HOST` 可设置监听地址；默认只监听本机。进程需要持续运行，监控任务才会按间隔检查。设置和数据保存在 `.data/state.json`。

直接运行 Node 时，`.env` 不会自动加载。若把邮件参数写入 `.env`，请使用 `node --env-file=.env server.js` 启动；Docker Compose 则会读取同目录的 `.env`。

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `DATA_DIR` | 数据目录，默认项目内 `.data` |
| `SIGNUP_CODE` | 设置后，新用户注册必须填写此邀请码 |
| `COOKIE_SECURE=1` | 经 HTTPS 访问时，为登录 Cookie 加上 Secure 标志 |
| `RESEND_API_KEY` | 邮箱验证码发信服务的 API Key |
| `MAIL_FROM` | 发件地址，须属于已在 Resend 验证的域名 |
| `HTTP_PROXY` / `HTTPS_PROXY` | Node.js 24.14+ 会自动使用代理，并跳过本地地址；较旧版本请通过运行环境配置网络 |
| `ORDER_AI_TIMEOUT_MS` | 单次下单 AI 请求等待时间，默认 120000（2 分钟），超时最多重试 1 次 |
| `ORDER_AGENT_TIMEOUT_MS` | 每轮动态探索预算，默认 600000（10 分钟） |
| `ORDER_TRIAL_TIMEOUT_MS` | 生成 SOP 与两次试跑的总预算，默认 1500000（25 分钟） |
| `MONITOR_BROWSER_EXECUTABLE` | 直接运行 Node 时指定 Chrome / Chromium 可执行文件，Docker 已内置 |
| `MONITOR_BROWSER_ENABLED=0` | 关闭浏览器读取，默认启用 |
| `MONITOR_TEMP_DIR` | 可选私有临时目录；新版 Docker 的浏览器和代理临时文件使用 /tmp，Compose 挂载有容量上限的 tmpfs |
| `MONITOR_SS_EXECUTABLE` | 直接运行 Node 时指定 shadowsocks-rust 的 `sslocal` 可执行文件，需支持 HTTP 本地代理；Docker 已内置，无需额外配置 |
| `MONITOR_PROXY_TEST_URL` | 可选的代理出网检测地址，应返回 JSON `{ "ip": "出口IP" }`、纯 IP 或 Cloudflare trace；不配置时使用内置检测服务及备用服务 |
| `MONITOR_BROWSER_HEADLESS=1` | Linux 上使用无界面浏览器，默认在 Xvfb 中运行 |
| `MONITOR_LOG_ROOT` | 可选的日志目录根路径；每个账户只读取其中以自身账户 ID 命名的子目录。默认 `.data/monitor-logs` |

只加载 `users` 中的多用户数据；旧版未认领工作区和认领码已移除。现有账户名下的监控和 Webhook 会保留。

邮箱验证码通过 [Resend 邮件 API](https://resend.com/docs/send-with-nodejs) 发送，不需要自建邮局。先在 Resend 验证发件域名，设置 `RESEND_API_KEY` 和 `MAIL_FROM`，例如 `Webhook Radar <notify@example.com>`。两项均配置后，新账户注册必须填写邮箱、接收 6 位验证码并在 10 分钟内验证；已登录用户绑定或更换邮箱也需要当前密码和发往新邮箱的验证码。验证码每 60 秒最多重发一次，每个邮箱每小时最多 5 次，输入错误达到 5 次后失效。服务重启后未使用的验证码失效。

未配置邮件服务时，用户仍可用用户名和密码注册，但不能绑定未经验证的邮箱；页面会明确显示邮件服务尚未启用。注册后会显示一次恢复码，请妥善保存。忘记密码时，用用户名和恢复码设置新密码；恢复成功后恢复码会换新。已登录用户可以修改密码或凭当前密码重新生成恢复码。

多代理选择、自动下单与付款、资源释放和负载诊断的配置及升级说明见 [功能与升级说明](docs/order-proxy-resources.md)。
