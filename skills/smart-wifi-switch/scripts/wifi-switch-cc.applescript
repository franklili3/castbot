#!/usr/bin/osascript
-- WiFi 切换脚本 (通过控制中心)
-- 用法: osascript wifi-switch-cc.applescript <SSID>

on run argv
    if (count of argv) < 1 then
        return "用法: wifi-switch-cc.applescript <SSID>"
    end if

    set targetSSID to item 1 of argv

    tell application "System Events"
        -- 打开控制中心
        tell process "ControlCenter"
            try
                -- 点击控制中心图标
                click menu bar item 2 of menu bar 1
                delay 0.8

                -- 获取窗口内容
                tell window "控制中心"
                    try
                        -- 列出所有元素来调试
                        set allElements to entire contents
                        -- 查找包含目标 SSID 的元素
                        repeat with elem in allElements
                            try
                                set elemDesc to description of elem
                                if elemDesc contains targetSSID then
                                    click elem
                                    delay 1
                                    return "✅ 已连接到 " & targetSSID
                                end if
                            end try
                            try
                                set elemTitle to title of elem
                                if elemTitle contains targetSSID then
                                    click elem
                                    delay 1
                                    return "✅ 已连接到 " & targetSSID
                                end if
                            end try
                            try
                                set elemName to name of elem
                                if elemName contains targetSSID then
                                    click elem
                                    delay 1
                                    return "✅ 已连接到 " & targetSSID
                                end if
                            end try
                            try
                                set elemValue to value of elem
                                if elemValue contains targetSSID then
                                    click elem
                                    delay 1
                                    return "✅ 已连接到 " & targetSSID
                                end if
                            end try
                        end repeat

                        -- 关闭控制中心
                        key code 53
                        return "❌ 未找到网络: " & targetSSID

                    on error errMsg
                        key code 53
                        return "❌ 内部错误: " & errMsg
                    end try
                end tell

            on error errMsg
                return "❌ 错误: " & errMsg
            end try
        end tell
    end tell
end run
