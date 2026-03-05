#!/usr/bin/osascript
-- 点击 triangle 展开网络列表

tell application "System Events"
    tell process "ControlCenter"
        -- 打开控制中心
        click menu bar item 2 of menu bar 1
        delay 0.8

        tell window "控制中心"
            try
                tell group 1
                    -- 点击显示三角形
                    tell UI element "显示三角形"
                        click
                        delay 1.5
                    end tell

                    -- 检查展开后的内容
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
