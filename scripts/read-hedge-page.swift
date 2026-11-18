// Reads visible labels in one selected trading page through the macOS accessibility API.
import AppKit
import ApplicationServices

func abort(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

guard CommandLine.arguments.count == 2, let target = URL(string: CommandLine.arguments[1]),
  target.scheme == "https", ["next.vestmarkets.com", "app.hyperliquid.xyz"].contains(target.host),
  target.path.hasPrefix("/trade/")
else { abort("需要已打开的官网合约页") }
guard AXIsProcessTrusted() else { abort("本机未授权辅助功能读取 Chrome 页面") }
guard
  let chrome = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome")
    .first
else { abort("Chrome 未打开") }
let app = AXUIElementCreateApplication(chrome.processIdentifier)
AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
func attribute(_ el: AXUIElement, _ key: String) -> CFTypeRef? {
  var val: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, key as CFString, &val) == .success ? val : nil
}
let labels: Set<String> = [
  "账户价值", "account value", "account equity", "账户净值", "可用保证金", "available margin", "free margin",
  "交易额度", "trading power", "buying power", "仓位占用", "position margin", "订单占用", "order margin",
  "投资组合价值", "portfolio value", "可用", "available to trade",
]
let flags: Set<String> = [
  "connect", "connect wallet", "连接钱包", "连接錢包", "未找到持仓", "您没有持仓。请下单开始交易。", "no open positions",
  "no positions found",
]
for _ in 0..<10 {
  var rows = [String]()
  var wantAmount = false
  var selected = ""
  var matched = false
  var visits = 0
  let trim = CharacterSet.whitespacesAndNewlines
  func walk(_ el: AXUIElement, _ inside: Bool, _ depth: Int) {
    visits += 1
    if depth > 56 || visits > 18000 { return }
    let role = attribute(el, "AXRole") as? String ?? ""
    var allowed = inside
    if role == "AXWebArea" {
      guard let url = attribute(el, "AXURL") as? URL, url.scheme == target.scheme,
        url.host == target.host, url.path == target.path
      else { return }
      allowed = true
      matched = true
    }
    if allowed {
      if role == "AXPopUpButton" && target.host == "next.vestmarkets.com" {
        let words = ["AXTitle", "AXDescription"].compactMap { attribute(el, $0) as? String }
        if words.contains(where: {
          $0.range(
            of: #"^(主账户|主帳戶|primary account|main account)(?:\s+(?:复制|複製|copy))?$"#,
            options: [.regularExpression, .caseInsensitive]) != nil
        }) {
          selected = "主账户"
        }
      }
      if ["AXStaticText", "AXButton", "AXHeading", "AXCell", "AXLink"].contains(role) {
        let text =
          ["AXValue", "AXTitle", "AXDescription"].compactMap { attribute(el, $0) as? String }.first(
            where: { !$0.trimmingCharacters(in: trim).isEmpty })?.trimmingCharacters(in: trim) ?? ""
        if !text.isEmpty {
          let key = text.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ":："))
          if wantAmount {
            // A sentinel prevents a missing amount from binding to a later field.
            let pattern =
              #"^[+-]?\s*\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:USD|USDC|USDT)?$"#
            rows.append(text.range(of: pattern, options: .regularExpression) != nil ? text : "—")
          }
          wantAmount = labels.contains(key)
          if wantAmount || flags.contains(key) { rows.append(text) }
        }
      }
    }
    for child in (attribute(el, "AXChildren") as? [AXUIElement] ?? []) {
      walk(child, allowed, depth + 1)
    }
  }
  if let win = attribute(app, "AXFocusedWindow") { walk(win as! AXUIElement, false, 0) }
  if matched && !rows.isEmpty {
    let clock = ISO8601DateFormatter()
    clock.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let result: [String: Any] = [
      "at": clock.string(from: Date()), "symbol": target.lastPathComponent, "rows": rows,
      "accountLabel": selected,
    ]
    let data = try JSONSerialization.data(withJSONObject: result)
    FileHandle.standardOutput.write(data)
    exit(0)
  }
  Thread.sleep(forTimeInterval: 0.15)
}
abort("未能读取该合约页的可见字段，请展开账户概览")
