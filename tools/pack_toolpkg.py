#!/usr/bin/env python3
"""打包 Operit .toolpkg：manifest.json 必须在 zip 根，排除 .toolpkg-cache-signature。
用法：python3 pack_toolpkg.py <项目目录> [输出路径]
校验：manifest 在根、dist/main.js 存在、包内列清单；失败 exit 1。
"""
import json, os, sys, zipfile

def main():
    if len(sys.argv) < 2:
        print('用法: pack_toolpkg.py <项目目录> [输出.toolpkg]', file=sys.stderr)
        return 2
    root = os.path.abspath(sys.argv[1])
    man_path = os.path.join(root, 'manifest.json')
    if not os.path.isfile(man_path):
        print('FAIL: manifest.json 必须在项目根', file=sys.stderr); return 1
    man = json.load(open(man_path, encoding='utf-8'))
    for k in ('schema_version', 'api_version', 'toolpkg_id', 'version', 'main'):
        if k not in man:
            print(f'FAIL: manifest 缺 {k}', file=sys.stderr); return 1
    main_rel = man['main'].lstrip('./')
    if not os.path.isfile(os.path.join(root, main_rel)):
        print(f'FAIL: main 指向的文件不存在: {main_rel}', file=sys.stderr); return 1
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        root, 'artifacts', f"{man['toolpkg_id']}-{man['version']}.toolpkg")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    entries = ['manifest.json']
    for cur, dirs, files in os.walk(os.path.join(root, 'dist')):
        dirs.sort()
        for f in sorted(files):
            rel = os.path.relpath(os.path.join(cur, f), root).replace(os.sep, '/')
            if rel.endswith('.toolpkg-cache-signature') or '.bak' in rel:
                continue
            entries.append(rel)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in entries:
            z.write(os.path.join(root, rel), rel)
    names = sorted(zipfile.ZipFile(out).namelist())
    print(f'OK: {out} ({os.path.getsize(out)} B)')
    for n in names:
        print('  ' + n)
    if 'manifest.json' not in names:
        print('FAIL: manifest.json 不在 zip 根', file=sys.stderr); return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
