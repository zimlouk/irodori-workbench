"""Preset display order is independent of voice snapshots and inference versions."""
from hashlib import sha256
import re

from sqlalchemy import select

from .catalog import lora_catalog
from .settings import voice_profile
from .storage import Preset, Preference



def ordered_presets(session, settings):
    works = voice_profile().get('works', [])
    catalog = {i['id']:i for i in lora_catalog(settings)}
    ranks = {family:(w,c,work,name) for w,(work,chars) in enumerate(works) for c,(family,name) in enumerate(chars)}
    rows = list(session.scalars(select(Preset)))
    def rank(row):
        family = catalog.get(row.config.get('lora_id'),{}).get('family')
        if family in ranks:
            return ranks[family]
        name = re.sub(r'(?:_\d+|（\d+）)$','',row.voice_name)
        return next((r for r in ranks.values() if name == r[3]), (len(works),999,'其他',name))
    rows.sort(key=lambda p: (*rank(p)[:2],p.voice_name,p.name,p.id))
    pref = session.get(Preference,'preset-order')
    if pref:
        positions = {pid:i for i,pid in enumerate(pref.document.get('ids',[]))}
        rows.sort(key=lambda p: positions.get(p.id,len(positions)))
    return rows, {row.id:rank(row)[2] for row in rows}


def order_token(rows, preference):
    value = '|'.join(p.id for p in rows) + ':' + str(preference.revision if preference else 0)
    return sha256(value.encode()).hexdigest()[:24]
