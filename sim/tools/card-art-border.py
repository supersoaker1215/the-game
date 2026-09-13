#!/usr/bin/env python3
# =============================================================================
# CARD ART BORDER — one card's border, sampled from its own painting
# =============================================================================
#   python3 sim/tools/card-art-border.py
#
# Companion to card-art-accent.py, which GENERATES the whole set. This one is
# for the cards where the owner names a colour — "carnage red", "raven purple",
# "optimus blue" — and the answer has to come from that card's art rather than
# from a canned red/purple/blue. Owner: "when i say green blue red etc i want
# you to match the color in their art to the border, not a generic color".
#
# WHY THE GENERATOR'S OWN TRANSFORM IS NOT USED. gen.neon() keeps ONLY the hue
# and forces saturation ~0.86 and lightness ~0.62. That is right for a set-wide
# sweep and wrong here: at 348 deg it returns hot pink for Carnage's crimson, at
# 153 deg mint for the Power Battery's green. Averaging the paint instead goes
# the other way and reads as dirt on black, which neon()'s own note warns about.
#
# So: the card's hue, as much of the paint's own saturation as legibility
# allows, and a floor on each — below s 0.60 a hue stops reading AS that colour
# (the Goblin's suit measures 0.42 and lands olive), below luma 125 a line on
# black stops reading as lit. Measured, not chosen.
#
# Output is pasted into CARD_ART_ACCENT_OVERRIDE in card-art-manifest.js, and
# every value is checked against its painting on a proof sheet before it ships.
# =============================================================================
import importlib.util, colorsys, os, re, io
spec=importlib.util.spec_from_file_location('gen','sim/tools/card-art-accent.py')
gen=importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)
from PIL import Image
ART='audio/cards/art'

MAN=io.open('card-art-manifest.js',encoding='utf-8').read()
def default_variant(name):
    m=re.search(r"'"+re.escape(name)+r"':\s*\[([^\]]*)\]", MAN)
    if m:
        first=re.findall(r"'([^']+)'", m.group(1))
        if first: return first[0]
    return name+'.png'

FAM={'red':(345,15),'orange':(15,45),'yellow':(45,72),'green':(75,168),
     'blue':(180,258),'purple':(258,320)}

def in_band(d, lo, hi):
    return (d>=lo or d<=hi) if lo>hi else (lo<=d<=hi)

def sample(path, fam):
    """The most SATURATED instance of that family, by chroma-weighted area.
    Weighting by s*s (not s) is what stops a bright bloom — which desaturates
    toward white and drifts cyan — from outvoting the real pigment under it."""
    im=Image.open(path).convert('RGB'); im.thumbnail((240,240))
    px=list(im.getdata())
    if fam=='white':
        # the brightest NEUTRAL cluster, keeping the tint it actually has
        best=None
        acc=[0.0,0.0,0.0,0.0]
        for (r,g,b) in px:
            h,s,v=colorsys.rgb_to_hsv(r/255.,g/255.,b/255.)
            if s>0.22 or v<0.55: continue
            w=v*v
            acc[0]+=r*w; acc[1]+=g*w; acc[2]+=b*w; acc[3]+=w
        if acc[3]<=0: return None,0,None
        rgb=tuple(int(round(acc[i]/acc[3])) for i in range(3))
        # lift to a border-bright near-white while keeping its tint
        mx=max(rgb) or 1
        lift=min(2.2, 245.0/mx)
        rgb=tuple(min(255,int(round(c*lift))) for c in rgb)
        return None, round(100*acc[3]/len(px),1), rgb
    lo,hi=FAM[fam]
    BINS=120; hist=[0.0]*BINS; n=0
    for (r,g,b) in px:
        h,s,v=colorsys.rgb_to_hsv(r/255.,g/255.,b/255.)
        if s<0.18 or v<0.12: continue
        d=h*360
        if not in_band(d,lo,hi): continue
        window=1.0-abs(v-0.58)*1.1
        if window<=0: continue
        hist[int(h*BINS)%BINS]+= s*s*window
        n+=1
    if n==0: return None,0,None
    sm=[hist[(i-1)%BINS]*0.5+hist[i]+hist[(i+1)%BINS]*0.5 for i in range(BINS)]
    best=max(range(BINS), key=lambda i: sm[i])
    a,b_,c=sm[(best-1)%BINS],sm[best],sm[(best+1)%BINS]
    den=(a-2*b_+c); off=0.0 if den==0 else max(-0.5,min(0.5,0.5*(a-c)/den))
    deg=(((best+0.5+off)/BINS)%1.0)*360
    return deg, round(100*n/len(px),1), gen.neon(deg/360.0, 0.14)

JOBS=[('Power Stone','purple'),('Fear Toxin','orange'),('Mind Stone','yellow'),
      ("Joker's Playing Card",'purple'),('Jango Fett','blue'),('Carnage','red'),
      ('Green Goblin','green'),('Optimus Prime','blue'),('Raven','purple'),
      ('The Grinch','green'),('Art the Clown','white'),('Captain America','white'),
      # re-derive last round's clamped greens with the same sampler
      ('Lex Luthor','green'),('Power Battery','green'),('Time Stone','green')]
if __name__=='__main__':
    for name,fam in JOBS:
        f=default_variant(name); p=os.path.join(ART,f)
        if not os.path.exists(p): print('%-22s MISSING %s'%(name,f)); continue
        deg,pct,rgb=sample(p,fam)
        if rgb is None: print('%-22s no %s in %s'%(name,fam,f)); continue
        print('%-22s %-24s %-7s %6s  %5s%%  -> %s' %
              (name, f, fam, ('%.1f'%deg) if deg is not None else 'neutral', pct, str(rgb)))

