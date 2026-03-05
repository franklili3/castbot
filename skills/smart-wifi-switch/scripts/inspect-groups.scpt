#!/usr/bin/oscript
-- 详细检查控制中心的 UI 结构

tell application "System Events"
    tell process "ControlCenter"
        -- 打开控制中心
        click menu bar item 2 of menu bar 1
        delay 0.8

        tell window "控制中心"
            try
                -- 获取所有组
                set allGroups to every group
                set groupInfo to ""
                repeat with g in allGroups
                    try
                        set groupDesc to description of g
                        set groupInfo to groupInfo & "Group: " & groupDesc & "
"
                    end try
                end repeat
                return groupInfo
            on error errMsg
                return "Error: " & errMsg
            end try
        end tell
    end tell
end tell
