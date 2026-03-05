#!/usr/bin/osascript
-- 检查 scroll area 里的网络列表

tell application "System Events"
    tell process "ControlCenter"
        -- 打开控制中心
        click menu bar item 2 of menu bar 1
        delay 0.8

        tell window "控制中心"
            try
                tell group 1
                    tell scroll area 1
                        -- 获取 scroll area 里的所有元素
                        set allElements to entire contents
                        set output to "Scroll area contents:

"
                        repeat with elem in allElements
                            try
                                set elemClass to class of elem as string
                                set elemDesc to ""
                                try
                                    set elemDesc to description of elem
                                end try
                                try
                                    if elemDesc is "" then set elemDesc to title of elem
                                end try
                                try
                                    if elemDesc is "" then set elemDesc to name of elem
                                end try
                                try
                                    if elemDesc is "" then set elemDesc to value of elem
                                end try
                                if elemDesc is not "" then
                                    set output to output & elemClass & ": " & elemDesc & "
"
                                end if
                            end try
                        end repeat
                        return output
                    end tell
                end tell

            on error errMsg
                key code 53
                return "Error: " & errMsg
            end try
        end tell
    end tell
end tell
