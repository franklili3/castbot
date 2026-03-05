#!/usr/bin/osascript
-- 用索引点击 UI 元素

tell application "System Events"
    tell process "ControlCenter"
        -- 打开控制中心
        click menu bar item 2 of menu bar 1
        delay 0.8

        tell window "控制中心"
            try
                tell group 1
                    -- 获取所有 UI element 并点击最后一个（显示三角形）
                    set allUI to every UI element
                    set countUI to count of allUI
                    -- 点击倒数第二个（显示三角形通常是倒数第一或第二）
                    click UI element (countUI - 1)
                    delay 1.5

                    -- 检查展开后的内容
                    set allElements to entire contents
                    set output to "Total UI elements: " & countUI & "

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

            on error errMsg
                key code 53
                return "Error: " & errMsg
            end try
        end tell
    end tell
end tell
