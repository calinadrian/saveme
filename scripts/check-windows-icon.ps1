param(
  [string]$Executable = "$PSScriptRoot\..\dist\ui-refresh\win-unpacked\SaveMe.exe",
  [string]$Output = "$PSScriptRoot\..\.tmp\windows-icon.png"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$saveMeIcon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $Executable))
$saveMeBitmap = $saveMeIcon.ToBitmap()
try {
  $tilePixels = 0
  $strokePixels = 0
  for ($y = 0; $y -lt $saveMeBitmap.Height; $y++) {
    for ($x = 0; $x -lt $saveMeBitmap.Width; $x++) {
      $pixel = $saveMeBitmap.GetPixel($x, $y)
      if ($pixel.A -gt 200 -and [Math]::Abs($pixel.R - 37) -lt 12 -and [Math]::Abs($pixel.G - 54) -lt 12 -and [Math]::Abs($pixel.B - 78) -lt 12) { $tilePixels++ }
      if ($pixel.A -gt 200 -and [Math]::Abs($pixel.R - 220) -lt 12 -and [Math]::Abs($pixel.G - 232) -lt 12 -and [Math]::Abs($pixel.B - 250) -lt 12) { $strokePixels++ }
    }
  }
  if ($tilePixels -lt 30 -or $strokePixels -lt 20) { throw 'The packaged executable does not expose the SaveMe archive icon to Windows.' }
  $saveMeBitmap.Save([IO.Path]::GetFullPath($Output))
  Write-Output "PASS: Windows extracts the SaveMe icon from $Executable ($tilePixels tile pixels, $strokePixels stroke pixels)."
} finally {
  $saveMeBitmap.Dispose()
  $saveMeIcon.Dispose()
}
