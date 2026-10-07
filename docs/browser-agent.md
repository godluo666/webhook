# 通用浏览器下单 Agent

新界面的“探索网站并试跑”使用业务 SOP v2：目标 → 浏览器探索 → 页面理解 → 单步规划 → 执行与验证 → 恢复 → 经验保存。业务计划没有网站 DOM、CSS/XPath 或执行代码。旧 v1 任务保留兼容执行接口，重新探索时迁移到 v2。

## 模块及接入

| 文件 | 职责 |
| --- | --- |
| automation/browser/launcher.js | 复用现有 Chromium、代理、私有会话及请求许可。 |
| automation/browser/dom-parser.js | 获取脱敏 HTML、DOM 树、页面文本、表单、选项、可交互元素及可访问性语义。 |
| automation/browser/locator.js | 按 ARIA → 可见文本 → Label → Placeholder → Name → ID → CSS → XPath 解析当前元素；歧义时不选第一项。 |
| automation/browser/crawler.js | 探索实际购买流程，在最终提交前结束。 |
| automation/agent/model.js | 不包含定位信息的通用九步 Business SOP，以及配置要求和目标结构校验。 |
| automation/agent/planner.js | 根据当前页面和历史经验生成一个 JSON 动作；不生成网站专用 JavaScript。 |
| automation/agent/executor.js | 单步执行、重新观察、购物车核验、配置核验、受控优惠/提交/付款及操作预算。 |
| automation/agent/recovery.js | 同一浏览器内收集页面、截图、错误与历史，限定恢复范围。 |
| automation/agent/memory.js | 按用户、监控和完整 origin 隔离的原子 JSON 经验存储。 |
| automation/adapters/generic-commerce.js | 通用页面类型与新的订单/付款成功证据识别，不含网站专用模板。 |
| automation/logs/evidence.js | 保存脱敏页面 JSON 与输入遮挡截图，提供任务隔离读取及数量上限。 |
| lib/order-browser.js | 接入观察、动态定位与成功验证；保留请求许可、金额/币种/数量核验及原订单绑定。 |
| lib/orders.js | 接入业务 SOP、两次探索试跑、审批哈希、动态执行与经验学习。 |
| lib/order-workflow.js | 校验 v2 数据契约，并兼容旧 v1 代码 SOP。 |
| lib/order-execution-log.js | 记录语义动作、修复、证据 ID、审批、交易起始记录和订单编号。 |
| server.js | 初始化持久化存储并提供探索、profile 和页面证据 API。 |
| public/orders-ui.js | 展示业务 SOP、配置核验及探索结果；沿用用户确认启用节点。 |

部署镜像的 Dockerfile 已包含 automation 目录；.github/workflows/container.yml 新增容器内真实 Chromium、架构及 API 回归。

## 数据结构

业务计划由用户审阅后参与原审批哈希：

~~~json
{
  "summary": "探索商品购买流程并核对月付套餐",
  "workflow": {
    "version": 2,
    "businessSop": [
      {"id":"open","goal":"打开目标商品页面"},
      {"id":"identify","goal":"识别目标商品"},
      {"id":"purchase","goal":"进入购买流程"},
      {"id":"configure","goal":"配置商品参数和数量"},
      {"id":"coupon","goal":"应用并验证用户优惠信息"},
      {"id":"review","goal":"验证商品、配置、数量、总价和币种"},
      {"id":"checkout","goal":"进入结账流程"},
      {"id":"submit","goal":"经用户授权提交一次订单"},
      {"id":"verify","goal":"验证新订单及付款结果"}
    ],
    "requirements": [{"name":"付费周期","value":"月付"}]
  }
}
~~~

浏览器观察结构：

