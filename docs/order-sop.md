# 自动下单 SOP 与维护

新生成的下单配置统一使用 `workflow.version = 1`。网站差异集中在商品准备和账单定位函数；登录恢复、两次试跑、价格核对、提交、付款及结果判断由程序执行。

## 固定流程

| 阶段 | 执行者 | 完成依据与停止条件 |
| --- | --- | --- |
| 恢复登录 | `order-browser.js` | 新浏览器恢复私有状态并核实真实登录证据；后台写入被拦截，不能代替登录证据。 |
| 准备商品 | AI `prepareCode` | 根据实际页面设置商品、规格、数量、周期与付款意图；明确返回 `ready: true`。 |
| 核对订单 | 宿主 `submit` | 唯一控件、商品、数量、含税费总价、三位币种、预选付款方式与 AFF 全部符合用户配置。 |
| 提交一次 | 宿主 `submit` | 提交前持久化记录，许可绑定真实 POST；等待实际请求及完整页面跳转后核对订单结果。 |
| 定位账单 | AI `paymentCode` | 只能读取原订单页面，返回关联账单链接或付款核对字段。 |
| 打开原账单 | 宿主 `invoice` | 唯一关联的同源账单；核对本次订单号，不能跳到另一订单。 |
| 付款一次 | 宿主 `pay` | 核对账单号、总价、币种、付款方式、可用余额和实际 POST 字段，付款前持久化记录。 |
| 判定结果 | 宿主 | 真实成功证据才标为已付款；余额不足、无法核实余额、扫码或二次验证保留原待付款账单。 |

两次试跑复用同一登录与购物车，要求商品、数量、总价、币种和付款意图一致。试跑在提交前结束，不创建订单，也不运行账单定位或付款。正常监控触发使用已生成并验证的流程，不等待 AI。

## 登录与后台请求

登录窗口、只读会话恢复和账户核验期间，网页后台发起的未获许可请求先中止，包括订单和付款地址。商品准备阶段在没有受控写入动作时也按此处理，覆盖登录核验结束后才触发的后台定时请求。后台请求被拦截不等于会话失效；保存与试跑必须另外核实真实登录标记，标记缺失时仍拒绝保存。主页面直接访问交易地址、AI 准备阶段发起未许可交易、将最终提交伪装成购物车操作仍会停止。提交和付款继续绑定唯一实际 POST，不重试。

请求分类统一在 `lib/order-request.js`：只检查真实路径和顶层 `a/action` 参数，不扫描登录地址中嵌套的返回网址。拦截记录包含阶段、方法和脱敏路径，不记录 Cookie、请求体或令牌。排查登录保存和生成失败时先判断是否存在真实登录证据，再查看这一记录，不放宽交易许可。

## AI 输出契约

```js
{
  summary: "根据实际页面配置商品并核对订单",
  workflow: {
    version: 1,
    prepareCode: "function(order,browser){ /* 实际网站配置 */ return {ready:true}; }",
    paymentCode: "function(order,browser){ /* 实际账单定位 */ return {checks:{ /* 核对选择器 */ }}; }"
  },
  checkout: {
    submitSelector: "实际提交按钮",
    productSelector: "实际订单商品",
    quantitySelector: "实际数量",
    totalSelector: "实际含税费总价",
    currencySelector: "实际三位币种",
    confirmationSelector: "新订单成功信息"
  }
}
```

`prepareCode` 只能使用 `goto/snapshot/exists/text/fill/select/check/uncheck/click/cart/wait/choosePayment`。通用 `click` 不能提交表单或点击下单、付款按钮；商品配置表单使用受控 `cart`。准备函数可返回 `{ready:true, checkout:{...}}`，提供本次页面的六个唯一核对选择器，适应随机 ID。未找到明确商品或必要选项时返回 `{error:"具体原因"}`。

`paymentCode` 只允许 `snapshot/exists/text/wait`，不能提交、填写或支付。若当前页有原订单的唯一账单链接，返回 `{invoiceLinkSelector:"实际链接选择器"}`；宿主打开后再次调用该函数。进入账单页后返回 `{checks:{paySelector,invoiceSelector,totalSelector,currencySelector,confirmationSelector,...}}`。可附带余额、余额币种、预选付款方式及扫码验证提示选择器。当前订单收据通过 `order.receipt` 提供。付款定位必须依据实际 DOM，不能猜测未来随机 ID。

