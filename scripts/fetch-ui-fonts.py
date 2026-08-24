"""Self-host the UI fonts.

The app used to pull Amiri, Reem Kufi and Inter from Google on every first
paint: two extra connections before anything is drawn, and a third party told
about every reader. This downloads them once into public/fonts/ui/ and writes
public/css/fonts.css against local paths.

Only the arabic and latin subsets are kept — the family also ships cyrillic,
greek and vietnamese, which this app never draws.

    python scripts/fetch-ui-fonts.py
"""

import os
import re
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, 'public', 'fonts', 'ui')
CSS = os.path.join(HERE, 'public', 'css', 'fonts.css')

# Only the weights the stylesheet actually asks for. Amiri 400/700 set the
# Arabic chrome and the page labels, Reem Kufi 500 the display headings, Inter
# 400/600 the Latin UI. Adding a weight here without using it just parks a file
# on the server.
API = ('https://fonts.googleapis.com/css2?family=Amiri:wght@400;700'
       '&family=Reem+Kufi:wght@500'
       '&family=Inter:wght@400;600&display=swap')

# A modern UA is what makes Google serve woff2 rather than ttf.
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'}
KEEP = {'arabic', 'latin'}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA)).read()


def main():
    os.makedirs(OUT, exist_ok=True)
    css = get(API).decode('utf-8')

    # Google labels each face with a /* subset */ comment above it.
    blocks = re.findall(r'/\* (\S+) \*/\s*(@font-face \{.*?\})', css, re.S)
    if not blocks:
        raise SystemExit('no @font-face blocks — the API response changed shape')

    header = ('/* UI fonts, self-hosted so first paint waits on nobody else.\n'
              '   Arabic and Latin subsets only.\n'
              '   Rebuild: python scripts/fetch-ui-fonts.py */')
    parts = [header]
    total = 0

    for subset, block in blocks:
        if subset not in KEEP:
            continue
        fam = re.search(r"font-family: '([^']+)'", block).group(1)
        weight = re.search(r'font-weight: (\d+)', block).group(1)
        url = re.search(r'url\((https://[^)]+\.woff2)\)', block).group(1)

        name = '%s-%s-%s.woff2' % (fam.lower().replace(' ', '-'), weight, subset)
        path = os.path.join(OUT, name)
        if not os.path.exists(path):
            with open(path, 'wb') as fh:
                fh.write(get(url))
        total += os.path.getsize(path)

        local = re.sub(r'url\(https://[^)]+\.woff2\)', "url('../fonts/ui/%s')" % name, block)
        parts.append('/* %s */\n%s' % (subset, local))
        print('  %-11s %-4s %-7s %5.0f KB' % (fam, weight, subset, os.path.getsize(path) / 1024))

    with open(CSS, 'w', encoding='utf-8') as fh:
        fh.write('\n\n'.join(parts) + '\n')

    print('\n%d faces of %d, %.0f KB -> public/fonts/ui/' % (len(parts) - 1, len(blocks), total / 1024))
    print('wrote public/css/fonts.css')


if __name__ == '__main__':
    main()
