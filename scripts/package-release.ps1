<#
.SYNOPSIS
    Package the Ling Gao 校对员 plugin release.

.DESCRIPTION
    Thin PowerShell wrapper around `scripts/release.mjs` (the cross-platform
    implementation). It rebuilds lib/, validates the package, then writes

        release/LGProofreader-<version>.zip
        release/LGProofreader-<version>.tgz
        release/SHA256SUMS.txt

    `pnpm release` is the preferred entry point; this wrapper exists for the
    documented Windows release command. Node.js >= 24 must be available.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1
#>
$ErrorActionPreference = 'Stop'

$node = if ($env:DSH_NODE) { $env:DSH_NODE } else { 'node' }
$script = Join-Path $PSScriptRoot 'release.mjs'

if (-not (Test-Path -LiteralPath $script)) {
    throw "release script not found: $script"
}

& $node $script
exit $LASTEXITCODE
