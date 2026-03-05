#!/usr/bin/osascript
-- 打开 WiFi 设置页面

on run argv
    if (count of argv) < 1 then
        return "用法: osascript wifi-settings.applescript <SSID>"
    end if

    set targetSSID to item 1 of argv

    -- 打开 WiFi 设置
    tell application "System Settings"
        activate
        delay 1
    end tell

    tell application "System Events"
        tell process "System Settings"
            delay 1

            -- 尝试搜索 WiFi
            keystroke "f" using {command down}
            delay 0.5
            keystroke "wifi"
            delay 1
            keystroke return
            delay 2

            -- 这里需要更多导航逻辑...
            return "已打开 WiFi 设置，请手动选择: " & targetSSID
        end tell
    end tell
end run