两个函数共享 60 秒、80 次操作预算；在隔离的 QuickJS 中运行，无网络、文件或任意页面脚本权限。`code` 是宿主生成的完整流程展示，实际执行通过分阶段接口。新生成必须遵守 SOP；已经保存的旧配置仍兼容执行，重新生成时升级到版本 1。

## 失败处理

提交前的页面结构变化可重新生成并再次连续试跑。确认创建原订单后、首次付款之前，允许一次 AI 账单定位辅助，权限仍只读。付款已经发出、请求要求重发 POST、结果不明或程序重启时，不自动重复下单或付款；保留收据与记录供核对。

外部收银台地址只接受本次受控付款响应的真实跳转；不访问外部收银台，不把待扫码标为已付款。浏览器启动或 Cookie 恢复的重建属于只读恢复，不属于交易重试。跳转期间被打断的页面读取可重读，点击和财务动作不重试。

## 维护入口与验证

- `lib/order-workflow.js`：SOP 版本、AI 输出校验、阶段权限、共用预算和提示词。
- `lib/order-browser.js` / `lib/order-request.js`：实际 DOM 与请求核对、后台请求隔离、交易地址分类、一次请求许可、账单关联、跳转和付款结果。
- `lib/orders.js`：两次试跑、配置指纹、监控触发、持久化交易记录和有限结构修复。
- `lib/order-account.js` / `lib/browser-operation.js`：登录窗口闲置计时、保存期限、有界操作与取消。
- `lib/browser-proxy-auth.js`：区分代理与网站 HTTP 认证，代理凭据只回答 Proxy 挑战。
- `test/order-workflow.test.js` / `test/orders.test.js`：权限边界、流程顺序、原订单辅助和重复请求保护。
- `.github/orders-ui-smoke.mjs` / `.github/order-login-smoke.mjs`：真实 Chromium 与本地模拟商家联调，包括延迟提交、令牌轮换、页面变化、付款跳转、余额不足和请求被篡改。
- `.github/resource-smoke.mjs`：浏览器、代理租约、预览与临时目录释放。
- `.github/proxy-auth-smoke.mjs`：真实 HTTPS CONNECT 与 SS 隧道中的会话保存、两次付款模式试跑、延迟提交、单次付款、认证错误分类与凭据隔离。

维护时先修改对应网站差异契约或宿主核对逻辑，再运行对应单元测试与真实浏览器用例。CI 在只读 Linux 镜像中运行相同回归；本地联调不购买真实商品。测试通过能够验证程序行为，真实商家的库存、验证码、限流和网络仍可能导致首次下单失败。

## HTTPS 代理与付款拦截

认证与付款响应拦截必须使用同一个 CDP 会话、一次合并的 `Fetch.enable`：代理认证覆盖 Request 阶段，交易跳转核对覆盖 Response 阶段。单独启用仅 Response 的 Fetch 拦截会覆盖代理认证，即使 SS 节点有效、网页登录成功，也会在试跑访问 HTTPS 页面时出现 `net::ERR_INVALID_AUTH_CREDENTIALS`。

禁止将代理密码交给网站 HTTP 认证，禁止通过关闭代理认证或全局忽略证书解决导航失败。`PROXY_AUTH_FAILED` 与 `SITE_HTTP_AUTH_REQUIRED` 分别显示原因，停止试跑和 AI 重新生成，保留原网页登录会话。HTTPS 测试仅为本地公开测试证书的 SPKI 添加信任，生产证书验证不变。

## 执行日志

监控的“脚本与结果”中点击“查看执行日志”，可刷新、复制或下载 UTF-8 的 `.txt` 日志，直接提供给 AI 分析。日志只读，不会重新试跑、下单或付款。

每次登录打开、保存、验证、商品预览、代码生成与正式执行分别记录操作编号、时间、运行环境、配置版本、代码及其哈希、SOP 阶段、控件定位、耗时、请求许可与拦截、错误代码及调用位置、结果和财务动作起始记录。失败时附带页面地址和控件元数据，不保存输入值、完整页面正文、截图或请求/响应体。

日志归属当前用户和监控，经统一脱敏后持久化；不混入日常状态轮询。最近 20 次操作、单次 400 条事件且不超过 128 KiB，截断会显式标注；服务重启将未结束的日志标为中断，保留交易记录且不重试。旧配置可导出已有试跑和结果，尚未记录的过去操作不会补造。

维护入口：`lib/order-execution-log.js` 负责结构、脱敏、容量与导出；`orders.js` / `order-account.js` 记录生命周期；`order-browser.js` 提供请求事件与有界只读控件诊断；`public/order-execution-log-ui.js` 提供复制下载。
