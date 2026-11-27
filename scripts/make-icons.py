"""生成网页“装成应用”（PWA）用的图标：主色绿底、白色“未”字。
用法（要 Pillow 和 Noto CJK 字体）：python3 scripts/make-icons.py
输出到 web/icons/：192、512（普通，圆角），512 maskable（满底，字在中间 60% 里，安卓会裁成各种形状），180（苹果主屏幕）。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ACCENT = (0x2F, 0x6B, 0x5A)
OUT = os.path.join(os.path.dirname(__file__), '..', 'web', 'icons')
FONT = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc'


def sc_font(size):
    # .ttc 里有日、韩、简、繁几套，按名字挑简体中文
    for i in range(10):
        try:
            f = ImageFont.truetype(FONT, size, index=i)
        except OSError:
            break
        if 'SC' in ' '.join(f.getname()):
            return f
    raise SystemExit('没找到 Noto Serif CJK SC 字体')


def icon(size, text_ratio, rounded):
    scale = 4  # 先画大再缩小，边缘更平滑
    s = size * scale
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=ACCENT)
    else:
        d.rectangle([0, 0, s, s], fill=ACCENT)
    f = sc_font(int(s * text_ratio))
    box = d.textbbox((0, 0), '未', font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((s - w) / 2 - box[0], (s - h) / 2 - box[1]), '未', font=f, fill=(255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
icon(192, 0.62, True).save(os.path.join(OUT, 'icon-192.png'))
icon(512, 0.62, True).save(os.path.join(OUT, 'icon-512.png'))
icon(512, 0.5, False).save(os.path.join(OUT, 'maskable-512.png'))
icon(180, 0.6, False).convert('RGB').save(os.path.join(OUT, 'apple-180.png'))
print('ok')