def art_match(path, fam):
    """The art's own colour, lifted only as far as legibility needs.
    gen.neon() keeps ONLY the hue and forces saturation ~0.86 / lightness ~0.62 —
    which is why a 348deg crimson comes back hot pink and a 153deg green comes
    back mint. Owner: "match the color in their art to the border, not a generic
    color". So: take the weighted mean of the family's own pixels, keep its hue
    AND its saturation, and raise the VALUE only until it clears a luma floor on
    black."""
    im=Image.open(path).convert('RGB'); im.thumbnail((240,240))
    px=list(im.getdata())
    if fam=='white':
        return sample(path,fam)[2]
    lo,hi=FAM[fam]
    acc=[0.0,0.0,0.0,0.0]
    for (r,g,b) in px:
        h,s,v=colorsys.rgb_to_hsv(r/255.,g/255.,b/255.)
        if s<0.18 or v<0.12: continue
        d=h*360
        if not in_band(d,lo,hi): continue
        w=1.0-abs(v-0.58)*1.1
        if w<=0: continue
        w*= s*s
        acc[0]+=r*w; acc[1]+=g*w; acc[2]+=b*w; acc[3]+=w
    if acc[3]<=0: return None
    r,g,b=[acc[i]/acc[3] for i in range(3)]
    h,s,v=colorsys.rgb_to_hsv(r/255.,g/255.,b/255.)
    # Legibility on black: raise value (and only value) until Rec.709 luma clears
    # the same floor sim/art-accent.js holds every border to.
    for _ in range(60):
        rr,gg,bb=colorsys.hsv_to_rgb(h,s,v)
        luma=0.2126*rr*255+0.7152*gg*255+0.0722*bb*255
        if luma>=118 or v>=1.0: break
        v=min(1.0, v+0.02)
    rr,gg,bb=colorsys.hsv_to_rgb(h,s,v)
    return (int(round(rr*255)),int(round(gg*255)),int(round(bb*255)))

def art_vivid(path, fam, pct_keep=0.25):
    """The card's colour as a person would name it: the VIVID instances of the
    family, not the average of every shadowed pixel in it.
    The mean is what made Green Goblin olive — his suit is one bright green
    among a lot of dark ones, and averaging buries it. Keeping the top quartile
    by saturation*value picks the pigment the eye actually reads, then the same
    luma floor makes it legible on black."""
    im=Image.open(path).convert('RGB'); im.thumbnail((240,240))
    px=list(im.getdata())
    if fam=='white':
        return sample(path,fam)[2]
    lo,hi=FAM[fam]
    cand=[]
    for (r,g,b) in px:
        h,s,v=colorsys.rgb_to_hsv(r/255.,g/255.,b/255.)
        if s<0.18 or v<0.12: continue
        d=h*360
        if not in_band(d,lo,hi): continue
        cand.append((s*v,r,g,b))
    if not cand: return None
    cand.sort(reverse=True)
    keep=cand[:max(1,int(len(cand)*pct_keep))]
    r=sum(c[1] for c in keep)/len(keep)
    g=sum(c[2] for c in keep)/len(keep)
    b=sum(c[3] for c in keep)/len(keep)
    h,s,v=colorsys.rgb_to_hsv(r/255.,g/255.,b/255.)
    s=min(1.0, s*1.15)                     # a touch past the paint, for a lit line
    for _ in range(80):
        rr,gg,bb=colorsys.hsv_to_rgb(h,s,v)
        luma=0.2126*rr*255+0.7152*gg*255+0.0722*bb*255
        if luma>=125 or v>=1.0: break
        v=min(1.0, v+0.02)
    rr,gg,bb=colorsys.hsv_to_rgb(h,s,v)
    return (int(round(rr*255)),int(round(gg*255)),int(round(bb*255)))

def border_for(path, fam):
    """FINAL: the card's own colour, made into a lit line.
    Hue and as much of the paint's own saturation as legibility allows, with a
    floor on each. gen.neon() keeps ONLY the hue and slams saturation to ~0.86
    and lightness to ~0.62 — which is why 348deg came back hot pink and 153deg
    mint. Averaging the paint instead goes the other way and reads as dirt on
    black (neon's own note says so). The floors are what make the middle work:
    below s 0.60 a hue stops reading AS that colour (the Goblin's suit measures
    s 0.42 and lands olive), and below luma 125 a line on black stops reading as
    lit at all."""
    if fam=='white': return sample(path,fam)[2]
    lo,hi=FAM[fam]
    im=Image.open(path).convert('RGB'); im.thumbnail((240,240))
    cand=[]
    for (r,g,b) in list(im.getdata()):
        h,s,v=colorsys.rgb_to_hsv(r/255.,g/255.,b/255.)
        if s<0.20 or v<0.25 or v>0.97: continue
        d=h*360
        if not in_band(d,lo,hi): continue
        cand.append((s*v,r,g,b))
    if not cand: return None
    cand.sort(reverse=True)
    k=cand[:max(1,int(len(cand)*0.25))]
    r=sum(c[1] for c in k)/len(k); g=sum(c[2] for c in k)/len(k); b=sum(c[3] for c in k)/len(k)
    h,s,v=colorsys.rgb_to_hsv(r/255.,g/255.,b/255.)
    s=max(0.60, min(1.0, s*1.10))
    for _ in range(80):
        rr,gg,bb=colorsys.hsv_to_rgb(h,s,v)
        if 0.2126*rr*255+0.7152*gg*255+0.0722*bb*255>=125 or v>=1.0: break
        v=min(1.0,v+0.02)
    rr,gg,bb=colorsys.hsv_to_rgb(h,s,v)
    return (int(round(rr*255)),int(round(gg*255)),int(round(bb*255)))
