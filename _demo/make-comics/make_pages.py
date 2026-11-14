#!/usr/bin/env python3
"""Writes the pages of three fake comics as HTML (one SVG per page), for a
headless browser to render. Everything is drawn from shapes: no real
characters, no borrowed art. Output: pages/<comic>/NN.html"""
import html
import os
import random
import sys

W, H = 1000, 1500
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pages')

THEMES = {
    'kestrel-bay': {
        'title': 'Lanterns of Kestrel Bay', 'number': 1, 'kind': 'harbour',
        'sky': ['#1d2b53', '#7e2553', '#ff9e5e'], 'ink': '#14121c',
        'accent': '#ffcf6b', 'paper': '#f6efe2',
        'lines': ['The lanterns are late tonight.', 'Fog off the point. Again.',
                  'Someone has to row out.', 'You hear that? A bell.',
                  'Keep the light burning.', 'She never misses a tide.',
                  'Hand me the oars.', 'Look - on the water!',
                  'Every lantern, all at once.', 'Home before the turn.'],
    },
    'orbit-post': {
        'title': 'Orbit Postal Service', 'number': 3, 'kind': 'space',
        'sky': ['#05030f', '#1b0f3a', '#3b1f6b'], 'ink': '#0b0a14',
        'accent': '#8be9fd', 'paper': '#eef0f7',
        'lines': ['Parcel for Ring Seven.', 'Signed, sealed, in orbit.',
                  'Thrusters at forty percent.', 'That is not on the map.',
                  'Hold still, little moon.', 'Delivery confirmed!',
                  'Who orders soup to an asteroid?', 'Check the manifest.',
                  'Two minutes to the window.', 'Smooth as stardust.'],
    },
    'quiet-forest': {
        'title': 'The Quiet Forest', 'number': 2, 'kind': 'forest',
        'sky': ['#0f2a1d', '#2e6b45', '#cfe8a9'], 'ink': '#10170f',
        'accent': '#f4e285', 'paper': '#f3f6ea',
        'lines': ['Shh. Listen.', 'The path was here yesterday.',
                  'Fireflies know the way.', 'Older than the village.',
                  'Did that tree just move?', 'Leave the gate open.',
                  'Moss on the north side.', 'We are not lost. Mostly.',
                  'Lights in the hollow.', 'Follow the song.'],
    },
}

LAYOUTS = [
    [(0, 0, 1, .34), (0, .34, .5, .33), (.5, .34, .5, .33), (0, .67, 1, .33)],
    [(0, 0, .58, .5), (.58, 0, .42, .5), (0, .5, .42, .5), (.42, .5, .58, .5)],
    [(0, 0, 1, .5), (0, .5, .33, .5), (.33, .5, .34, .5), (.67, .5, .33, .5)],
    [(0, 0, 1, .25), (0, .25, 1, .5), (0, .75, .5, .25), (.5, .75, .5, .25)],
    [(0, 0, .5, .33), (.5, 0, .5, .33), (0, .33, 1, .34), (0, .67, .5, .33), (.5, .67, .5, .33)],
]


def grad(gid, colours, vertical=True):
    stops = ''.join(f'<stop offset="{i / (len(colours) - 1):.2f}" stop-color="{c}"/>'
                    for i, c in enumerate(colours))
    xy = 'x1="0" y1="0" x2="0" y2="1"' if vertical else 'x1="0" y1="0" x2="1" y2="0"'
    return f'<linearGradient id="{gid}" {xy}>{stops}</linearGradient>'


def figure(x, y, s, colour, ink, rnd):
    """A simple character: body, head, an arm; facing left or right."""
    face = rnd.choice([-1, 1])
    return (f'<g stroke="{ink}" stroke-width="{max(2, s * .06):.1f}" stroke-linejoin="round">'
            f'<path d="M{x - s * .32},{y} Q{x},{y - s * 1.25} {x + s * .32},{y} Z" fill="{colour}"/>'
            f'<circle cx="{x}" cy="{y - s * 1.05}" r="{s * .26}" fill="#f2d3b3"/>'
            f'<circle cx="{x + face * s * .1}" cy="{y - s * 1.08}" r="{s * .035}" fill="{ink}"/>'
            f'<path d="M{x + face * s * .15},{y - s * .62} l{face * s * .35},{-s * .22}" fill="none"/>'
            f'</g>')


