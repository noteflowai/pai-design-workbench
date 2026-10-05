import cadquery as cq

# 6202 pillow-block bearing housing, reference parameters. Units: mm.
# Frame: base bottom on z = 0; shaft axis parallel to Y through x = 0, z = AXIS_Z; the bearing seat
# (Ø35 H7 for the 6202 outer ring, 11 mm wide) opens on the +Y face and stops at a shoulder; base bolt
# holes are vertical (Z) on the X axis.
W, BD, T = 108.0, 36.0, 10.0      # base length, base depth, base thickness
D = 20.0                          # housing depth along the shaft
AXIS_Z = 30.0                     # required: shaft axis height
SEAT, SEAT_LEN = 35.012, 11.0     # bearing seat Ø (H7: 35.000-35.025) and length (bearing width B)
SHOULDER = 28.0                   # shoulder / shaft passage Ø (17 ... 31.8)
CROWN = 8.0                       # material above the seat
PITCH, M8 = 78.0, 9.0             # bolt pitch, M8 clearance (ISO 273)
GUSSET = 5.0

block_w = SEAT + 18.0
body = cq.Workplane("XY").box(W, BD, T, centered=(True, True, False))
body = body.union(cq.Workplane("XY").box(block_w, D, AXIS_Z + SEAT / 2 + CROWN, centered=(True, True, False)))
for s in (-1, 1):
    g = cq.Workplane("XZ").polyline([(s * block_w / 2, T), (s * (block_w / 2 + GUSSET), T), (s * block_w / 2, T + GUSSET)]).close().extrude(D / 2, both=True)
    body = body.union(g)
body = body.cut(cq.Workplane("XZ").workplane(offset=-D / 2).center(0, AXIS_Z).circle(SEAT / 2).extrude(SEAT_LEN))
body = body.cut(cq.Workplane("XZ").workplane(offset=D / 2).center(0, AXIS_Z).circle(SHOULDER / 2).extrude(-(D + 1)))
for x in (-PITCH / 2, PITCH / 2):
    body = body.cut(cq.Workplane("XY").center(x, 0).circle(M8 / 2).extrude(T))

result = body
