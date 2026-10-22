@echo off
chcp 65001 >nul
cd /d "%~dp0app"
set "PATH=C:\Users\wallen\.workbuddy\binaries\node\versions\22.22.2-6;C:\Users\wallen\.cargo\bin;%PATH%"

echo.
echo   桌面版开发模式（真实数据库，能测附件/文档/浮动网页/导出）
echo   第一次编译约 3-5 分钟，之后改前端会自动刷新
echo   数据位置： %%APPDATA%%\com.kanban.desk
echo   关闭这个黑窗口就等于关掉程序
echo.

call npm run tauri dev

pause
