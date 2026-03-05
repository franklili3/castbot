#!/usr/bin/osascript
-- 检查控制中心的窗口结构

tell application "System Events"
    tell process "ControlCenter"
        -- 打开控制中心
        click menu bar item 2 of menu bar 1
        delay 0.5

        try
            -- 获取所有窗口
            set windowList to name of every window
            return "Windows: " & (windowList as string)
        on error errMsg
            return "Error: " & errMsg
        end try
    end tell
end tell
