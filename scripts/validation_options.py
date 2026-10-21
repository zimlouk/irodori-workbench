"""Explicit targets and evidence locations for optional live acceptance scripts."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'backend/src'))
from irodori_workbench.settings import load_settings


def parser_for(description, folder):
    settings = load_settings()
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument('--url', default=settings.url)
    parser.add_argument('--evidence-dir', type=Path, default=settings.data_dir/folder)
    parser.add_argument('--allow-real-inference', action='store_true', help='Explicitly allow real GPU generation')
    return parser


def require_generation(parser, args):
    if not args.allow_real_inference:
        parser.error('Real inference is disabled; pass --allow-real-inference to run this acceptance test')
