# Reads Windows' system media sessions (the "now playing" flyout) and streams the browser's
# current track as JSON lines on stdout. Commands arrive as JSON lines on stdin.
#   out: {"type":"state", ...}   every poll while something changes, and at least once a second;
#                                includes "sessions", every browser media session (one per tab),
#                                and "soundCloud": whether the session plays in a SoundCloud tab
#        {"type":"artwork", "key", "contentType", "base64"} when the track's artwork changes
#        {"type":"result", "command", "ok"} after a command
#   in:  {"command":"toggle"|"play"|"pause"|"next"|"previous"|"seek", "positionMs":123}
#        {"command":"select", "index":2}   follow that session; index -1 = automatic
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($operation, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
# PowerShell cannot bind WinRT streams to .NET overloads; call the bridge through reflection.
$asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

# Only browsers: SoundCloud plays in a tab. Desktop players (TIDAL, Spotify...) are ignored.
$browserPattern = '(?i)chrome|msedge|edge|firefox|brave|opera|whale|vivaldi|arc'

# Which session is SoundCloud? Media sessions carry no URL, so read the browser's tab strip
# (UI Automation): tab names are page titles plus state such as "- 오디오 재생" or "- 탭 콘텐츠 공유됨".
# Only yes/no leaves this script; tab titles are never written out.
$uiaReady = $false
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $uiaWindowCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Chrome_WidgetWin_1')
  $uiaTabCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  $uiaReady = $true
} catch { $uiaReady = $false }
$script:tabs = @()
$script:tabsReadAt = [DateTime]::MinValue
$script:soundCloudKeys = @{}

# Collapse runs of spaces so "A  -  B" in media metadata matches "A - B" in a tab name.
function Format-Compare([string]$text) { return (($text -replace '\s+', ' ').Trim()) }

# Tab names of browser windows only: editors built on the same toolkit (VS Code) also expose
# tabs, and a file called soundCloudPlayer.js is not a SoundCloud page.
$script:processNames = @{}
$browserProcessPattern = '(?i)^(chrome|msedge|firefox|brave|opera|whale|vivaldi|arc)$'
function Test-BrowserProcess([int]$processId) {
  if (-not $script:processNames.ContainsKey($processId)) {
    $name = ''
    try { $name = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }
    $script:processNames[$processId] = $name
  }
  return $script:processNames[$processId] -match $browserProcessPattern
}

function Update-BrowserTabs {
  if (-not $uiaReady) { return }
  if (([DateTime]::UtcNow - $script:tabsReadAt).TotalMilliseconds -lt 2000) { return }
  $script:tabsReadAt = [DateTime]::UtcNow
  $list = @()
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $uiaWindowCondition)) {
      if (-not (Test-BrowserProcess $window.Current.ProcessId)) { continue }
      foreach ($tab in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $uiaTabCondition)) {
        $name = [string]$tab.Current.Name
        $list += [pscustomobject]@{ name = (Format-Compare $name); soundCloud = ($name -match '(?i)soundcloud') }
      }
    }
    $script:tabs = $list
  } catch { }
}

