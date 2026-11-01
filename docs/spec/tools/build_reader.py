"""Generate a standalone, offline HTML reading view from the specification."""
import html
import json
import re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DOCS=[ROOT/'README.md']+sorted(ROOT.glob('[0-9][0-9]-*.md'))
IDS={p.name:('overview' if p.name=='README.md' else 'chapter-'+p.name[:2]) for p in DOCS}

def heading_slug(title):
    return re.sub('[^a-z0-9]+','-',title.lower()).strip('-')

def heading_ids(text):
    ids=set();in_code=False
    for line in text.splitlines():
        if line.startswith('```'):in_code=not in_code;continue
        match=re.match(r'^#{1,6} (.+)$',line)
        if match and not in_code:
            slug=heading_slug(match[1])
            while slug in ids:slug+='-x'
            ids.add(slug)
    return ids

def revision_metadata(root=ROOT):
    revision=re.search(r'^Revision ([0-9.]+) · ([^·\n]+?)(?: ·[^\n]*)?$', (root/'README.md').read_text(), re.M)
    changelog=re.search(r'^## ([0-9.]+) — (.+)$', (root/'CHANGELOG.md').read_text(), re.M)
    if not revision or not changelog or revision.groups()!=changelog.groups():
        raise ValueError('README revision/date must match the first CHANGELOG release heading')
    return revision.groups()

def inline(value,section_id=None):
    tokens=[]
    def keep(markup):
        tokens.append(markup); return '\x00'+str(len(tokens)-1)+'\x00'
    value=re.sub(r'`([^`]+)`',lambda m:keep('<code>'+html.escape(m[1])+'</code>'),value)
    def link(m):
        label,target=m.groups()
        if target.startswith(('javascript:','data:')):return label
        name,separator,fragment=target.partition('#')
        if name in IDS: target='#'+IDS[name]+('-'+fragment if separator else '')
        elif target.startswith('#') and section_id: target='#'+section_id+'-'+fragment
        elif target.startswith('../'): target=target[3:]
        elif not target.startswith(('https://','http://','#','/')): target='implementation/'+target
        extra=' target="_blank" rel="noopener noreferrer"' if target.startswith('http') else ''
        return keep('<a href="'+html.escape(target,quote=True)+'"'+extra+'>'+html.escape(label)+'</a>')
    value=re.sub(r'\[([^\]]+)\]\(([^)]+)\)',link,value)
    value=html.escape(value)
    value=re.sub(r'\*\*(.+?)\*\*',r'<strong>\1</strong>',value)
    value=re.sub(r'(?<![*\w])\*([^*\s][^*]*?)\*(?![*\w])',r'<em>\1</em>',value)
    return re.sub('\x00(\d+)\x00',lambda m:tokens[int(m[1])],value)

