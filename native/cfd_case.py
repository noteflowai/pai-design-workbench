"""OpenFOAM case for an Ahmed-type body: half model, k-omega SST, steady simpleFoam, drag from forceCoeffs.

    python3 cfd_case.py --stl body.stl --out CASE --level 3|4 --speed 40 [--iterations 600]

Writes a complete case directory (blockMesh, surfaceFeatureExtract, snappyHexMesh, simpleFoam) for OpenFOAM v2512
(openfoam.com). The run itself happens in the pinned OpenCFD image (native/cfd_run.sh). Geometry in metres with
the nose at x = 0, ground at z = 0 and the body symmetric about y = 0; only y >= 0 is meshed (symmetry plane).
Reference area for Cd is the full frontal area divided by two (half model).
"""
import argparse
import json
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--stl", required=True)
p.add_argument("--out", required=True)
p.add_argument("--level", type=int, default=3)
p.add_argument("--speed", type=float, default=40.0)
p.add_argument("--iterations", type=int, default=1200)
p.add_argument("--frontal-area", type=float, required=True, help="full-body frontal area, m2")
p.add_argument("--length", type=float, required=True)
p.add_argument("--processors", type=int, default=4)
p.add_argument("--layers", type=int, default=0, help="experimental: prism layers on the body (0 = none; reviews use 0, see docs/AERO.md)")
a = p.parse_args()
case = Path(a.out)
for d in ("system", "constant/triSurface", "0"):
    (case / d).mkdir(parents=True, exist_ok=True)
(case / "constant/triSurface/body.stl").write_bytes(Path(a.stl).read_bytes())
U = a.speed
H = lambda cls, obj, loc=None: ("FoamFile\n{\n    version 2.0;\n    format ascii;\n    class " + cls + ";\n" + (f"    location \"{loc}\";\n" if loc else "")
                                + "    object " + obj + ";\n}\n")


def w(rel, text):
    (case / rel).write_text(text)


# Domain: 2 L upstream, 5 L downstream, 3 W to the side, 5 H high (blockage < 2 % for the half model).
x0, x1, y1, z1 = -2.0, 6.0, 1.2, 1.5
cells = (80, 12, 15)  # 0.1 m background cells; surface level L gives 0.1 / 2^L
w("system/blockMeshDict", H("dictionary", "blockMeshDict") + f"""
vertices ( ({x0} 0 0) ({x1} 0 0) ({x1} {y1} 0) ({x0} {y1} 0) ({x0} 0 {z1}) ({x1} 0 {z1}) ({x1} {y1} {z1}) ({x0} {y1} {z1}) );
blocks ( hex (0 1 2 3 4 5 6 7) ({cells[0]} {cells[1]} {cells[2]}) simpleGrading (1 1 1) );
boundary
(
    inlet    {{ type patch; faces ((0 4 7 3)); }}
    outlet   {{ type patch; faces ((1 2 6 5)); }}
    ground   {{ type wall; faces ((0 3 2 1)); }}
    top      {{ type symmetryPlane; faces ((4 5 6 7)); }}
    side     {{ type symmetryPlane; faces ((3 7 6 2)); }}
    symmetry {{ type symmetryPlane; faces ((0 1 5 4)); }}
);
""")
w("system/surfaceFeatureExtractDict", H("dictionary", "surfaceFeatureExtractDict") + """
body.stl { extractionMethod extractFromSurface; includedAngle 150; subsetFeatures { nonManifoldEdges no; openEdges yes; } writeObj no; }
""")
L = a.level
w("system/snappyHexMeshDict", H("dictionary", "snappyHexMeshDict") + f"""
castellatedMesh true; snap true; addLayers {"true" if a.layers else "false"};
geometry
{{
    body.stl {{ type triSurfaceMesh; name body; }}
    wake {{ type box; min (-0.3 0 0); max (2.6 0.45 0.55); }}
    near {{ type box; min (-0.15 0 0); max (1.5 0.30 0.42); }}
}}
castellatedMeshControls
{{
    maxLocalCells 4000000; maxGlobalCells 8000000; minRefinementCells 0; maxLoadUnbalance 0.10; nCellsBetweenLevels 3;
    features ( {{ file "body.eMesh"; level {L + 1}; }} );
    refinementSurfaces {{ body {{ level ({L} {L + 1}); patchInfo {{ type wall; }} }} }}
    resolveFeatureAngle 30;
    refinementRegions {{ wake {{ mode inside; levels ((1E15 {L - 2})); }} near {{ mode inside; levels ((1E15 {L - 1})); }} }}
    locationInMesh (-1.5 0.9 1.2);
    allowFreeStandingZoneFaces true;
}}
snapControls {{ nSmoothPatch 3; tolerance 2.0; nSolveIter 50; nRelaxIter 5; nFeatureSnapIter 10; implicitFeatureSnap false; explicitFeatureSnap true; multiRegionFeatureSnap false; }}
addLayersControls {{ relativeSizes true; layers {{ {"body { nSurfaceLayers %d; }" % a.layers if a.layers else ""} }}; expansionRatio 1.2; finalLayerThickness 0.5; minThickness 0.1; nGrow 0; featureAngle 60; nRelaxIter 3;
    nSmoothSurfaceNormals 1; nSmoothNormals 3; nSmoothThickness 10; maxFaceThicknessRatio 0.5; maxThicknessToMedialRatio 0.3; minMedialAxisAngle 90; nBufferCellsNoExtrude 0; nLayerIter 50; }}
meshQualityControls {{ #includeEtc "caseDicts/meshQualityDict" nSmoothScale 4; errorReduction 0.75; }}
mergeTolerance 1e-6;
""")
w("system/decomposeParDict", H("dictionary", "decomposeParDict") + f"numberOfSubdomains {a.processors};\nmethod scotch;\n")
w("system/controlDict", H("dictionary", "controlDict") + f"""
application simpleFoam; startFrom latestTime; startTime 0; stopAt endTime; endTime {a.iterations}; deltaT 1;
writeControl timeStep; writeInterval {a.iterations}; purgeWrite 1; writeFormat binary; writePrecision 8; timeFormat general; timePrecision 6; runTimeModifiable false;
functions
{{
    forceCoeffs
    {{
        type forceCoeffs; libs (forces); writeControl timeStep; writeInterval 1; log false;
        patches (body); rho rhoInf; rhoInf 1.225; CofR (0 0 0); liftDir (0 0 1); dragDir (1 0 0); pitchAxis (0 1 0);
        magUInf {U}; lRef {a.length}; Aref {a.frontal_area / 2};
    }}
    residuals {{ type solverInfo; libs (utilityFunctionObjects); fields (p U k omega); writeResidualFields no; }}
}}
""")
w("system/fvSchemes", H("dictionary", "fvSchemes") + """
ddtSchemes { default steadyState; }
gradSchemes { default Gauss linear; grad(U) cellLimited Gauss linear 1; }
divSchemes { default none; div(phi,U) bounded Gauss linearUpwind grad(U); div(phi,k) bounded Gauss upwind; div(phi,omega) bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear; }
laplacianSchemes { default Gauss linear limited corrected 0.33; }
interpolationSchemes { default linear; }
snGradSchemes { default limited corrected 0.33; }
wallDist { method meshWave; }
""")
w("system/fvSolution", H("dictionary", "fvSolution") + """
solvers
{
    p { solver GAMG; smoother GaussSeidel; tolerance 1e-7; relTol 0.1; }
    "(U|k|omega)" { solver smoothSolver; smoother GaussSeidel; nSweeps 2; tolerance 1e-8; relTol 0.1; }
}
SIMPLE { nNonOrthogonalCorrectors 0; consistent yes; residualControl { p 1e-4; U 1e-5; "(k|omega)" 1e-5; } }
relaxationFactors { equations { U 0.9; "(k|omega)" 0.7; } fields { p 1; } }
""")
w("constant/transportProperties", H("dictionary", "transportProperties") + "transportModel Newtonian;\nnu 1.5e-05;\n")
w("constant/turbulenceProperties", H("dictionary", "turbulenceProperties") + "simulationType RAS;\nRAS { RASModel kOmegaSST; turbulence on; printCoeffs off; }\n")
# Inlet turbulence: 0.5 % intensity, length scale 0.1 L (wind-tunnel conditions).
k = 1.5 * (0.005 * U) ** 2
omega = k ** 0.5 / (0.09 ** 0.25 * 0.1 * a.length)
sym = "    top { type symmetryPlane; }\n    side { type symmetryPlane; }\n    symmetry { type symmetryPlane; }\n"