def scene(theme, w, h, rnd, gid):
    kind, ink = theme['kind'], theme['ink']
    parts = [f'<defs>{grad(gid, theme["sky"])}'
             f'<radialGradient id="{gid}g"><stop offset="0" stop-color="{theme["accent"]}" stop-opacity=".9"/>'
             f'<stop offset="1" stop-color="{theme["accent"]}" stop-opacity="0"/></radialGradient></defs>',
             f'<rect width="{w}" height="{h}" fill="url(#{gid})"/>']
    if kind == 'harbour':
        sea = h * rnd.uniform(.55, .7)
        parts.append(f'<circle cx="{w * rnd.uniform(.15, .85)}" cy="{sea - h * .08}" r="{h * .16}" fill="#ffd38a" opacity=".75"/>')
        parts.append(f'<rect y="{sea}" width="{w}" height="{h - sea}" fill="#163a5c"/>')
        for i in range(6):
            yy = sea + (h - sea) * (i + .5) / 6
            parts.append(f'<path d="M0,{yy} q{w / 8},-8 {w / 4},0 t{w / 4},0 t{w / 4},0 t{w / 4},0" '
                         f'stroke="#5fa8d3" stroke-width="2" fill="none" opacity=".5"/>')
        lx = w * rnd.choice([.12, .85])
        parts.append(f'<path d="M{lx - 22},{sea} L{lx - 12},{sea - h * .42} L{lx + 12},{sea - h * .42} L{lx + 22},{sea} Z" fill="#e9e1d1" stroke="{ink}" stroke-width="3"/>')
        parts.append(f'<circle cx="{lx}" cy="{sea - h * .45}" r="{h * .12}" fill="url(#{gid}g)"/>')
        for _ in range(rnd.randint(1, 3)):
            bx, bs = w * rnd.uniform(.25, .75), rnd.uniform(.6, 1.2)
            parts.append(f'<g stroke="{ink}" stroke-width="3"><path d="M{bx - 60 * bs},{sea + 6} h{120 * bs} l-{20 * bs},{26 * bs} h-{80 * bs} Z" fill="#7a3b2e"/>'
                         f'<path d="M{bx},{sea + 4} v-{110 * bs}" /><path d="M{bx + 4},{sea - 100 * bs} l{55 * bs},{90 * bs} h-{55 * bs} Z" fill="#f6efe2"/></g>')
        for _ in range(rnd.randint(4, 9)):
            cx, cy = w * rnd.random(), sea * rnd.uniform(.2, .9)
            parts.append(f'<circle cx="{cx}" cy="{cy}" r="{rnd.uniform(14, 30)}" fill="url(#{gid}g)"/>'
                         f'<rect x="{cx - 5}" y="{cy - 7}" width="10" height="14" rx="3" fill="{theme["accent"]}" stroke="{ink}" stroke-width="2"/>')
        ground = sea
    elif kind == 'space':
        for _ in range(int(w * h / 1800)):
            parts.append(f'<circle cx="{w * rnd.random():.0f}" cy="{h * rnd.random():.0f}" r="{rnd.choice([.8, 1.2, 1.8])}" fill="#fff" opacity="{rnd.uniform(.4, 1):.2f}"/>')
        px, py, pr = w * rnd.uniform(.2, .8), h * rnd.uniform(.25, .7), min(w, h) * rnd.uniform(.18, .32)
        pc = rnd.choice(['#ff7a90', '#ffb86c', '#50fa7b', '#bd93f9'])
        parts.append(f'<circle cx="{px}" cy="{py}" r="{pr}" fill="{pc}" stroke="{ink}" stroke-width="4"/>'
                     f'<path d="M{px - pr * .9},{py - pr * .2} q{pr * .9},{pr * .5} {pr * 1.8},0" stroke="{ink}" stroke-width="3" fill="none" opacity=".4"/>'
                     f'<ellipse cx="{px}" cy="{py}" rx="{pr * 1.6}" ry="{pr * .35}" fill="none" stroke="#f1fa8c" stroke-width="6" transform="rotate(-15 {px} {py})"/>')
        sx, sy = w * rnd.uniform(.2, .8), h * rnd.uniform(.2, .8)
        parts.append(f'<g transform="rotate({rnd.uniform(-25, 25):.0f} {sx} {sy})" stroke="{ink}" stroke-width="4">'
                     f'<path d="M{sx - 90},{sy + 22} l-30,26 h40 Z" fill="#ff5555"/><path d="M{sx - 90},{sy - 22} l-30,-26 h40 Z" fill="#ff5555"/>'
                     f'<rect x="{sx - 100}" y="{sy - 26}" width="170" height="52" rx="26" fill="#e6e6f0"/>'
                     f'<circle cx="{sx + 30}" cy="{sy}" r="14" fill="#8be9fd"/>'
                     f'<path d="M{sx - 100},{sy} l-50,-8 l0,16 Z" fill="#ffb86c" stroke="none"/></g>')
        ground = h * .98
    else:
        for layer, colour in enumerate(['#1f4d33', '#163a27', '#0e2a1c']):
            base = h * (.55 + layer * .15)
            for _ in range(9 + layer * 3):
                tx, th = w * rnd.uniform(-.05, 1.05), h * rnd.uniform(.25, .45)
                parts.append(f'<path d="M{tx - th * .28},{base} L{tx},{base - th} L{tx + th * .28},{base} Z" fill="{colour}" stroke="{ink}" stroke-width="2"/>')
            parts.append(f'<rect y="{base - 2}" width="{w}" height="{h - base + 2}" fill="{colour}"/>')
        parts.append(f'<path d="M{w * .45},{h} Q{w * .55},{h * .8} {w * .5},{h * .7}" stroke="#c9b37a" stroke-width="{w * .08}" fill="none" opacity=".7"/>')
        for _ in range(rnd.randint(8, 18)):
            parts.append(f'<circle cx="{w * rnd.random():.0f}" cy="{h * rnd.uniform(.2, .85):.0f}" r="{rnd.uniform(10, 22):.0f}" fill="url(#{gid}g)"/>'
                         f'<circle cx="{w * rnd.random():.0f}" cy="{h * rnd.uniform(.2, .85):.0f}" r="3" fill="{theme["accent"]}"/>')
        ground = h * .92
    if rnd.random() < .7:
        for i in range(rnd.randint(1, 2)):
            s = min(w, h) * rnd.uniform(.18, .28)
            parts.append(figure(w * rnd.uniform(.2, .8), min(ground, h * .95), s,
                                rnd.choice(['#e94f37', '#3f88c5', '#f6ae2d', '#7d5ba6', '#44bba4']), ink, rnd))
    return ''.join(parts)


