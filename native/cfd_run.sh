#!/bin/bash
# Run one prepared case inside the pinned OpenCFD image (OpenFOAM v2512): mesh, check, solve in parallel.
#   docker run --rm --network none -v CASE:/case <image> bash /case/run.sh   (this file is copied in as run.sh)
# The OpenFOAM environment script is not errexit/nounset-safe: source it first, then turn strict mode on.
source /usr/lib/openfoam/openfoam2512/etc/bashrc
set -euo pipefail
cd "${PAI_CASE:-/case}"
N=$(foamDictionary -entry numberOfSubdomains -value system/decomposeParDict)
log() { "$@" > "log.$1" 2>&1 || { echo "FAILED $1"; tail -20 "log.$1"; exit 1; }; }
log surfaceFeatureExtract
log blockMesh
log snappyHexMesh -overwrite
log checkMesh -constant
log decomposePar -force
mpirun --allow-run-as-root --oversubscribe -np "$N" simpleFoam -parallel > log.simpleFoam 2>&1 || { echo "FAILED simpleFoam"; tail -20 log.simpleFoam; exit 1; }
log reconstructPar -latestTime
foamVersion="${WM_PROJECT_VERSION:-unknown}"
echo "{\"openfoam\": \"$foamVersion\", \"cells\": $(grep -m1 -E '^\s+cells:' log.checkMesh | grep -oE '[0-9]+'), \"meshOk\": $(grep -q 'Mesh OK' log.checkMesh && echo true || echo false)}" > run.json
cat run.json
