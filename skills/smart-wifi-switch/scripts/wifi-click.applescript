#!/usr/bin/osascript
-- 直接点击 scroll area 里的按钮

on run argv
    if (count of argv) < 1 then
        return "用法: osascript wifi-click.applescript <SSID>"
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
                        tell scroll area 1
                            -- 获取所有按钮
                            set allButtons to every button
                            set buttonCount to count of allButtons

                            -- 尝试点击每个按钮
                            repeat with i from 1 to buttonCount
                                try
                                    click button i
                                    delay 2

                                    -- 检查是否连接成功
                                    tell application "System Events"
                                        tell process "ControlCenter"
                                            try
                                                -- 关闭控制中心
                                                key code 53
                                            end try
                                        end tell
                                    end tell

                                    return "✅ 已点击按钮 " & i
                                on error
                                    -- 继续尝试下一个
                                end try
                            end repeat

                            key code 53
                            return "❌ 未找到可点击的网络"
                        end tell
                    end tell

                on error errMsg
                    key code 53
                    return "Error: " & errMsg
                end try
            end tell
        end tell
    end tell
end run
