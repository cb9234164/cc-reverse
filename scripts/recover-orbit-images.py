"""Recover standalone sprite PNGs, texture metadata, bitmap fonts and atlases."""
from pathlib import Path
from functools import lru_cache
from PIL import Image
import json
import plistlib
import uuid

import argparse
import sys

arguments = argparse.ArgumentParser(description=__doc__)
arguments.add_argument('--output', required=True, type=Path)
ROOT = arguments.parse_args().output.resolve() / '_recovery'
def read(name):
    return json.loads((ROOT / name).read_text(encoding='utf8'))
def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')
@lru_cache(maxsize=32)
def open_image(path):
    with Image.open(path) as image:
        return image.convert('RGBA')

problems = []
jobs = read('image-jobs.json')
for i, job in enumerate(jobs):
    try:
        image = open_image(job['src'])
        x, y, width, height = map(round, job['rect'])
        box = (x, y, x + (height if job['rotated'] else width), y + (width if job['rotated'] else height))
        if box[0] < 0 or box[1] < 0 or box[2] > image.width or box[3] > image.height:
            raise ValueError(f'Crop outside texture: {box}, texture={image.size}')
        cropped = image.crop(box)
        if job['rotated']:
            cropped = cropped.transpose(Image.Transpose.ROTATE_90)
        raw_width, raw_height = map(round, job['originalSize'])
        if raw_width <= 0 or raw_height <= 0:
            raise ValueError(f'Invalid original size: {job["originalSize"]}')
        result = Image.new('RGBA', (raw_width, raw_height))
        ox, oy = job['offset']
        pos = (round((raw_width - width) / 2 + ox), round((raw_height - height) / 2 - oy))
        result.paste(cropped, pos)
        dest = Path(job['dest'])
        dest.parent.mkdir(parents=True, exist_ok=True)
        result.save(dest, compress_level=3)
    except Exception as error:
        problems.append({'dest': job['dest'], 'error': str(error)})
    if i % 500 == 0:
        print(f'Sprites: {i}/{len(jobs)}', flush=True)

for job in read('texture-metas.json'):
    file = Path(job['file'])
    if not file.exists():
        problems.append({'dest': str(file), 'error': 'Image not produced'})
        continue
    with Image.open(file) as image:
        job['meta']['width'], job['meta']['height'] = image.size
    write(str(file) + '.meta', job['meta'])

for job in read('font-jobs.json'):
    if not job.get('sprite'):
        problems.append({'dest': job['dest'], 'error': 'Font sprite unavailable'})
        continue
    config = job['font']['_fntConfig']
    sprite = job['sprite']
    p = Path(job['dest'])
    image = Path(sprite['path'])
    import os
    image_name = os.path.relpath(image, p.parent).replace('\\', '/')
    with Image.open(image) as im:
        w, h = im.size
    chars = config['fontDefDictionary']
    lines = [f'info face="Recovered" size={config.get("fontSize", 32)} bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=1 aa=1 padding=0,0,0,0 spacing=0,0',
             f'common lineHeight={config.get("commonHeight",32)} base={config.get("commonHeight",32)} scaleW={w} scaleH={h} pages=1 packed=0',
             f'page id=0 file="{image_name}"', f'chars count={len(chars)}']
    for char, definition in chars.items():
        rect = definition['rect']
        lines.append(f'char id={char} x={rect["x"]} y={rect["y"]} width={rect["width"]} height={rect["height"]} xoffset={definition["xOffset"]} yoffset={definition["yOffset"]} xadvance={definition["xAdvance"]} page=0 chnl=15')
    kerning = config.get('kerningDict', {})
    lines.append(f'kernings count={len(kerning)}')
    for key, amount in kerning.items():
        number = int(key)
        lines.append(f'kerning first={number >> 16} second={number & 65535} amount={amount}')
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('\n'.join(lines)+'\n', encoding='utf8')
    write(str(p)+'.meta', {'ver':'2.1.0','uuid':job['uuid'],'textureUuid':sprite['textureUuid'],'fontSize':job['font']['fontSize'],'subMetas':{}})

for job in read('atlas-jobs.json'):
    p = Path(job['dest'])
    frames = job['frames']
    if not frames:
        problems.append({'dest':str(p), 'error':'Atlas has no recovered frames'})
        continue
    sources = sorted({frame['source'] for frame in frames})
    pages = [open_image(src) for src in sources]
    image = Image.new('RGBA', (max(page.width for page in pages),sum(page.height for page in pages)))
    page_offsets = {}
    y_offset = 0
    for src, page in zip(sources, pages):
        page_offsets[src] = y_offset
        image.paste(page,(0,y_offset))
        y_offset += page.height
    texture = p.with_name(p.stem + '_atlas.png')
    image.save(texture, compress_level=3)
    texture_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, 'recovered-atlas-texture:'+job['uuid']))
    write(str(texture)+'.meta', {'ver':'2.3.7','uuid':texture_uuid,'importer':'texture','type':'raw','wrapMode':'clamp','filterMode':'bilinear','premultiplyAlpha':False,'genMipmaps':False,'packable':False,'width':image.width,'height':image.height,'platformSettings':{},'subMetas':{}})
    out_frames = {}
    for frame in frames:
        data = frame['data']
        x,y,w,h = data['rect']
        y += page_offsets[frame['source']]
        ox,oy = data.get('offset',[0,0])
        rw,rh = data.get('originalSize',[w,h])
        out_frames[frame['name']+'.png'] = {'frame':'{{%s,%s},{%s,%s}}' % (x,y,w,h),'offset':'{%s,%s}' % (ox,oy),'rotated':bool(data.get('rotated')),'sourceColorRect':'{{%s,%s},{%s,%s}}' % (round((rw-w)/2+ox),round((rh-h)/2-oy),w,h),'sourceSize':'{%s,%s}' % (rw,rh)}
    value = {'frames':out_frames,'metadata':{'format':2,'textureFileName':texture.name,'realTextureFileName':texture.name,'size':f'{{{image.width},{image.height}}}'}}
    with p.open('wb') as file:
        plistlib.dump(value,file,sort_keys=False)
    write(str(p)+'.meta', {'ver':'1.2.0','uuid':job['uuid'],'rawTextureUuid':texture_uuid,'size':{'width':image.width,'height':image.height},'subMetas':{}})

write(ROOT/'image-validation.json',{'spriteJobs':len(jobs),'errors':problems})
print(json.dumps({'spriteJobs':len(jobs),'errors':len(problems),'samples':problems[:10]},ensure_ascii=False),flush=True)

if problems:
    sys.exit(1)