def bubble(text, w, h, rnd, ink):
    words, lines, line = text.split(), [], ''
    # About 19 px a character, in bold capitals at 25 px.
    per_line = max(8, min(16, int((w - 80) / 19)))
    for word in words:
        if len(line) + len(word) + 1 > per_line:
            lines.append(line)
            line = word
        else:
            line = f'{line} {word}'.strip()
    lines.append(line)
    bw = min(max(len(l) for l in lines) * 19 + 48, w - 28)
    bh = len(lines) * 32 + 30
    bx = rnd.uniform(14, max(15, w - bw - 14))
    by = rnd.uniform(14, max(15, h * .3 - bh))
    tx = bx + bw * rnd.uniform(.25, .75)
    text_svg = ''.join(f'<text x="{bx + bw / 2}" y="{by + 38 + i * 32}" text-anchor="middle" '
                       f'font-family="DejaVu Sans" font-weight="bold" font-size="25" fill="{ink}">'
                       f'{html.escape(l.upper())}</text>' for i, l in enumerate(lines))
    return (f'<path d="M{tx - 14},{by + bh - 4} L{tx + 6},{by + bh + 34} L{tx + 18},{by + bh - 4} Z" fill="#fff" stroke="{ink}" stroke-width="3"/>'
            f'<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="{bh / 2.2}" fill="#fff" stroke="{ink}" stroke-width="3"/>'
            f'<rect x="{tx - 12}" y="{by + bh - 6}" width="28" height="8" fill="#fff"/>' + text_svg)


