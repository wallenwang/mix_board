@echo off
chcp 65001 >nul
cd /d "%~dp0app"
set "PATH=C:\Users\wallen\.workbuddy\binaries\node\versions\22.22.2-6;%PATH%"

echo.
echo   浏览器预览模式（前端改动即时生效，不需要编译 Rust）
echo   数据走浏览器里的本地存储，不会碰到你的真实项目库
echo   地址： http://127.0.0.1:1422/
echo   关闭这个黑窗口就停止服务
echo.

start "" http://127.0.0.1:1422/
call npx vite --port 1422 --strictPort

pause