def render(text,section_id):
    lines=text.splitlines(); out=[]; i=0; heading_ids=set()
    def rich(value):return inline(value,section_id)
    def list_item(line):return re.match(r'^(\s*)(- |\d+\. )(.*)',line)
    def render_list(start):
        first=list_item(lines[start]);indent=len(first[1]);ordered=first[2]!='- '
        tag='ol' if ordered else 'ul';number=int(first[2][:-2]) if ordered else 1
        opening='<'+tag+(f' start="{number}"' if ordered and number!=1 else '')+'>'
        items=[];pos=start
        while pos<len(lines):
            item=list_item(lines[pos])
            if not item or len(item[1])!=indent or (item[2]!='- ')!=ordered:break
            body=[rich(item[3])];pos+=1
            while pos<len(lines):
                following=pos
                while following<len(lines) and not lines[following].strip():following+=1
                if following==len(lines):pos=following;break
                nested=list_item(lines[following])
                if nested and len(nested[1])>indent:
                    markup,pos=render_list(following);body.append(markup);continue
                if nested or len(lines[following])-len(lines[following].lstrip())<=indent:
                    pos=following;break
                paragraph=[];pos=following
                while pos<len(lines) and lines[pos].strip() and not list_item(lines[pos]) and len(lines[pos])-len(lines[pos].lstrip())>indent:
                    paragraph.append(lines[pos].strip());pos+=1
                body.append('<p>'+rich(' '.join(paragraph))+'</p>')
            items.append('<li>'+''.join(body)+'</li>')
        return opening+''.join(items)+'</'+tag+'>',pos
    while i<len(lines):
        line=lines[i]
        if not line.strip() or line.startswith('<!--'): i+=1; continue
        if line.startswith('```'):
            lang=line[3:].strip(); code=[];i+=1
            while i<len(lines) and not lines[i].startswith('```'):code.append(lines[i]);i+=1
            out.append('<pre><code data-language="'+html.escape(lang)+'">'+html.escape('\n'.join(code))+'</code></pre>');i+=1;continue
        if line.startswith('|'):
            rows=[]
            while i<len(lines) and lines[i].startswith('|'):
                raw=lines[i].strip().strip('|');cells=[c.strip() for c in raw.split('|')]
                if not all(re.fullmatch(r'[-: ]+',c or '-') for c in cells):rows.append(cells)
                i+=1
            out.append('<div class="table-scroll"><table><thead><tr>'+''.join('<th scope="col">'+rich(c)+'</th>' for c in rows[0])+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+rich(c)+'</td>' for c in row)+'</tr>' for row in rows[1:])+'</tbody></table></div>');continue
        match=re.match(r'^(#{1,6}) (.+)$',line)
        if match:
            level=min(6,len(match[1])+1);title=match[2]
            slug=section_id+'-'+heading_slug(title)
            while slug in heading_ids:slug+='-x'
            heading_ids.add(slug)
            out.append(f'<h{level} id="{slug}">'+rich(title)+f'</h{level}>');i+=1;continue
        if list_item(line):
            markup,i=render_list(i);out.append(markup);continue
        para=[line];i+=1
        while i<len(lines) and lines[i].strip() and not list_item(lines[i]) and not re.match(r'^(#|\||```|<!--)',lines[i]):para.append(lines[i]);i+=1
        out.append('<p>'+rich(' '.join(para))+'</p>')
    return '\n'.join(out)

