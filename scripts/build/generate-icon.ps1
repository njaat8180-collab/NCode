$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$sourcePath = Join-Path $root 'public\ncode-logo-circle.png'
$buildPath = Join-Path $root 'build'
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "NCode circle logo is missing: $sourcePath"
}
New-Item -ItemType Directory -Path $buildPath -Force | Out-Null
$source = [System.Drawing.Bitmap]::FromFile($sourcePath)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = [System.Collections.Generic.List[byte[]]]::new()

try {
  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
      } finally { $graphics.Dispose() }

      $stream = [System.IO.MemoryStream]::new()
      try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $frames.Add($stream.ToArray())
      } finally { $stream.Dispose() }

      if ($size -eq 256) {
        $pngPath = Join-Path $buildPath 'icon.png'
        $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $bitmap.Save((Join-Path $buildPath 'icon-256.png'), [System.Drawing.Imaging.ImageFormat]::Png)
      }
    } finally { $bitmap.Dispose() }
  }

  $iconPath = Join-Path $buildPath 'icon.ico'
  $iconStream = [System.IO.File]::Create($iconPath)
  try {
    $writer = [System.IO.BinaryWriter]::new($iconStream)
    try {
      $writer.Write([UInt16]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]$sizes.Count)
      $offset = 6 + (16 * $sizes.Count)
      for ($i = 0; $i -lt $sizes.Count; $i++) {
        $size = $sizes[$i]
        $dimension = if ($size -ge 256) { [byte]0 } else { [byte]$size }
        $frame = $frames[$i]
        $writer.Write($dimension)
        $writer.Write($dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$frame.Length)
        $writer.Write([UInt32]$offset)
        $offset += $frame.Length
      }
      foreach ($frame in $frames) { $writer.Write($frame) }
    } finally { $writer.Dispose() }
  } finally { $iconStream.Dispose() }
} finally { $source.Dispose() }

Write-Output (ConvertTo-Json -Compress @{ status = 'PASS'; png = 'build/icon.png'; ico = 'build/icon.ico'; sizes = $sizes })
