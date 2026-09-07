# Fallback SMTC poller for machines without Python + winsdk.
# Prints one JSON line per poll on stdout, same contract as nowplaying.py.
# Consumed by media-bridge.js.
#
# Album art IS supported here, but session enumeration is simplified: this script
# follows whatever SMTC calls the current session and does not honour
# preferredApp / ignoredApps. Install Python + winsdk for full behaviour.

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT IAsyncOperation<T> has no synchronous wait in PowerShell; reflect out the
# generic AsTask extension method and await through the TPL instead.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

function AppLabel($session) {
    $raw = [string]$session.SourceAppUserModelId
    $label = $raw
    if ($label.Contains('!')) { $label = $label.Split('!')[0] }
    if ($label.Contains('_') -and $label.Contains('.')) {
        $label = $label.Split('_')[0]
        if ($label.Contains('.')) { $label = $label.Split('.')[-1] }
    }
    if ($label.ToLower().EndsWith('.exe')) { $label = $label.Substring(0, $label.Length - 4) }
    if ($label) { return $label }
    return $raw
}

$lastKey = ''
$lastArt = ''

while ($true) {
    $out = [ordered]@{
        title = ''; artist = ''; album = ''; status = 'stopped'
        position = 0.0; duration = 0.0; art = ''
        session = $null; sessions = @()
    }

    try {
        $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
        $session = $mgr.GetCurrentSession()

        if ($session) {
            $label = AppLabel $session
            $status = ([string]$session.GetPlaybackInfo().PlaybackStatus).ToLower()
            $out.session = @{ id = $label; app = $label }
            $out.sessions = @(@{ id = $label; app = $label; status = $status })
            $out.status = $status

            $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $out.title = [string]$props.Title
            $out.artist = [string]$props.Artist
            $out.album = [string]$props.AlbumTitle

            # Timeline is often absent or zeroed — many apps publish metadata but
            # no position. Leave 0/0 and let the overlay hide the progress bar.
            #
            # Position is a snapshot, not a live clock: it is whatever the app last
            # pushed via UpdateTimelineProperties. LastUpdatedTime says when, so
            # the real position while playing is position + (now - lastUpdated).
            # Without that correction, starting up mid-track reads the value from
            # track start and is behind by however long it had been playing.
            try {
                $tl = $session.GetTimelineProperties()
                $startS = $tl.StartTime.TotalSeconds
                $pos = [Math]::Max(0.0, $tl.Position.TotalSeconds - $startS)

                $dur = [Math]::Max(0.0, $tl.EndTime.TotalSeconds - $startS)
                if ($dur -le 0) { $dur = [Math]::Max(0.0, $tl.MaxSeekTime.TotalSeconds - $startS) }

                if ($out.status -eq 'playing' -and $tl.LastUpdatedTime.Year -gt 1601) {
                    $age = ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds
                    if ($age -ge 0 -and $age -lt 86400) { $pos += $age }
                }
                if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }

                $out.position = $pos
                $out.duration = $dur
            } catch { }

            # Only fetch album art when the track changes, then cache it so every
            # update for this track still carries it.
            $key = "$label|$($out.title)|$($out.artist)"
            if ($key -ne $lastKey) {
                $lastArt = ''
                if ($props.Thumbnail) {
                    try {
                        $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
                        $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
                        $ms = New-Object System.IO.MemoryStream
                        $netStream.CopyTo($ms)
                        $mime = [string]$stream.ContentType
                        if (-not $mime.StartsWith('image/')) { $mime = 'image/jpeg' }
                        $lastArt = "data:$mime;base64," + [Convert]::ToBase64String($ms.ToArray())
                        $ms.Dispose(); $netStream.Dispose(); $stream.Dispose()
                    } catch {
                        # No art available — not fatal
                    }
                }
                $lastKey = $key
            }
            $out.art = $lastArt
        } else {
            $lastKey = ''
            $lastArt = ''
        }
    } catch {
        # No session, or a transient WinRT error (a media app exiting mid-call
        # surfaces as RPC_E_DISCONNECTED). Report stopped and keep polling.
        Write-Output (ConvertTo-Json @{ error = [string]$_.Exception.Message } -Compress)
    }

    Write-Output (ConvertTo-Json $out -Compress -Depth 4)
    Start-Sleep -Seconds 1
}