def page(theme, number, rnd):
    margin, gutter = 36, 18
    layout = LAYOUTS[(number + theme['number']) % len(LAYOUTS)]
    body = [f'<rect width="{W}" height="{H}" fill="{theme["paper"]}"/>']
    said = rnd.sample(theme['lines'], len(layout))
    iw, ih = W - 2 * margin, H - 2 * margin - 40
    for i, (x, y, pw, ph) in enumerate(layout):
        px, py = margin + x * iw + gutter / 2, margin + y * ih + gutter / 2
        w, h = pw * iw - gutter, ph * ih - gutter
        gid = f'g{number}_{i}'
        inner = scene(theme, w, h, rnd, gid)
        if rnd.random() < .75:
            inner += bubble(said[i], w, h, rnd, theme['ink'])
        body.append(f'<svg x="{px}" y="{py}" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{inner}</svg>'
                    f'<rect x="{px}" y="{py}" width="{w}" height="{h}" fill="none" stroke="{theme["ink"]}" stroke-width="6"/>')
    body.append(f'<text x="{W / 2}" y="{H - 34}" text-anchor="middle" font-family="DejaVu Serif" '
                f'font-size="22" fill="{theme["ink"]}">{number}</text>')
    return ''.join(body)


def cover(theme, rnd):
    art = scene(theme, W, H, rnd, 'cover')
    title = theme['title'].upper().split(' ')
    half = (len(title) + 1) // 2
    rows = [' '.join(title[:half]), ' '.join(title[half:])]
    text = ''.join(f'<text x="{W / 2}" y="{170 + i * 112}" text-anchor="middle" font-family="DejaVu Serif" '
                   f'font-weight="bold" font-size="96" fill="{theme["paper"]}" stroke="{theme["ink"]}" '
                   f'stroke-width="5" paint-order="stroke">{html.escape(r)}</text>' for i, r in enumerate(rows) if r)
    badge = (f'<circle cx="{W - 110}" cy="{H - 120}" r="70" fill="{theme["accent"]}" stroke="{theme["ink"]}" stroke-width="5"/>'
             f'<text x="{W - 110}" y="{H - 100}" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" '
             f'font-size="60" fill="{theme["ink"]}">#{theme["number"]}</text>')
    tag = (f'<text x="60" y="{H - 60}" font-family="DejaVu Sans" font-weight="bold" font-size="30" '
           f'fill="{theme["paper"]}" letter-spacing="6">A DEMO COMIC</text>')
    return art + f'<rect width="{W}" height="{H}" fill="none" stroke="{theme["ink"]}" stroke-width="24"/>' + text + badge + tag


def spread(theme, rnd):
    """One wide page (a double-page spread): a single panorama with a caption."""
    sw = W * 2
    art = scene(theme, sw - 80, H - 80, rnd, 'spread')
    cap = (f'<rect x="80" y="80" width="560" height="96" fill="{theme["paper"]}" stroke="{theme["ink"]}" stroke-width="4"/>'
           f'<text x="104" y="140" font-family="DejaVu Serif" font-style="italic" font-size="34" fill="{theme["ink"]}">'
           f'{html.escape(rnd.choice(theme["lines"]))}</text>')
    return (f'<rect width="{sw}" height="{H}" fill="{theme["paper"]}"/>'
            f'<svg x="40" y="40" width="{sw - 80}" height="{H - 80}" viewBox="0 0 {sw - 80} {H - 80}">{art}</svg>'
            f'<rect x="40" y="40" width="{sw - 80}" height="{H - 80}" fill="none" stroke="{theme["ink"]}" stroke-width="6"/>' + cap), sw


def write(directory, name, svg, width=W):
    with open(os.path.join(directory, name), 'w') as handle:
        handle.write(f'<!doctype html><html><body style="margin:0;background:#fff">'
                     f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{H}" '
                     f'viewBox="0 0 {width} {H}">{svg}</svg></body></html>')


def main():
    pages = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    for slug, theme in THEMES.items():
        rnd = random.Random(slug)
        directory = os.path.join(OUT, slug)
        os.makedirs(directory, exist_ok=True)
        write(directory, '00.html', cover(theme, rnd))
        for number in range(1, pages):
            if number == 4:
                svg, width = spread(theme, rnd)
                write(directory, f'{number:02d}.html', svg, width)
            else:
                write(directory, f'{number:02d}.html', page(theme, number, rnd))
        print(slug, pages, 'pages')


if __name__ == '__main__':
    main()
