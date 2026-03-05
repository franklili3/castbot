#!/usr/bin/env python3
"""
WiFi 连接工具 - 使用 CoreWLAN 框架
用法: python3 wifi-connect.py <SSID>
"""

import sys
import objc
from Foundation import NSBundle

def main():
    if len(sys.argv) < 2:
        print("用法: wifi-connect.py <SSID>")
        sys.exit(1)
    
    target_ssid = sys.argv[1]
    
    # 加载 CoreWLAN 框架
    CoreWLAN = NSBundle.bundleWithPath_('/System/Library/Frameworks/CoreWLAN.framework')
    CoreWLAN.load()
    
    # 获取 CWWiFiClient 类
    CWWiFiClient = objc.lookUpClass('CWWiFiClient')
    CWNetwork = objc.lookUpClass('CWNetwork')
    
    # 获取 WiFi 客户端和接口
    client = CWWiFiClient.sharedWiFiClient()
    interfaces = client.interfaces()
    
    if not interfaces or len(interfaces) == 0:
        print("❌ 未找到 WiFi 接口")
        sys.exit(1)
    
    interface = interfaces[0]  # 使用第一个接口
    
    # 获取当前 SSID
    current_ssid = interface.ssid()
    print(f"ℹ️ 当前连接: {current_ssid or '无'}")
    print(f"ℹ️ 尝试连接到: {target_ssid}")
    
    # 如果已连接目标网络
    if current_ssid == target_ssid:
        print(f"✅ 已连接到 {target_ssid}，无需切换")
        sys.exit(0)

    # 扫描网络
    print("ℹ️ 扫描网络...")
    try:
        error = None
        result = interface.scanForNetworksWithName_error_(None, None)
        if result is None:
            print("❌ 扫描失败")
            sys.exit(1)
        # 返回的是 (NSSet, NSError) 元组
        if isinstance(result, tuple):
            networks = result[0]
        else:
            networks = result

        if networks is None:
            print("❌ 未扫描到任何网络")
            sys.exit(1)
    except Exception as e:
        print(f"❌ 扫描错误: {e}")
        sys.exit(1)

    # 查找目标网络
    target_network = None
    for network in networks:
        ssid = network.ssid()
        if ssid == target_ssid:
            target_network = network
            break

    if not target_network:
        print(f"❌ 未找到网络: {target_ssid}")
        print("可用网络:")
        count = 0
        for network in networks:
            ssid = network.ssid()
            if ssid and count < 10:
                print(f"  - {ssid}")
                count += 1
        sys.exit(1)
    
    # 从钥匙串获取密码
    import subprocess
    password = None
    try:
        result = subprocess.run(
            ['security', 'find-generic-password', '-D', 'AirPort network password', '-wa', target_ssid],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            password = result.stdout.strip()
            print(f"ℹ️ 从钥匙串获取到密码")
    except Exception as e:
        print(f"⚠️  无法从钥匙串获取密码: {e}")

    # 连接
    print(f"ℹ️ 连接到 {target_ssid}...")
    try:
        error = None
        success = interface.associateToNetwork_password_error_(target_network, password, None)
        if success:
            import time
            time.sleep(3)
            new_ssid = interface.ssid()
            if new_ssid == target_ssid:
                print(f"✅ 已成功连接到 {target_ssid}")
                sys.exit(0)
            else:
                print(f"❌ 连接失败，当前: {new_ssid or '无'}")
                sys.exit(1)
        else:
            print("❌ 连接失败")
            sys.exit(1)
    except Exception as e:
        print(f"❌ 连接错误: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
