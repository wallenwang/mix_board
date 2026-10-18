#!/usr/bin/env python3
"""应用图标：按用户提供的 logo 重绘（房子轮廓 + 门洞拱形线条）。

造型来自用户原图：外轮廓 = 尖顶 + 两侧竖腿（底部开口）；
内部 = 拱门（半圆 + 两条竖腿）。纯线条，无填充。

绘制方式：沿路径**密集盖圆**（圆头笔触）。
PIL 的分段 line 在转折处会留下白色细缝（实测有锯齿），盖章法没有这个问题，
且圆头端点天然成立。

用法：python app/scripts/gen_icon.py → app/app-icon/icon.png
      npx tauri icon app/app-icon/icon.png
"""
import math
from PIL import Image, ImageDraw

S = 1024
R = 224          # 圆角半径
SW = 64          # 线宽
STEP = 2         # 盖章间距（像素）

INK = (27, 33, 43, 255)        # #1b212b
PAPER = (247, 245, 240, 255)   # #f7f5f0

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=R, fill=PAPER)

def P(nx: float, ny: float) -> tuple[float, float]:
    return nx * S, ny * S

def stroke(path: list[tuple[float, float]]) -> None:
    """沿折线密集盖圆，得到连续、圆头的粗线。"""
    rad = SW / 2
    for i in range(len(path) - 1):
        x0, y0 = path[i]
        x1, y1 = path[i + 1]
        dist = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(dist / STEP))
        for k in range(n + 1):
            t = k / n
            x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=INK)

apex = P(0.5, 0.185)
sh_l, sh_r = P(0.225, 0.345), P(0.775, 0.345)
bot_l, bot_r = P(0.225, 0.805), P(0.775, 0.805)

# 外轮廓：尖顶 → 肩 → 竖腿（底部开口，不封口）
stroke([bot_l, sh_l, apex, sh_r, bot_r])

# 内拱：左腿 → 半圆 → 右腿，一条连续路径
cx, cy, r = S * 0.5, S * 0.585, S * 0.145
bottom = S * 0.805
arch = [(cx - r, bottom)]
for i in range(81):
    a = math.pi + math.pi * (i / 80)          # 180° → 360°（上半圆）
    arch.append((cx + r * math.cos(a), cy + r * math.sin(a)))
arch.append((cx + r, bottom))
stroke(arch)

img.save(r"C:\Users\wallen\Desktop\ai_agent\看板白板mix_v0.2\app\app-icon\icon.png")
print("saved", img.size)

# 预览条：128/64/32 并排，对照原图看小尺寸识别度
preview = Image.new("RGB", (600, 220), (250, 250, 250))
x = 40
for size in (128, 64, 32):
    im = img.resize((size, size), Image.LANCZOS)
    preview.paste(im, (x, 40 + (128 - size) // 2), im)
    x += size + 70
preview.save(r"C:\Users\wallen\AppData\Local\Temp\icon-preview.png")
print("preview saved")
