# Webhook Radar

支持多用户的通知与监控工作台。每个账户独立管理 Webhook、AI 设置、监控规则、活动记录和排查日志。无需安装第三方 Node 依赖。

## Docker Compose 部署

安装 Docker 后，在服务器运行一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/godluo666/webhook/main/install.sh | bash
```

安装脚本会检查 Docker 和 Compose，先尝试拉取 GHCR 中最新的预构建镜像并更新容器；若镜像不可拉取，就从公开仓库自动构建。无需手动下载文件或执行 `git clone`。**以后升级时重新运行同一条命令即可**，数据卷不会删除。只想从源码构建时，可直接执行：

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

## 启动

需要 Node.js 20 或更新版本，建议使用 Node.js 24。

```bash
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
| `MONITOR_LOG_ROOT` | 可选的日志目录根路径；每个账户只读取其中以自身账户 ID 命名的子目录。默认 `.data/monitor-logs` |

只加载 `users` 中的多用户数据；旧版未认领工作区和认领码已移除。现有账户名下的监控和 Webhook 会保留。

邮箱验证码通过 [Resend 邮件 API](https://resend.com/docs/send-with-nodejs) 发送，不需要自建邮局。先在 Resend 验证发件域名，设置 `RESEND_API_KEY` 和 `MAIL_FROM`，例如 `Webhook Radar <notify@example.com>`。两项均配置后，新账户注册必须填写邮箱、接收 6 位验证码并在 10 分钟内验证；已登录用户绑定或更换邮箱也需要当前密码和发往新邮箱的验证码。验证码每 60 秒最多重发一次，每个邮箱每小时最多 5 次，输入错误达到 5 次后失效。服务重启后未使用的验证码失效。

未配置邮件服务时，用户仍可用用户名和密码注册，但不能绑定未经验证的邮箱；页面会明确显示邮件服务尚未启用。注册后会显示一次恢复码，请妥善保存。忘记密码时，用用户名和恢复码设置新密码；恢复成功后恢复码会换新。已登录用户可以修改密码或凭当前密码重新生成恢复码。

## 通知渠道

添加多个 Webhook 地址，逐个测试、停用或删除。支持 Slack、Discord、企业微信、飞书、钉钉和 ntfy，也可以使用通用 JSON Webhook。ntfy.sh 地址可自动识别；自建 ntfy 请手动选择 `ntfy` 格式。每个 ntfy 渠道可设置默认优先级 1–5；手动通知和监控规则可以单独覆盖，留空时使用渠道默认值。优先级仅用于 ntfy。

手动通知和每条监控任务都可以选择接收渠道。部分渠道发送失败时，手动发送会自动选中失败渠道以便重试；监控任务会在下次检查只重试失败渠道。

## 监控来源

在“智能监控”里写清来源和触发条件，点击生成后，AI 才为本次请求生成专用逻辑。来源可以是 HTTP 地址、`tcp://主机:端口` 或 `log:相对路径`。检查预览中的来源、筛选条件和首次通知方式，再确认创建。生成的逻辑可在预览和任务编辑页查看、修改。已有账户名下的任务继续运行。

“立即检查”会马上检查来源。对“当前有货”“页面包含文字”“服务不可用”等状态条件，手动检查时只要条件满足就再次发送；定时检查只在条件从不满足变为满足时发送。对补货、字段变化、新条目和新增日志等变化条件，仍须出现真实的新变化才会通知。

如果网址后面紧跟中文指令，请把网址填入独立的“监控来源地址”输入框，指令框只写监控条件。地址含中文路径时也建议这样填写。预览会显示完整来源 URL；对含糊的地址解析会给出提示。

| 来源 | 指令要点 | 触发方式 |
| --- | --- | --- |
| 网页文字 | 地址和引号内的关键词 | 文字出现或消失 |
| JSON API | 地址、字段路径和比较值 | 条件满足、字段变化或条目状态变化 |
| RSS/Atom | 订阅源地址，可加标题关键词 | 出现匹配的新条目 |
| GitHub Release | 公开仓库的 GitHub 地址 | 最新 Release 的版本号改变 |
| DMIT | “监控 DMIT 补货”或“DMIT 任意有货时通知” | 前者监控状态变化，后者首次有货立即通知 |
| HTTP/TCP 服务 | 健康检查 URL 或 `tcp://127.0.0.1:端口` | 不可用、恢复可用、响应超过阈值 |
| 本地日志文件 | 账户日志目录内的 `log:app.log` 等相对路径 | 新增行包含指定文字 |

日志监控只读取当前账户的日志目录，页面会显示该目录的实际路径。将要监控的文件放在目录内，再填写 `log:文件名`。默认首次检查只记录文件末尾位置，之后仅检查新增行；明确要求检查现有日志时，可在 AI 生成的规则中使用 `initial: "notify"`。单次读取最多 1 MB，文件轮转或截断后会从新文件的末尾部分继续。Docker 内的 `localhost` 指容器本身；要监控宿主机服务或日志，需在部署时提供可访问的地址或将日志挂载到对应账户目录。

DMIT 全量库存使用[第三方公开数据](https://vps.thairath.eu.org/)，购买前请以 [DMIT 官方页面](https://www.dmit.io/pages/pricing)为准。普通网页仅读取服务端返回的 HTML 文本，不执行页面 JavaScript；如果目标网站拒绝自动访问，或内容在浏览器中动态加载，请选择可直接访问的 JSON API、RSS 等来源。

## 按需生成监控逻辑

应用没有内置模型或 API Key。自然语言生成需要在当前账户中配置 **OpenAI 兼容 Chat Completions API**；默认基础地址为 `https://api.openai.com/v1`，请求发往 `/chat/completions`。点击“测试 API 连接”会用当前填写或已保存的 Key 发送最小请求，并显示连接结果；点击“生成监控规则”才会为当前指令调用 AI 生成规则。没有配置 Key 或模型时会明确提示。设置区显示已保存 Key 的掩码；登录后可主动显示完整 Key。

AI 为本次指令生成一份声明式监控逻辑，包含来源、取值路径、筛选条件、状态变化方式以及首次检查行为。服务端校验并执行这份逻辑，不执行 AI 返回的任意 JavaScript。对于 DMIT，“任意有货”会生成首次满足即通知的条件；“补货”会生成从缺货到有货的逐项状态变化条件。AI 输出若与明确指令冲突，服务端会拒绝创建。

除内置的 DMIT 来源信息和由用户提供的 GitHub 仓库地址可换算出的公开 Release API 外，请在指令中提供来源 URL。应用目前不能自行搜索网站或访问需要浏览器登录的内容。API Key 默认只显示掩码；登录用户可主动显示完整 Key。Key 保存在服务端数据文件中，应限制该文件的访问权限。

## Docker

项目包含 `Dockerfile`、`compose.yaml` 和 `.dockerignore`。默认 Compose 文件直接使用已发布镜像；在含有 `compose.yaml` 的目录运行：

```bash
docker compose up -d
```

默认只发布到宿主机的 `127.0.0.1:3000`，数据保存在 Compose 命名卷 `radar_data`。可复制 `.env.example` 为 `.env` 来设置监听地址、端口、注册邀请码、邮件服务和数据位置；需要从其他设备访问时将 `RADAR_BIND` 设置为 `0.0.0.0`。如需复用当前项目的 `.data/state.json`，设置 `RADAR_DATA_VOLUME=./.data` 后再运行 Compose。Compose 以非 root 用户运行应用，只读挂载容器根文件系统，并将数据目录挂载为可写卷。

要监控宿主机 HTTP/TCP 服务，可将来源写成 `http://host.docker.internal:端口/health` 或 `tcp://host.docker.internal:端口`。Compose 已添加宿主机网关映射；目标服务也必须监听容器可访问的地址。容器内的 `127.0.0.1` 只能访问容器自身。

若使用 `release/webhook-radar-docker-1.0.0.tar.gz` 部署包，在目标机器解压后进入解压目录，可复制 `.env.example` 为 `.env`，再执行上面的 `docker compose up -d`。部署包包含构建上下文，不包含账户数据或 API Key。需要自己构建镜像时，可以运行 `docker build -t webhook-radar:local .`，并把 `compose.yaml` 的 `image` 改为 `webhook-radar:local`。

上传到 GitHub 后，`main` 分支的 “Build and publish container” 工作流会先运行测试，再构建并推送 `ghcr.io/godluo666/webhook:latest`。也可以手动运行该工作流。仓库需要允许 Actions 写入 Packages；镜像发布成功后可从 GHCR 拉取部署。

## 日志与排查

“最近活动”下的日志记录每次 AI 连接测试、规则解析、来源检查和 Webhook 发送的结果、耗时、HTTP 状态和具体错误。新解析日志可展开查看原始指令、发送给 AI 的请求体、AI 回复、地址校验结果；检查失败日志记录网络错误码和响应内容。API Key 会从这些日志中隐藏。每个账户只能查看自己的日志；完整日志可通过登录后的 `/api/logs` 读取，最多保留最近 300 条。旧日志没有保存原始 AI 回复，无法追溯补回。

`fetch failed` 一般表示服务端无法建立网络连接。服务会展示底层错误码，例如连接超时；若连接成功但站点拒绝请求，会显示 HTTP 403 等状态。浏览器能打开页面不代表服务端能抓取同一内容。

## 测试

```bash
node --test
```
