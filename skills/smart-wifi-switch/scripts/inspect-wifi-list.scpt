#!/usr/bin/osascript
-- 先展开 WiFi 列表，再选择网络

tell application "System Events"
    tell process "ControlCenter"
        -- 打开控制中心
        click menu bar item 2 of menu bar 1
        delay 0.8

        tell window "控制中心"
            try
                -- 点击 scroll area 来展开 WiFi
                tell group 1
                    tell scroll area 1
                        -- 尝试点击
                        click
                        delay 1.5
                    end tell
                end tell

                -- 现在检查展开后的内容
                tell group 1
                    set allElements to entire contents
                    set output to ""
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

            on error errMsg
                key code 53
                return "Error: " & errMsg
            end try
        end tell
    end tell
end tell
