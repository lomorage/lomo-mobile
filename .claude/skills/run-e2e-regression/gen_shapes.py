"""Generate test photos with every shape the detail view has to handle.

usage: python gen_shapes.py <out_dir>
Each picture has a black border, white diagonals and a BLUE block in its top-left corner, so a
crop, stretch, wrong offset or wrong EXIF rotation is visible at a glance. rot90/rot180 carry
EXIF Orientation 6/3: they are stored landscape and must DISPLAY as portrait / upside down
(blue block top-right / bottom-right). No EXIF date on purpose: exercises the "no taken date" path.
Needs Pillow.
"""
import sys
from PIL import Image, ImageDraw

out = sys.argv[1]


def make(name, size, orient=None, color=(200, 80, 60)):
    im = Image.new('RGB', size, color)
    dr = ImageDraw.Draw(im)
    w, h = size
    dr.rectangle([0, 0, w - 1, h - 1], outline=(0, 0, 0), width=12)
    dr.line([0, 0, w, h], fill=(255, 255, 255), width=8)
    dr.line([0, h, w, 0], fill=(255, 255, 255), width=8)
    dr.rectangle([0, 0, w // 5, h // 8], fill=(0, 0, 255))
    ex = Image.Exif()
    if orient:
        ex[0x0112] = orient
    im.save(f'{out}/{name}.jpg', quality=85, exif=ex)


make('PXL_20261101_100000001_portrait', (1500, 2000))
make('PXL_20261101_100000002_square', (1800, 1800), color=(60, 160, 90))
make('PXL_20261101_100000003_panorama', (4000, 1000), color=(70, 90, 200))
make('PXL_20261101_100000004_tall', (1000, 4000), color=(200, 170, 40))
make('PXL_20261101_100000005_rot90', (2000, 1500), orient=6, color=(150, 60, 170))
make('PXL_20261101_100000006_rot180', (2000, 1500), orient=3, color=(40, 150, 170))
