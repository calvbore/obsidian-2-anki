#!/usr/bin/env python3
"""One-shot: set Anki theme to DARK in _global profile (meta).

Usage: python3 scripts/patch-anki-night-mode.py [path/to/prefs21.db]

Default path: tests/defaults/test_config/.local/share/Anki2default/prefs21.db

Anki 2.1.60+ reads theme from _global profile (meta), not User 1 profile.
Theme enum: FOLLOW_SYSTEM=0 (default), LIGHT=1, DARK=2.
"""
import sqlite3
import pickle
import sys

DEFAULT_PATH = "tests/defaults/test_config/.local/share/Anki2default/prefs21.db"

path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH

db = sqlite3.connect(path)

# Patch _global profile (meta) - this is what pm.theme() reads
row = db.execute("SELECT data FROM profiles WHERE name='_global'").fetchone()
global_prof = pickle.loads(row[0])
global_prof['theme'] = 2  # Theme.DARK = 2 — controls full UI dark mode
db.execute("UPDATE profiles SET data=? WHERE name='_global'", (pickle.dumps(global_prof),))

# Also patch User 1 profile for legacy night_mode (harmless)
row = db.execute("SELECT data FROM profiles WHERE name='User 1'").fetchone()
user_prof = pickle.loads(row[0])
user_prof['night_mode'] = True  # legacy (ignored by 2.1.60+ but harmless)
user_prof['theme'] = 2          # also set here for completeness
db.execute("UPDATE profiles SET data=? WHERE name='User 1'", (pickle.dumps(user_prof),))

db.commit()
db.close()
print(f"Done — dark theme enabled in {path}")