# Is this media session playing on SoundCloud? Most sites put what is playing in the page title
# (a video, a live stream), so the tab carrying the session's title decides it: a SoundCloud
# page names itself, or, while a track plays, SoundCloud retitles the tab "<title> by <artist>"
# without its own name. A title that no tab shows, with a SoundCloud tab open, is SoundCloud too
# (a paused SoundCloud tab keeps its page title, "Liked tracks on SoundCloud"). The answer is
# kept per track, so a tab closing or renaming for a moment does not flip it.
function Test-SoundCloud($title, $artist, $status, $key) {
  if (-not $uiaReady) { return $false }
  $needle = Format-Compare $title
  if ($needle) {
    $showing = @($script:tabs | Where-Object { $_.name.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($showing.Count -gt 0) {
      $signature = if ($artist) { "$needle by $(Format-Compare $artist)" } else { $null }
      $isSoundCloud = @($showing | Where-Object {
        $_.soundCloud -or ($signature -and $_.name.IndexOf($signature, [StringComparison]::OrdinalIgnoreCase) -ge 0)
      }).Count -gt 0
      $script:soundCloudKeys[$key] = $isSoundCloud
      return $isSoundCloud
    }
  }
  if (@($script:tabs | Where-Object { $_.soundCloud }).Count -gt 0) {
    $script:soundCloudKeys[$key] = $true
    return $true
  }
  return [bool]$script:soundCloudKeys[$key]
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$pendingLine = $stdin.ReadLineAsync()

function Write-Line($object) {
  [Console]::Out.WriteLine(($object | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

function Get-BrowserSessions {
  Update-BrowserTabs
  $list = @()
  foreach ($session in $manager.GetSessions()) {
    if ($session.SourceAppUserModelId -notmatch $browserPattern) { continue }
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $title = [string]$props.Title
    $artist = [string]$props.Artist
    $status = [string]$session.GetPlaybackInfo().PlaybackStatus
    $key = "$($session.SourceAppUserModelId)|$title|$artist"
    $list += [pscustomobject]@{
      session = $session
      props = $props
      title = $title
      artist = $artist
      status = $status
      soundCloud = (Test-SoundCloud $title $artist $status $key)
    }
  }
  return ,$list
}

# Chrome publishes one session per playing tab. SoundCloud sessions come first; then keep
# following the tab already shown, else prefer playing sessions that name an artist. A session
# picked in the player overrides all of this.
function Select-Entry($entries) {
  if ($entries.Count -eq 0) { return $null }
  if ($script:pinnedIndex -ge 0 -and $script:pinnedIndex -lt $entries.Count) { return $entries[$script:pinnedIndex] }
  $best = $null
  $bestScore = -1
  for ($i = 0; $i -lt $entries.Count; $i++) {
    $entry = $entries[$i]
    $score = 0
    if ($entry.soundCloud) { $score += 10 }
    if ($entry.status -eq 'Playing') { $score += 4 }
    if ($entry.artist) { $score += 3 }
    if ($entry.title -and $entry.title -eq $script:lastTitle) { $score += 2 }
    if ($entry.status -eq 'Paused') { $score += 1 }
    if ($score -gt $bestScore) { $best = $entry; $bestScore = $score }
  }
  return $best
}

function Read-Artwork($reference) {
  $stream = Await ($reference.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $netStream = $asStreamForRead.Invoke($null, @($stream))
  try {
    $memory = New-Object System.IO.MemoryStream
    $netStream.CopyTo($memory)
    $bytes = $memory.ToArray()
    if ($bytes.Length -eq 0 -or $bytes.Length -gt 4MB) { return $null }
    $type = 'image/png'
    if ($bytes.Length -gt 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { $type = 'image/jpeg' }
    @{ contentType = $type; base64 = [Convert]::ToBase64String($bytes) }
  } finally {
    $netStream.Dispose()
  }
}

function Send-MediaCommand($session, $message) {
  if ($message.command -eq 'select') {
    $script:pinnedIndex = [int]$message.index
    return $true
  }
  if (-not $session) { return $false }
  switch ($message.command) {
    'toggle' { return Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
    'play' { return Await ($session.TryPlayAsync()) ([bool]) }
    'pause' { return Await ($session.TryPauseAsync()) ([bool]) }
    'next' { return Await ($session.TrySkipNextAsync()) ([bool]) }
    'previous' { return Await ($session.TrySkipPreviousAsync()) ([bool]) }
    'seek' {
      $ticks = [long]([double]$message.positionMs * 10000)
      return Await ($session.TryChangePlaybackPositionAsync($ticks)) ([bool])
    }
  }
  return $false
}

$lastState = ''
$lastArtworkKey = ''
$script:lastTitle = ''
$script:pinnedIndex = -1
$lastSentAt = [DateTime]::MinValue

while ($true) {
  try {
    $entries = Get-BrowserSessions
    $entry = Select-Entry $entries
    $session = if ($entry) { $entry.session } else { $null }

    while ($pendingLine.IsCompleted) {
      $line = $pendingLine.Result
      if ($null -eq $line) { exit 0 }
      if ($line.Trim()) {
        $message = $line | ConvertFrom-Json
        $ok = $false
        try { $ok = [bool](Send-MediaCommand $session $message) } catch { $ok = $false }
        Write-Line @{ type = 'result'; command = $message.command; ok = $ok }
      }
      $pendingLine = $stdin.ReadLineAsync()
    }

    $sessionList = @()
    for ($i = 0; $i -lt $entries.Count; $i++) {
      $sessionList += @{ index = $i; title = $entries[$i].title; artist = $entries[$i].artist; status = $entries[$i].status; soundCloud = [bool]$entries[$i].soundCloud; selected = ($entries[$i] -eq $entry) }
    }
    if (-not $session) {
      $state = @{ type = 'state'; available = $false; sessions = $sessionList; pinned = ($script:pinnedIndex -ge 0) }
    } else {
      $props = $entry.props
      $script:lastTitle = $entry.title
      $timeline = $session.GetTimelineProperties()
      $playback = $session.GetPlaybackInfo()
      $status = [string]$playback.PlaybackStatus
      # Browsers report the position at their last update; bring it up to now while playing.
      $positionMs = $timeline.Position.TotalMilliseconds
      if ($status -eq 'Playing' -and $timeline.LastUpdatedTime.Year -gt 2000) {
        $positionMs += ([DateTimeOffset]::Now - $timeline.LastUpdatedTime).TotalMilliseconds
      }
      $durationMs = ($timeline.EndTime - $timeline.StartTime).TotalMilliseconds
      if ($durationMs -gt 0) { $positionMs = [Math]::Min($positionMs, $durationMs) }
      $key = "$($session.SourceAppUserModelId)|$($props.Title)|$($props.Artist)"
      $state = @{
        type = 'state'
        available = $true
        app = $session.SourceAppUserModelId
        key = $key
        title = $props.Title
        artist = $props.Artist
        album = $props.AlbumTitle
        status = $status
        positionMs = [Math]::Max(0, [Math]::Round($positionMs))
        durationMs = [Math]::Max(0, [Math]::Round($durationMs))
        canToggle = [bool]$playback.Controls.IsPlayPauseToggleEnabled
        canNext = [bool]$playback.Controls.IsNextEnabled
        canPrevious = [bool]$playback.Controls.IsPreviousEnabled
        canSeek = [bool]$playback.Controls.IsPlaybackPositionEnabled
        soundCloud = [bool]$entry.soundCloud
        sessions = $sessionList
        pinned = ($script:pinnedIndex -ge 0)
      }
      if ($key -ne $lastArtworkKey -and $props.Thumbnail) {
        $lastArtworkKey = $key
        $artwork = $null
        try { $artwork = Read-Artwork $props.Thumbnail } catch { $artwork = $null }
        if ($artwork) { Write-Line @{ type = 'artwork'; key = $key; contentType = $artwork.contentType; base64 = $artwork.base64 } }
      }
    }

    # Positions change every poll; compare without them and still send once a second.
    $comparable = ($state.Clone())
    $comparable.Remove('positionMs')
    $signature = $comparable | ConvertTo-Json -Compress
    if ($signature -ne $lastState -or ([DateTime]::UtcNow - $lastSentAt).TotalMilliseconds -ge 1000) {
      $lastState = $signature
      $lastSentAt = [DateTime]::UtcNow
      Write-Line $state
    }
  } catch {
    Write-Line @{ type = 'error'; message = $_.Exception.Message }
    Start-Sleep -Milliseconds 1000
  }
  Start-Sleep -Milliseconds 250
}
