"""Deterministic text preparation and identity-aware editor reconciliation.

The editor never reparses manually supplied script. Source updates perform a
three-way merge against the last machine text; ambiguous settings stay explicit.
"""
from copy import deepcopy
from difflib import SequenceMatcher
import re
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field
from typing import Literal


class Processing(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["article", "lines", "passthrough"] = "lines"
    limit: int = Field(default=120, ge=1, le=4096)
    short: int = Field(default=20, ge=0, le=120)
    merge_short: bool = True
    persistent_rules: str = Field(default="", max_length=20000)
    temporary_rules: str = Field(default="", max_length=20000)
    include_double: bool = False


def replacement_rules(value):
    result = []
    for i, line in enumerate(value.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        sep = "->" if "->" in line else ":" if ":" in line else None
        if sep is None:
            raise ValueError(f"替换规则第{i}行需要 old -> new")
        old, new = line.split(sep, 1)
        if not old.strip():
            raise ValueError("替换原词不能为空")
        result.append((old.strip(), new.strip()))
    return result


def split_text(text, limit):
    pieces = []
    while len(text) > limit:
        cut = 0
        for marks in ("。！？!?", "、，,；; "):
            candidates = [i + 1 for i, c in enumerate(text[:limit]) if c in marks and i + 1 >= limit // 3]
            if candidates:
                cut = candidates[-1]
                break
        cut = cut or limit
        pieces.append(text[:cut])
        text = text[cut:]
    if text:
        pieces.append(text)
    return pieces


def prepare(source: str, options: dict):
    opt = Processing.model_validate(options)
    if opt.mode == "passthrough":
        # Preserve caller text, including internal newlines; no dictionary or normalization.
        return ([source] if source.strip() else []), []
    warnings, entries = [], []
    if opt.mode == "lines":
        pos = 0
        for line in source.splitlines(keepends=True):
            if line.strip():
                entries.append((pos, pos + len(line.rstrip('\r\n')), line.strip()))
            pos += len(line)
    else:
        pairs, stack, start = {"「": "」", "『": "』"}, [], 0
        for pos, char in enumerate(source):
            if char in pairs:
                if not stack:
                    start = pos
                stack.append(char)
            elif char in pairs.values():
                if not stack or pairs[stack[-1]] != char:
                    warnings.append(f"位置{pos + 1}引号不匹配")
                    continue
                stack.pop()
                if not stack and (source[start] == "「" or opt.include_double):
                    text = source[start + 1:pos].replace('\r', '').replace('\n', ' ')
                    if text.strip():
                        entries.append((start, pos + 1, text))
        if stack:
            warnings.append("存在未闭合引号，未提取该段")
    rules = replacement_rules(opt.persistent_rules) + replacement_rules(opt.temporary_rules)
    groups = []
    for start, end, text in entries:
        for old, new in rules:
            text = text.replace(old, new)
        if not text.strip():
            warnings.append("替换后的空台词已排除")
            continue
        gap = source[groups[-1][1]:start] if groups else ""
        if (groups and opt.merge_short and not gap.strip() and gap.count('\n') <= 1
                and min(len(groups[-1][2]), len(text)) < opt.short
                and len(groups[-1][2]) + len(text) <= opt.limit):
            groups[-1] = (groups[-1][0], end, groups[-1][2] + text)
        else:
            groups.append((start, end, text))
    result = [piece for _, _, text in groups for piece in split_text(text, opt.limit)]
    if len(result) > 500 or any(len(t) > 4096 for t in result):
        raise ValueError("最多500句，每句最多4096字")
    return result, warnings


def new_segment(text, overrides=None):
    return {"id": str(uuid4()), "text": text, "machine_text": text,
            "overrides": deepcopy(overrides or {}), "input_revision": 1,
            "selected_job_id": None, "auto_select_job_id": None,
            "output_path": None, "output_sha256": None, "output_error": None}


def reconcile(previous, texts, source_update=False):
    """Match exact moved lines first, then scoped replacements. Never match by global row number."""
    old = deepcopy(previous)
    match_text = [(s.get("machine_text", s["text"]) if source_update else s["text"]) for s in old]
    matcher = SequenceMatcher(a=match_text, b=texts, autojunk=False)
    result, used, conflicts, extra = [None] * len(texts), set(), [], {}
    # Exact matching also recognizes moved lines that SequenceMatcher calls delete/insert.
    pool = {}
    for i, text in enumerate(match_text):
        pool.setdefault(text, []).append(i)
    for j, text in enumerate(texts):
        if pool.get(text):
            i = pool[text].pop(0)
            used.add(i)
            result[j] = old[i]
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        slots = [j for j in range(j1, j2) if result[j] is None]
        candidates = [i for i in range(i1, i2) if i not in used]
        if not slots:
            continue
        if (source_update and candidates and len(candidates) != len(slots)
                and any(old[i]['text'] != old[i].get('machine_text', old[i]['text']) for i in candidates)):
            # Keep the whole corrected group until the user accepts re-segmentation.
            group = [old[i] for i in candidates]
            result[slots[0]] = group[0]
            extra[slots[0]] = group[1:]
            used.update(candidates)
            conflicts.append({'id': str(uuid4()), 'kind': 'source', 'segment_ids': [s['id'] for s in group],
                              'before': '\n'.join(s['text'] for s in group), 'after': '\n'.join(texts[j] for j in slots)})
            continue
        for offset, j in enumerate(slots):
            # Split inherits source settings. Merge retains candidates for explicit choice.
            i = candidates[min(offset, len(candidates) - 1)] if candidates else None
            prior = deepcopy(old[i]) if i is not None else None
            s = prior if prior and offset < len(candidates) else new_segment(texts[j], prior["overrides"] if prior else {})
            if i is not None:
                used.add(i)
            if source_update and prior and prior["text"] != prior.get("machine_text", prior["text"]):
                conflicts.append({"id": str(uuid4()), "kind": "source", "segment_ids": [s["id"]],
                                  "before": prior["text"], "after": texts[j]})
                s["text"] = prior["text"]
            else:
                s["text"] = texts[j]
            s["machine_text"] = texts[j] if source_update or prior is None else prior.get('machine_text', prior['text'])
            result[j] = s
        if len(candidates) > len(slots):
            choices = [old[i] for i in candidates]
            if len({repr(s["overrides"]) for s in choices}) > 1:
                conflicts.append({"id": str(uuid4()), "kind": "overrides", "segment_ids": [result[slots[0]]["id"]],
                    "before": '\n'.join(s["text"] for s in choices), "after": texts[slots[0]],
                    "choices": [{"segment_id": s["id"], "text": s["text"], "overrides": s["overrides"]} for s in choices]})
    result = [item for j, segment in enumerate(result) if segment is not None
              for item in [segment, *extra.get(j, [])]]
    removed = [s for s in old if s["id"] not in {s["id"] for s in result}]
    if source_update:
        # A machine deletion must not discard a manual correction.
        for s in removed[:]:
            if s["text"] != s.get("machine_text", s["text"]):
                result.append(s)
                removed.remove(s)
                conflicts.append({"id": str(uuid4()), "kind": "source", "segment_ids": [s["id"]],
                                  "before": s["text"], "after": ""})
    return result, conflicts, removed