~~~json
{
  "observationId": "一次观察的 UUID",
  "url": "https://merchant.example/checkout",
  "title": "结账",
  "html": "脱敏 HTML，最多 64000 字符",
  "text": "可见页面文本，最多 24000 字符",
  "domTree": [{"node":"n0","tag":"main","parent":null,"elementRef":"e0"}],
  "elements": [{
    "ref":"e0","role":"button","accessibleName":"确认订单",
    "text":"确认订单","label":"","visible":true,
    "disabled":false,"options":[]
  }],
  "forms": [{"ref":"e1","method":"post","action":"/checkout","fields":["e0"]}],
  "network": [{"method":"GET","url":"https://merchant.example/checkout","status":200}]
}
~~~

一次动态计划只引用当前观察的元素：

~~~json
{
  "action": "review",
  "reason": "当前页面已提供全部核验字段",
  "bindings": {
    "submit": {"meaning":"submit_order","ref":"e0","confidence":0.95},
    "product": {"meaning":"product","ref":"e2","confidence":0.95},
    "quantity": {"meaning":"quantity","ref":"e3","confidence":0.95},
    "total": {"meaning":"total","ref":"e4","confidence":0.95},
    "currency": {"meaning":"currency","ref":"e5","confidence":0.95}
  },
  "configuration": [
    {"name":"付费周期","target":{"meaning":"billing_cycle","ref":"e6","confidence":0.95}}
  ]
}
~~~

临时 ref 与宿主生成的定位候选只在当前观察有效。每次动作后重新观察；网站记忆不保存 ref、selector、DOM、账号、Cookie 或实际字段值。ARIA 等候选必须唯一，并且必须对应同一个已观察节点；全部失败后重新观察，不能点击任意第一个匹配项。

动作包括 fill、select、check、uncheck、click、cart、choosePayment、verify_cart、apply_coupon、review、invoice、pay、stop。优惠请求之后专用 verify_coupon 只重新绑定实际核验元素，不能重复应用。cart 返回后必须核验真实商品和数量；review 核验真实选中配置；优惠应用验证码、实际减免及总价降低，并在页面跳转/ID 变化后重新绑定。最终提交不需要提前知道成功页 DOM。

经验文件保存在 DATA_DIR/automation/profiles/<用户与监控哈希>/<origin哈希>.json，例如：

~~~json
{
  "schemaVersion": 1,
  "origin": "https://merchant.example",
  "platformType": "generic-commerce",
  "pageTypes": ["product_or_other","cart","checkout","order_result","invoice"],
  "elementSemantics": ["add_to_cart","quantity","submit_order","invoice","pay"],
  "successPaths": [{"status":"ordered","steps":[{"pageType":"checkout","action":"review","meanings":["submit_order"],"verified":true}]}],
  "failurePaths": [{"status":"recovery","errorCode":"AGENT_ELEMENT_MISSING","steps":[]}],
  "outcomes": {"prepared":2,"ordered":1}
}
~~~

经验先读取再规划，失败时重新观察并更新。探索由宿主 dryRun 会话保证不提交，同时保留付款意图供提交前核验。探索只记录实际访问并验证的路径，不虚构尚未打开的成功页、账单或付款页。实际成功交易之后补充这些阶段的经验。

截图及页面证据保存在 DATA_DIR/automation/logs/<用户与任务哈希>/<证据UUID>.json/.png，默认每任务保留 40 份。JSON 含实际 URL、HTML/DOM、网络状态与阶段；输入框、textarea、可编辑区域及 data-private 内容在截图中遮挡。恢复时可向支持图像输入的模型发送截图；模型不支持图像时会如实报错，不重复交易。

## HTTP API

所有接口沿用当前登录鉴权及任务所属用户检查。

