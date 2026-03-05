#!/usr/bin/osascript
-- WiFi 切换脚本
-- 用法: osascript wifi-switch.applescript <SSID>

on run argv
    if (count of argv) < 1 then
        return "用法: wifi-switch.applescript <SSID>"
    end if
    
    set targetSSID to item 1 of argv
    
    tell application "System Events"
        tell process "SystemUIServer"
            -- 点击 WiFi 菜单图标
            try
                click menu bar item "Wi-Fi" of menu bar 1
            on error
                -- 尝试其他可能的名称
                try
                    click menu bar item 1 of menu bar 1 whose description contains "Wi-Fi"
                on error
                    return "❌ 无法找到 WiFi 菜单"
                end try
            end try
            
            delay 0.5
            
            -- 在菜单中查找目标网络
            try
                click menu item targetSSID of menu 1 of menu bar item "Wi-Fi" of menu bar 1
                delay 2
                return "✅ 已尝试连接到 " & targetSSID
            on error
                -- 关闭菜单
                key code 53 -- ESC
                return "❌ 未找到网络: " & targetSSID
            end try
        end tell
    end tell
end run
