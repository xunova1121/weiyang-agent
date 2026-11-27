"""生成安卓 App 的图标和启动画面（和网页的图标一样：主色绿底、白色“未”字）。
用法（要 Pillow 和 Noto CJK 字体）：python3 apps/android/make-icons.py
"""
import glob
import os
from PIL import Image, ImageDraw, ImageFont

RES = os.path.join(os.path.dirname(__file__), 'android', 'app', 'src', 'main', 'res')
ACCENT = (0x2F, 0x6B, 0x5A)
BG = (0xF6, 0xF4, 0xEE)


def glyph(size, ratio, color=(255, 255, 255), bg=None, shape=None):
    """画“未”字；bg 为 None 时透明底；shape: None / 'round' / 'square'"""
    font_file = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc'
    f = None
    for i in range(10):
        try:
            cand = ImageFont.truetype(font_file, int(size * 4 * ratio), index=i)
        except OSError:
            break
        if 'SC' in ' '.join(cand.getname()):
            f = cand
            break
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg and shape == 'round':
        d.ellipse([0, 0, s - 1, s - 1], fill=bg)
    elif bg and shape == 'rounded':
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.2), fill=bg)
    elif bg:
        d.rectangle([0, 0, s, s], fill=bg)
    box = d.textbbox((0, 0), '未', font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((s - w) / 2 - box[0], (s - h) / 2 - box[1]), '未', font=f, fill=color)
    return img.resize((size, size), Image.LANCZOS)


DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for name, k in DENS.items():
    d = os.path.join(RES, f'mipmap-{name}')
    glyph(int(48 * k), 0.6, bg=ACCENT, shape='rounded').save(os.path.join(d, 'ic_launcher.png'))
    glyph(int(48 * k), 0.58, bg=ACCENT, shape='round').save(os.path.join(d, 'ic_launcher_round.png'))
    # 自适应图标前景：108dp 画布，安卓只保证中间 66dp 不被裁，字放在中间约 45% 里
    glyph(int(108 * k), 0.42).save(os.path.join(d, 'ic_launcher_foreground.png'))

# 启动画面：浅底，中间一个图标
for path in glob.glob(os.path.join(RES, 'drawable*', 'splash.png')):
    w, h = Image.open(path).size
    img = Image.new('RGB', (w, h), BG)
    ic = glyph(int(min(w, h) * 0.28), 0.62, bg=ACCENT, shape='rounded')
    img.paste(ic, ((w - ic.width) // 2, (h - ic.height) // 2), ic)
    img.save(path)

with open(os.path.join(RES, 'values', 'ic_launcher_background.xml'), 'w') as fh:
    fh.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2F6B5A</color>\n</resources>\n')
print('ok')