| 请求 | 用途 |
| --- | --- |
| POST /api/order-tasks | 创建任务。输入 url、instruction（任务目标）、monitorId、quantity、maxTotal、currency 和 executionMode；登录会话仍需提前保存。 |
| POST /api/order-tasks/:id/discover | 探索实际购买流程，并连续试跑两次。返回 task，状态 ready、enabled=false。 |
| POST /api/order-tasks/:id/generate | 保留旧客户端入口，使用新的业务规划提示词。 |
| GET /api/order-tasks/:id/profile | 读取当前网站在该用户/监控下的经验，未有记录时 profile=null。 |
| POST /api/order-tasks/:id/enable | 用户审阅实际核验结果及业务计划后传入 {codeHash: task.trial.codeHash}；金额、要求、账户或任务变化会撤销授权。 |
| POST /api/order-tasks/:id/run | 执行已授权任务。每次观察即时规划，原订单提交与付款各最多一次。 |
| POST /api/order-tasks/:id/pause | 取消规划/浏览器执行。 |
| GET /api/order-tasks/:id/evidence/:evidenceId | 读取脱敏页面证据 JSON。 |
| GET /api/order-tasks/:id/evidence/:evidenceId.png | 读取截图；过期或不属于当前用户任务的证据返回 404。 |
| GET /api/monitors/:monitorId/order-execution-logs | 导出完整受控操作日志和证据 ID，不重新执行任务。 |

浏览器内部接口新增 observe()、resolveSemantic(target)、readSemantic(target)、screenshot()、rebindCoupon(checks)，会话提供 captureEvidence(stage)。resolveSemantic 返回当前 selector candidate、strategy、meaning、confidence；候选仅供受控执行器当次使用。外部 API 不允许调用任意浏览器脚本或裸 DOM 操作。

## 风险与恢复边界

两次试跑只在提交前停止，要求商品、数量、配置、总价、币种和付款意图一致；用户确认后才能启用。提交和付款前保存截图、核验值与持久化交易起始标记。实际 POST 请求继续绑定表单、数量、优惠码、付款方式及账单号，不能用通用 click 绕过。

恢复默认最多 2 次，总动作上限 40，总动态执行预算 180 秒，取消信号传递给模型和浏览器。元素缺失或页面结构变化在同一浏览器重新理解。购物车已点击但结果不明时先核验购物车，不能再添加。认证、挑战、请求被拦截、预算/币种错误不会通过 AI 放宽。提交后仅允许处理已确认的原订单；提交/付款结果不明时保留核对状态，不能重试交易。业务要求改变须重新试跑并确认。

订单成功要求实际成功响应后的唯一新订单编号和明确成功提示；付款成功要求新的明确付款提示。失败文字、旧提示、点击完成或 AI 自称成功都不作为成功结果。

这是通用页面理解与规划架构，并不承诺所有商城都能自动完成付款。当前财务请求仍只支持能够明确核验的同源 URL 编码 POST 表单；自定义 JSON 结账、跨域托管付款、未知语言成功提示、iframe/封闭 Shadow DOM、验证码及二次验证等不能安全核实时会停止或保留待付款。已有原账单绑定规则也仍需识别实际账单链接和编号。扩展请求类型时应增加独立的宿主请求验证，不放宽 AI 权限。

## 测试

~~~sh
node --test test/automation.test.js test/automation-api.test.js
node --test test/automation-browser.test.js
npm test
~~~

automation.test.js 验证业务 SOP 禁止定位/代码、八级定位回退、歧义拒绝、购物车与配置核验、同浏览器恢复、防重复添加、网站记忆原子写入/隔离、证据保留与审批哈希。

automation-api.test.js 验证探索、经验和 JSON/PNG 证据接口的鉴权及用户/任务隔离。

automation-browser.test.js 启动本地模拟商城，生成随机 ID 和不同 DOM 包装，验证入口之外的购物车/结账/成功/账单页，单次提交和付款，网站付款选项在重复观察后的绑定，以及优惠请求跳转后全部 ID 改变仍能重新核验。Windows 可使用已安装 Edge，其他环境设置 MONITOR_BROWSER_EXECUTABLE；没有浏览器时该文件明确跳过。测试只操作 localhost，不创建真实商家订单。

已有 test/orders.test.js、test/order-workflow.test.js、test/order-execution-log.test.js 继续验证旧任务、账户/监控变化、预算、优惠、代理、重启和交易日志的兼容保护。真实模型效果需要在已登录的商家测试环境用 discover → 审阅 → enable → prepare 模式检验，不把模拟规划器当作真实模型适配证明。
