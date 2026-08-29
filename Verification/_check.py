"""What node --check cannot see: names used where they are not in scope, and
the two mistakes that mechanical edits keep making in this file.

Run it after editing the front end. It has caught, in order: a duplicated
choose(), a deleted makeZoomable, a duplicated comparePhoto, a call to a route
that had been removed, and `pick` outliving its block -- twice, the second time
because a file was restored from git and the fix went with it."""
import io, re, sys
from collections import Counter

js = io.open('static/app.js', encoding='utf-8').read()
html = io.open('static/index.html', encoding='utf-8').read()
py = io.open('app.py', encoding='utf-8').read()
bad = []

dups = {n: c for n, c in Counter(
    re.findall(r'^(?:async )?function ([\w$]+)', js, re.M)).items() if c > 1}
if dups:
    bad.append('defined more than once (the later one wins): %s' % dups)

# A scope error -- a name outliving the block it was declared in -- needs a
# real parser to see, and the two attempts at a regex for it flagged arrow
# functions and words inside template literals. That one is caught by opening
# the page, which is the last step regardless.

ids_have = set(re.findall(r'\bid=([\w-]+)', html)) | set(re.findall(r'id="([^"]+)"', html))
ids_used = set(re.findall(r"\$\('#([\w-]+)'\)", js))
gone = sorted(ids_used - ids_have - {'cboth', 'running', 'running-d', 'cdigital', 'cphoto'})
if gone:
    bad.append('no such element: %s' % gone)

routes = set(re.findall(r'@app\.(?:get|post)\("([^"]+)"', py))
hit = {'/' + u.split('?')[0].lstrip('/')
       for u in re.findall(r"(?:get|post)\(`?'?(/[\w/]+)", js)}
lost = sorted(hit - routes)
if lost:
    bad.append('no such route: %s' % lost)

for b in bad:
    print('  ' + b)
print('front end: %s' % ('CLEAN' if not bad else '%d problem(s)' % len(bad)))
sys.exit(1 if bad else 0)
