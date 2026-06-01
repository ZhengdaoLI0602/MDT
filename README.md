# LedgerPilot 本地账本原型

这是一个 Windows 可开发、iPhone/iPad 可使用的本地优先 PWA 原型。它避开了 iOS 原生 App 必须依赖 macOS/Xcode 的限制，同时保留以后迁移到 SwiftUI 原生 App 的核心流程。

## 已实现的核心规则

- 微信/支付宝截图 OCR、银行短信、银行邮件、Apple Pay 交易和账单导入都先进入“待确认账单箱”。
- 截图可以通过 iOS 快捷指令调用系统 OCR 后写入，也可以在 App 内选择/粘贴截图走备用浏览器 OCR。
- 确认前可以修改金额、商户、时间、渠道、分类、备注和原始文本。
- 微信/支付宝账单导入不会直接覆盖已有记录。
- 疑似重复记录会进入重复审查，可以选择保留已有、合并、两条都保留、用新记录替换或忽略。
- 手动记账可以直接入账，也可以先放进待确认箱。
- 支持 `quickExpense` 快速记账入口，也支持 `screenExpense` 背部轻点屏幕 OCR：自动带入金额、商户、时间和分类，补备注后确认写入本地账本。
- 还款提醒支持每月固定日期和提前提醒天数，并可导出日历 `.ics` 文件。
- 数据默认保存在当前浏览器的 `localStorage`，不上传到服务器。

## 文件作用

- `index.html`：PWA 的页面结构，包含待确认箱、正式账本、手动记账、截图/文本入口、账单导入和还款提醒。
- `app.js`：核心业务逻辑，负责本地存储、解析短信/OCR 文本、截图备用 OCR、重复检查、确认入账、导入导出和提醒。
- `styles.css`：界面样式和移动端布局。
- `manifest.webmanifest`：PWA 元数据，也声明了支持系统分享图片到 App 的 Web Share Target；注意 iOS Safari 当前不支持这个能力。
- `sw.js`：Service Worker，用于缓存静态文件，并在支持 Web Share Target 的浏览器中接收分享进来的截图。

## 在 Windows 本地运行

在 `LedgerPilot` 文件夹中启动一个静态服务器：

```powershell
python -m http.server 8787
```

然后打开：

```text
http://localhost:8787
```

如果要在 iPhone/iPad 上访问，把电脑和 iPhone/iPad 放在同一 Wi-Fi 下，用电脑局域网 IP 访问，例如：

```text
http://192.168.1.20:8787
```

这种方式适合测试。要获得更接近 App 的体验，可以把这个静态目录部署到 GitHub Pages、Cloudflare Pages 或其他 HTTPS 静态托管，再在 iPhone/iPad Safari 中“添加到主屏幕”。这些平台有免费额度。

## 快捷指令接入方式

PWA 支持通过 URL 写入待确认记录：

```text
https://你的地址/index.html?intent=bankMessage&text=短信或邮件正文
```

可用 `intent`：

- `bankMessage`：银行短信
- `bankEmail`：银行邮件
- `applePay`：Apple Pay 交易
- `wechatOcr`：微信截图 OCR
- `alipayOcr`：支付宝截图 OCR

也可以直接传结构化字段：

```text
https://你的地址/index.html?intent=applePay&amount=35.8&merchant=Starbucks&time=2026-05-31T12:30
```

所有 URL 进入的记录都会先进入待确认箱。

快速记账入口用于背部轻点或桌面快捷方式：

```text
https://你的地址/index.html?intent=quickExpense
```

打开后会弹出“快速记一笔”面板，填写金额、选择预设消费类型，确认后直接记录到本地账本。也可以预填字段：

```text
https://你的地址/index.html?intent=quickExpense&amount=35.8&category=餐饮&channel=微信
```

如果希望背部轻点自动抓取当前消费页面，可让快捷指令截图并提取文字，再打开：

```text
https://你的地址/index.html?intent=screenExpense&text=OCR后的文字
```

App 会把 OCR 文本解析成金额、商户、时间、渠道和分类，并打开确认面板；你补充备注后点确认即可入账。

## iPhone/iPad 背部轻点快速记账

空白快速记账：

1. 在“快捷指令”中新建快捷指令，动作选择“打开 URL”。
2. URL 填 `https://你的地址/index.html?intent=quickExpense`。
3. 在系统“设置”中进入“辅助功能”→“触控”→“轻点背面”。
4. 选择“双击”或“三击”，绑定刚才创建的快捷指令。

屏幕 OCR 自动带入字段：

1. 在“快捷指令”中新建快捷指令。
2. 动作顺序建议为：截屏 → 从图像中提取文本 → URL 编码 → 打开 URL。
3. 打开的 URL 填 `https://你的地址/index.html?intent=screenExpense&text=编码后的文本`。
4. 把这个快捷指令绑定到“轻点背面”。
5. 日常消费页面停留在支付成功/订单详情页时轻点背部，LedgerPilot 会自动解析当前屏幕文字并打开确认面板。

注意：这不是读取支付 App 的内部数据库，而是读取当前屏幕可见文字。页面上金额、商户、时间显示得越清楚，识别越稳定。

## iOS 快捷指令建议

iPhone/iPad 上推荐优先使用系统 OCR。PWA 网页本身不能直接调用 Apple Live Text/Vision OCR；可行路径是用快捷指令接收截图，执行“从图像中提取文本”，再打开本 App 的 URL。

截图 OCR 快捷指令：

1. 截取微信/支付宝支付成功页。
2. 快捷指令接收分享进来的图片，或读取最新截图。
3. 使用“从图像中提取文本”。
4. 对文本进行 URL 编码。
5. 打开 `...?intent=wechatOcr&text=编码后的文本` 或 `...?intent=alipayOcr&text=编码后的文本`。

备用方案：在 App 的“快捷入口”中直接选择截图、粘贴截图，或在支持 Web Share Target 的浏览器中分享截图到 App。此方式使用浏览器内 OCR，首次使用需要联网加载识别引擎；在 iPhone/iPad 上可靠性不如快捷指令原生 OCR。

银行短信/邮件：

1. 建立个人自动化，触发条件为指定银行短信或邮件。
2. 条件包含“支付宝”“财付通”“快捷支付”“支出”“消费”等关键词。
3. 取短信或邮件正文。
4. 打开 `...?intent=bankMessage&text=编码后的正文`。

Apple Pay：

1. 建立“交易”自动化。
2. 把交易商户、金额和时间拼成文本，或分别传 `amount`、`merchant`、`time`。
3. 打开 `...?intent=applePay...`。

## Windows-only 开发限制

只用 Windows 可以继续开发这个 PWA 版本，但不能完整开发和签名原生 iOS App。原生 SwiftUI、App Intents、Share Extension 和 TestFlight/App Store 打包都需要 macOS + Xcode。没有 Mac 时的低成本路径是：

- 先用本 PWA 完成业务流程和数据模型。
- 后续需要原生 iOS 能力时，再用 Mac、云 Mac 或 GitHub Actions/macOS runner 做打包。
- 如果只是自己使用，PWA 路线可以长期保留，不必上架 App Store。
