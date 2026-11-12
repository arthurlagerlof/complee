"""Writes demo/autocad-sample.dxf: a small two-deck general arrangement in the layer convention of public/autocad.html.

The file is written with ezdxf in the AutoCAD 2010 DXF format (handles, tables, blocks with attributes), i.e. the
structure AutoCAD itself writes. All values are fictional. Three findings are planted:
  - main deck corridor drawn 850 mm wide (below 900 mm),
  - weathertight door with a 300 mm sill (below 380 mm),
  - guard rail 950 mm high (below 1000 mm).
Run from shipcheck/:  python tools/autocad/make_sample.py
"""
from pathlib import Path

import ezdxf
from ezdxf import units

OUT = Path(__file__).resolve().parents[2] / "demo" / "autocad-sample.dxf"
doc = ezdxf.new("R2010", setup=True)
doc.units = units.MM
doc.header["$MEASUREMENT"] = 1
msp = doc.modelspace()

COLORS = {"OUTLINE": 7, "CORRIDOR": 4, "SPACE": 8, "DOOR": 6, "STAIR": 5, "MUSTER": 3, "RAIL": 2}
for deck in ("MD", "01"):
    for kind, color in COLORS.items():
        doc.layers.add(f"{deck}-{kind}", color=color)
doc.layers.add("COMPLEE-SHIP", color=7)
doc.layers.add("DIMENSIONS", color=1)

# Blocks: a door (leaf + swing) and a guard-rail segment, both with attributes.
door = doc.blocks.new("DOOR_WT")
door.add_lwpolyline([(0, 0), (100, 0), (100, 900), (0, 900)], close=True)
door.add_arc(center=(100, 0), radius=900, start_angle=0, end_angle=90)
for tag, y in (("ID", 0), ("NAME", -150), ("WEATHERTIGHT", -300), ("SILL_HEIGHT", -450), ("CLEAR_WIDTH", -600)):
    door.add_attdef(tag, insert=(150, y), dxfattribs={"height": 100})
rail = doc.blocks.new("GUARD_RAIL")
rail.add_lwpolyline([(0, 0), (100, 0), (100, 1000), (0, 1000)], close=True)
for tag, y in (("NAME", 0), ("HEIGHT", -150)):
    rail.add_attdef(tag, insert=(150, y), dxfattribs={"height": 100})


def rect(layer, x0, y0, x1, y1, oy=0.0, text=None, thickness=None):
    attribs = {"layer": layer}
    if thickness:
        attribs["thickness"] = thickness
    msp.add_lwpolyline([(x0, y0 + oy), (x1, y0 + oy), (x1, y1 + oy), (x0, y1 + oy)], close=True, dxfattribs=attribs)
    if text:
        msp.add_mtext(text, dxfattribs={"layer": layer, "char_height": 180}).set_location(((x0 + x1) / 2 - 400, (y0 + y1) / 2 + oy))


# ---- main deck, drawn at the drawing origin ----
msp.add_lwpolyline([(0, -4000), (26000, -4000), (30000, 0), (26000, 4000), (0, 4000)], close=True, dxfattribs={"layer": "MD-OUTLINE"})
msp.add_point((0, 0), dxfattribs={"layer": "MD-OUTLINE"})
msp.add_mtext("NAME=Main deck\\PELEVATION=0\\PHEIGHT=2700", dxfattribs={"layer": "MD-OUTLINE", "char_height": 200}).set_location((1000, -4600))
rect("MD-MUSTER", 0, -3000, 6000, 3000, text="Muster station\\PCAPACITY=12\\PZONE=open_deck")
rect("MD-CORRIDOR", 6000, -425, 24000, 425, text="Main deck corridor\\PZONE=circulation")
rect("MD-CORRIDOR", 12000, 425, 13200, 4000, text="Cross corridor\\PZONE=circulation\\PCLEAR_WIDTH=1100mm")
rect("MD-SPACE", 14000, 425, 20000, 4000, text="Mess")
rect("MD-SPACE", 14000, -4000, 20000, -425, text="Workshop")
rect("MD-SPACE", 20000, 425, 24000, 4000, text="Store")
rect("MD-STAIR", 24000, -1250, 26500, 1250, text="Main stair\\PCLEAR_WIDTH=1000mm", thickness=2700)
msp.add_blockref("DOOR_WT", (5950, -450), dxfattribs={"layer": "MD-DOOR"}).add_auto_attribs(
    {"ID": "MD-D1", "NAME": "Weathertight door to the working deck", "WEATHERTIGHT": "YES", "SILL_HEIGHT": "300mm", "CLEAR_WIDTH": "800mm"})

# ---- 01 level, drawn 20 m above the main deck on the sheet; its reference origin is the POINT ----
OY = 20000.0
msp.add_lwpolyline([(8000, -3500 + OY), (28000, -3500 + OY), (28000, 3500 + OY), (8000, 3500 + OY)], close=True, dxfattribs={"layer": "01-OUTLINE"})
msp.add_point((0, OY), dxfattribs={"layer": "01-OUTLINE"})
msp.add_mtext("NAME=01 level\\PELEVATION=2700\\PHEIGHT=2500", dxfattribs={"layer": "01-OUTLINE", "char_height": 200}).set_location((9000, OY - 4100))
rect("01-CORRIDOR", 14000, -500, 24000, 500, OY, text="01 level corridor\\PZONE=circulation")
rect("01-SPACE", 14000, 500, 19000, 3500, OY, text="Cabin 1")
rect("01-SPACE", 19000, 500, 24000, 3500, OY, text="Cabin 2")
rect("01-SPACE", 14000, -3500, 24000, -500, OY, text="Wheelhouse")
rect("01-STAIR", 24000, -1250, 26500, 1250, OY, text="Stair landing\\PCLEAR_WIDTH=1000mm", thickness=100)
msp.add_blockref("GUARD_RAIL", (8000, -3500 + OY), dxfattribs={"layer": "01-RAIL", "yscale": 7.0}).add_auto_attribs(
    {"NAME": "Guard rail, 01 level aft", "HEIGHT": "950mm"})

msp.add_mtext("NAME=Sample workboat\\PTYPE=research\\PLENGTH_OVERALL=30m\\PBEAM=8m\\PCLASS_SOCIETY=DNV\\PBERTHS=12",
              dxfattribs={"layer": "COMPLEE-SHIP", "char_height": 250}).set_location((0, -7000))
# Outside the convention: reported as not imported.
msp.add_line((0, -5500), (30000, -5500), dxfattribs={"layer": "DIMENSIONS"})
msp.add_text("30000", dxfattribs={"layer": "DIMENSIONS", "height": 250}).set_placement((14000, -5400))

OUT.parent.mkdir(parents=True, exist_ok=True)
doc.saveas(OUT)
print(f"{OUT} written ({OUT.stat().st_size} bytes)")