def main():
    revision,date=revision_metadata()
    sections=[];nav=[];words=0
    for p in DOCS:
        text=p.read_text();words+=len(text.split());sid=IDS[p.name]
        title=text.splitlines()[0].lstrip('# ').strip()
        label='Start here' if sid=='overview' else title
        nav.append('<a href="#'+sid+'">'+html.escape(label)+'</a>')
        sections.append('<section class="chapter" id="'+sid+'" data-title="'+html.escape(title,quote=True)+'"><a class="source" href="implementation/'+p.name+'">Markdown source ↗</a>'+render(text,sid)+'</section>')
    page='''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Detailed implementation specification for a Temporal software factory, with contracts, work packages and acceptance scenarios."><title>Software Factory — Implementation Specification</title>
<style>
:root{--paper:#f6f4ee;--white:#fffefa;--ink:#182b35;--muted:#56676d;--line:#d4dad5;--blue:#294bbb;--nav:#192f39;--wash:#e9eefc}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;color:var(--ink);background:var(--paper);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--blue);text-underline-offset:3px}button,input{font:inherit}button,a,input{outline-offset:4px}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #cc9d25}aside{position:fixed;inset:0 auto 0 0;width:290px;background:var(--nav);color:#f4f6ec;padding:30px 22px;overflow:auto}aside .brand{color:inherit;font-size:16px;letter-spacing:.05em;text-decoration:none}aside .sub{font-size:12px;color:#b5c7cb;margin:7px 0 22px}nav{display:grid;gap:4px}nav a{color:#d3dfe0;text-decoration:none;font-size:12px;line-height:1.45;padding:9px 10px;border-radius:5px}nav a:hover,nav a[aria-current="location"]{background:#e0e9b0;color:#182b35}main{margin-left:290px;max-width:1600px;padding:35px 65px 70px}.topbar{display:flex;justify-content:space-between;gap:15px;flex-wrap:wrap;font-size:12px;padding-bottom:22px;border-bottom:1px solid var(--line)}.hero{padding:45px 0 28px}h1{font:clamp(38px,4.5vw,64px)/1.07 Georgia,serif;letter-spacing:-.04em;margin:10px 0 22px;max-width:850px}h1 em{color:var(--blue);font-weight:400}.lede{font-size:17px;color:var(--muted);max-width:850px}.eyebrow{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--blue);font-weight:700}.facts{display:flex;flex-wrap:wrap;gap:10px 25px;font-size:13px;margin-top:25px}.facts strong{color:var(--blue)}.actions{display:flex;flex-wrap:wrap;gap:10px;margin:25px 0}.button{display:inline-flex;align-items:center;min-height:42px;padding:9px 14px;border:1px solid var(--line);border-radius:6px;color:var(--ink);background:var(--white);font-size:13px;cursor:pointer;text-decoration:none}.button.primary{background:var(--ink);color:white;border-color:var(--ink)}.search{padding:20px 0;border-block:1px solid var(--line);display:flex;align-items:center;gap:12px;flex-wrap:wrap}.search label{font-size:13px;font-weight:600}.search input{min-width:0;max-width:460px;flex:1;padding:11px;border:1px solid #abbab2;background:var(--white);border-radius:5px}.search output{font-size:12px;color:var(--muted)}.chapter{padding:43px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.chapter[hidden]{display:none}.chapter h2{font:36px/1.15 Georgia,serif;letter-spacing:-.035em;margin:8px 0 24px}.chapter h3{font-size:22px;line-height:1.3;margin:32px 0 14px;letter-spacing:-.02em}.chapter h4{font-size:17px;line-height:1.4;margin:24px 0 12px}.chapter p{margin:13px 0;max-width:1000px}.chapter ul,.chapter ol{padding-left:24px;max-width:1000px}.chapter li{margin:7px 0}.source{font-size:11px;color:var(--muted);display:inline-block;margin-bottom:8px}.table-scroll{max-width:100%;overflow-x:auto;margin:20px 0;border:1px solid var(--line);border-radius:8px;background:var(--white)}table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.6;text-align:left}th{background:#ecefe7;color:var(--ink);padding:12px 14px;font-size:11px}td{border-top:1px solid var(--line);padding:12px 14px;vertical-align:top;min-width:125px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#203740;color:#deebea;padding:22px;border-radius:8px;font:12px/1.7 ui-monospace,SFMono-Regular,monospace}code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.87em}p code,li code,td code{background:#e5eae2;border-radius:3px;padding:2px 4px}pre code{font-size:inherit}.notice{border-left:3px solid var(--blue);background:var(--wash);padding:15px 19px;font-size:13px;max-width:1000px}.empty{padding:28px 0;color:var(--muted)}footer{font-size:12px;color:var(--muted);padding-top:28px}.skip{position:absolute;top:-60px;left:10px;background:white;padding:10px;z-index:2}.skip:focus{top:10px}
@media(max-width:1050px){aside{width:240px;padding:25px 15px}main{margin-left:240px;padding:28px 30px 50px}.chapter h2{font-size:32px}}
@media(max-width:760px){aside{position:static;width:auto;padding:22px}aside .sub{margin-bottom:12px}nav{grid-template-columns:1fr 1fr}nav a{font-size:11px;padding:6px}main{margin:0;padding:25px 20px 45px}.hero{padding:30px 0 24px}.chapter{padding:32px 0}.chapter h2{font-size:30px}.chapter h3{font-size:21px}h1{font-size:42px}.search input{flex-basis:100%;max-width:none;font-size:16px}td{min-width:140px}.lede{font-size:15px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{aside,.topbar,.search,.actions,.source,.skip,.empty{display:none!important}main{margin:0;padding:0;max-width:none}body{font-size:10pt;background:white;color:black}.hero{padding:0 0 20px}h1{font-size:36pt}.chapter{display:block!important;padding:22px 0}.chapter h2{font-size:23pt}.chapter h3{font-size:15pt;break-after:avoid}.chapter h4{font-size:12pt;break-after:avoid}table{font-size:8pt}.table-scroll{overflow:visible}tr{break-inside:avoid}pre{font-size:9pt;background:#eee;color:black;break-inside:avoid}a{color:inherit}.notice{background:#eee}footer{font-size:9pt}}
</style></head><body>
<a class="skip" href="#content">Skip navigation</a>
<aside><a class="brand" href="#top">THE SOFTWARE FACTORY</a><div class="sub">Implementation specification · vREVISION<br>REVDATE</div><nav aria-label="Specification chapters">NAV</nav></aside>
<main id="content"><div class="topbar"><a href="index.html">← Architecture field guide</a><span>Reference design · contracts · delivery backlog</span></div>
<header class="hero" id="top"><span class="eyebrow">From architecture to implementation</span><h1>The complete build plan.<br><em>Decisions to acceptance.</em></h1><p class="lede">A detailed specification for the vendor-neutral software factory: what to build, how components communicate, how failures recover, and the evidence required to ship.</p><div class="facts"><span><strong>3</strong> primary journeys</span><span><strong>8</strong> work types</span><span><strong>PACKAGES_COUNT</strong> work packages</span><span><strong>ACCEPTANCE_COUNT</strong> acceptance scenarios</span><span><strong>TABLES_COUNT</strong> reference tables</span><span><strong>WORDS</strong> words of specification</span></div><div class="actions"><a class="button primary" href="plan-review.html">Explore the plan review</a><a class="button" href="#chapter-21">Rules &amp; role content</a><a class="button" href="#chapter-20">Review changes and decisions</a><a class="button" href="#chapter-19">Read peer sign-off requirements</a><a class="button" href="#chapter-18">Greenfield interview</a><a class="button" href="#chapter-17">Compare the three journeys</a><a class="button" href="#chapter-14">Read the build sequence</a><a class="button" href="implementation/README.md">Open source specification</a><a class="button" href="implementation-package.zip">Download complete package</a><button class="button" type="button" id="print">Print full specification</button></div><p class="notice">This is an implementation specification, not a deployed service. Internal behavior and defaults are defined; organization-specific provider bindings are listed explicitly. Contract validation here does not substitute for the product acceptance tests in the plan.</p></header>
<div class="search"><label for="search">Find a topic</label><input id="search" type="search" placeholder="Try checkpoint, migration, approval, performance…"><button class="button" type="button" id="clear">Show all</button><output id="matches" aria-live="polite">All chapters shown</output></div><p class="empty" id="empty" hidden>No chapters match. Try a broader term.</p>
SECTIONS
<footer>Self-contained offline reader. Markdown and contract files are the editable specification sources. <a href="#top">Back to top ↑</a></footer></main>
<script>
(function(){'use strict';const input=document.getElementById('search'),chapters=Array.from(document.querySelectorAll('.chapter')),links=Array.from(document.querySelectorAll('nav a')),output=document.getElementById('matches');const texts=chapters.map(c=>c.textContent.toLowerCase());function filter(){const q=input.value.trim().toLowerCase();let count=0;chapters.forEach(function(c,i){const match=!q||texts[i].includes(q);c.hidden=!match;if(match)count++;links[i].hidden=!match;});output.textContent=q?count+' of '+chapters.length+' chapters match':'All '+chapters.length+' chapters shown';document.getElementById('empty').hidden=count!==0;}input.addEventListener('input',filter);document.getElementById('clear').addEventListener('click',function(){input.value='';filter();});document.getElementById('print').addEventListener('click',function(){window.print();});document.addEventListener('click',function(event){const a=event.target.closest('a[href^="#"]');if(!a)return;const target=document.getElementById(a.getAttribute('href').slice(1));if(target&&target.hidden){input.value='';filter();}});filter();})();
</script></body></html>'''
    page=page.replace('REVISION',html.escape(revision)).replace('REVDATE',html.escape(date))
    page=page.replace('NAV','\n'.join(nav)).replace('WORDS',format(words,',')).replace('SECTIONS','\n'.join(sections))
    page=page.replace('PACKAGES_COUNT',str(len(json.loads((ROOT/'backlog.json').read_text())['packages']))).replace('ACCEPTANCE_COUNT',str(len(json.loads((ROOT/'acceptance.json').read_text())['scenarios']))).replace('TABLES_COUNT',str(len(re.findall(r'CREATE TABLE \w+', (ROOT/'contracts/schema.sql').read_text()))))
    (ROOT.parent/'implementation-plan.html').write_text(page)
    print(f'Built reader: {len(DOCS)} chapters, {words:,} words, {len(page):,} characters')

if __name__=='__main__':main()
