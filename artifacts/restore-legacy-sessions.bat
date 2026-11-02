@echo off
chcp 65001 >nul
title 恢复旧会话数据 (agent-desktop -> @prophey\\desktop)
echo.
echo 请确认 Prophey 已经完全退出（窗口关掉、托盘里也没有）。
echo 在应用运行时写入 sessions.json 会被应用覆盖回去。
echo.
pause
node "%~dp0restore-legacy-sessions.mjs" %*
echo.
pause
