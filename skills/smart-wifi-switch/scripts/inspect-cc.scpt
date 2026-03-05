#!/usr/bin/osascript
-- 检查控制中心的 UI 结构

tell application "System Events"
    tell process "ControlCenter"
        -- 打开控制中心
        click menu bar item 2 of menu bar 1
        delay 0.5

        try
            set windowContent to entire contents of window "Control Center"
            return windowContent as string
        on error errMsg
            return "Error: " & errMsg
        end try
    end tell
end tell
