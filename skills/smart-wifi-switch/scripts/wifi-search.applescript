#!/usr/bin/osascript
-- 通过搜索网络来切换 WiFi
-- 用法: osascript wifi-search.applescript <SSID>

on run argv
    if (count of argv) < 1 then
        return "用法: osascript wifi-search.applescript <SSID>"
    end if

    set targetSSID to item 1 of argv

    tell application "System Events"
        tell process "ControlCenter"
            -- 打开控制中心
            click menu bar item 2 of menu bar 1
            delay 0.8

            tell window "控制中心"
                try
                    tell group 1
                        -- 点击 WiFi 区域展开
                        click scroll area 1
                        delay 1

                        -- 尝试搜索
                        keystroke "f" using {command down}
                        delay 0.5

                        -- 输入网络名称
                        keystroke targetSSID
                        delay 1

                        -- 回车选择
                        keystroke return
                        delay 2

                        -- 关闭
                        key code 53
                        return "✅ 已尝试连接到 " & targetSSID
                    end tell

                on error errMsg
                    key code 53
                    return "Error: " & errMsg
                end try
            end tell
        end tell
    end tell
end run
