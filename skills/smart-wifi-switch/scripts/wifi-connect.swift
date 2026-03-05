#!/usr/bin/swift
import CoreWLAN

let args = CommandLine.arguments
if args.count < 2 {
    print("用法: wifi-connect.swift <SSID>")
    exit(1)
}

let ssid = args[1]
let client = CWWiFiClient.shared()
guard let interface = client.interfaces()?.first else {
    print("❌ 未找到 WiFi 接口")
    exit(1)
}

print("ℹ️ 当前连接: \(interface.ssid() ?? "无")")
print("ℹ️ 尝试连接到: \(ssid)")

// 扫描网络
guard let networks = try? interface.scanForNetworks(withSSID: nil) else {
    print("❌ 扫描网络失败")
    exit(1)
}

// 查找目标网络
guard let targetNetwork = networks.first(where: { $0.ssid == ssid }) else {
    print("❌ 未找到网络: \(ssid)")
    print("可用网络:")
    for network in networks.prefix(10) {
        print("  - \(network.ssid ?? "未知")")
    }
    exit(1)
}

// 连接 (密码从钥匙串获取)
do {
    try interface.associate(to: targetNetwork, password: nil)
    sleep(2)
    if let newSSID = interface.ssid(), newSSID == ssid {
        print("✅ 已成功连接到 \(ssid)")
        exit(0)
    } else {
        print("❌ 连接失败，当前: \(interface.ssid() ?? "无")")
        exit(1)
    }
} catch {
    print("❌ 连接错误: \(error.localizedDescription)")
    exit(1)
}