def field(name, cls, dim, internal, inlet, outlet, wall_ground, wall_body):
    w(f"0/{name}", H(cls, name, "0") + f"dimensions {dim};\ninternalField uniform {internal};\nboundaryField\n{{\n    inlet {{ {inlet} }}\n    outlet {{ {outlet} }}\n"
      f"    ground {{ {wall_ground} }}\n    body {{ {wall_body} }}\n{sym}}}\n")


field("U", "volVectorField", "[0 1 -1 0 0 0 0]", f"({U} 0 0)", f"type fixedValue; value uniform ({U} 0 0);", "type inletOutlet; inletValue uniform (0 0 0); value $internalField;",
      f"type movingWallVelocity; value uniform ({U} 0 0);", "type noSlip;")  # rolling road
field("p", "volScalarField", "[0 2 -2 0 0 0 0]", "0", "type zeroGradient;", "type fixedValue; value uniform 0;", "type zeroGradient;", "type zeroGradient;")
field("k", "volScalarField", "[0 2 -2 0 0 0 0]", k, f"type fixedValue; value uniform {k};", "type inletOutlet; inletValue $internalField; value $internalField;",
      f"type kqRWallFunction; value uniform {k};", f"type kqRWallFunction; value uniform {k};")
field("omega", "volScalarField", "[0 0 -1 0 0 0 0]", omega, f"type fixedValue; value uniform {omega};", "type inletOutlet; inletValue $internalField; value $internalField;",
      f"type omegaWallFunction; value uniform {omega};", f"type omegaWallFunction; value uniform {omega};")
field("nut", "volScalarField", "[0 2 -1 0 0 0 0]", "0", "type calculated; value uniform 0;", "type calculated; value uniform 0;",
      "type nutkWallFunction; value uniform 0;", "type nutkWallFunction; value uniform 0;")
(case / "case.json").write_text(json.dumps({"level": L, "speedMs": U, "iterations": a.iterations, "frontalAreaM2": a.frontal_area, "lengthM": a.length,
                                            "turbulence": "kOmegaSST", "layers": a.layers, "half": True, "processors": a.processors}, indent=2))
