param(
  [string]$WsUrl = "ws://localhost:8787/ingest",
  [string]$Source = ""
)

Write-Error "Spout adapter scaffold started for $WsUrl."
if ($Source -ne "") {
  Write-Error "Requested Spout sender: $Source"
}
Write-Error "Live Spout frame capture is not implemented in this scaffold yet."
exit 2
