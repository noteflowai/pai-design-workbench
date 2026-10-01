import cadquery as cq

# NEMA 17 motor-mount bracket, reference parameters. Units: mm.
# Frame: motor mounting face on y = 0 (motor body in y < 0), motor axis parallel to Y
# through x = 0, z = MOTOR_AXIS_Z; base flange bottom on z = 0 with vertical M5 holes.
T = 4.0                  # plate and flange thickness
W = 60.0                 # bracket width
D = 30.0                 # flange depth
H = T + 46.0             # mounting plate height
BORE = 22.5              # NEMA 17 pilot bore (≥ 22.2)
PITCH = 31.0             # NEMA 17 bolt square
M3, M5 = 3.4, 5.5        # clearance holes
RIB, RIB_LEG = 4.0, 20.0
MOTOR_AXIS_Z = T + 24.0  # required: motor axis height

base = cq.Workplane("XY").box(W, D, T, centered=(True, False, False))
plate = cq.Workplane("XY").box(W, T, H, centered=(True, False, False))
body = base.union(plate)
for x in (-W / 2, W / 2 - RIB):
    rib = cq.Workplane("YZ").polyline([(T, T), (T + RIB_LEG, T), (T, T + RIB_LEG)]).close().extrude(RIB)
    body = body.union(rib.translate((x, 0, 0)))
face = cq.Workplane("XZ")
body = body.cut(face.center(0, MOTOR_AXIS_Z).circle(BORE / 2).extrude(-T))
for dx in (-PITCH / 2, PITCH / 2):
    for dz in (-PITCH / 2, PITCH / 2):
        body = body.cut(face.center(dx, MOTOR_AXIS_Z + dz).circle(M3 / 2).extrude(-T))
for x in (-20.0, 20.0):
    body = body.cut(cq.Workplane("XY").center(x, T + (D - T) / 2).circle(M5 / 2).extrude(T))

result = body
