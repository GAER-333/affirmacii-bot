<#
  Озвучка готовых фраз через ElevenLabs.

  Берёт фразы из data.js, отправляет их в ElevenLabs и сохраняет mp3
  в audio/<время>/NN.mp3 — ровно туда, где их ищет приложение.
  Уже озвученные файлы пропускает (чтобы не платить дважды).

  Настройки (ключ, голос) — в файле .env в корне проекта. Образец — .env.example.

  Примеры:
    Показать, что будет озвучено, ничего не отправляя:
      powershell -ExecutionPolicy Bypass -File tools\voice.ps1 -DryRun
    Озвучить все наборы:
      powershell -ExecutionPolicy Bypass -File tools\voice.ps1
    Только ночь:
      powershell -ExecutionPolicy Bypass -File tools\voice.ps1 -Time night
    Переозвучить фразы 3 и 5 утра (например, после правки текста):
      powershell -ExecutionPolicy Bypass -File tools\voice.ps1 -Time morning -Only 3,5 -Force
#>
param(
  [ValidateSet('all', 'morning', 'day', 'night')] [string]$Time = 'all',
  [string]$Only,     # номера фраз через запятую (с 1), если нужно не всё: -Only 3,5
  [switch]$Force,    # озвучить заново, даже если файл уже есть
  [switch]$DryRun    # только показать список, без запросов к ElevenLabs
)
$ErrorActionPreference = 'Stop'
$onlyNums = @(); if ($Only) { $onlyNums = @($Only -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [int]$_ }) }
function Fail($text) { Write-Host $text -ForegroundColor Red; exit 1 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path $PSScriptRoot -Parent

# --- Настройки из .env ---
$cfg = @{}
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  Get-Content $envFile -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2].Trim('"') }
  }
}
function Setting($name, $default) { if ($cfg[$name]) { $cfg[$name] } else { $default } }

$apiKey    = Setting 'ELEVENLABS_API_KEY' ''
$model     = Setting 'ELEVENLABS_MODEL' 'eleven_multilingual_v2'
$stability = [double](Setting 'STABILITY' '0.6')
$speed     = [double](Setting 'SPEED' '0.9')

# --- Фразы из data.js ---
$data = Get-Content (Join-Path $root 'data.js') -Raw -Encoding UTF8
$sets = @{}
foreach ($m in [regex]::Matches($data, '(morning|day|night):\s*\{.*?phrases:\s*\[(.*?)\]', 'Singleline')) {
  $sets[$m.Groups[1].Value] = @([regex]::Matches($m.Groups[2].Value, "'((?:[^'\\]|\\.)*)'") |
    ForEach-Object { $_.Groups[1].Value -replace "\\'", "'" })
}

# --- Что озвучивать ---
$times = if ($Time -eq 'all') { @('morning', 'day', 'night') } else { @($Time) }
$todo = @()
$skipped = 0
foreach ($t in $times) {
  $voice = Setting ('VOICE_ID_' + $t.ToUpper()) (Setting 'VOICE_ID' '')
  $list = $sets[$t]
  for ($i = 0; $i -lt $list.Count; $i++) {
    $n = $i + 1
    if ($onlyNums.Count -and ($onlyNums -notcontains $n)) { continue }
    $file = Join-Path $root ('audio\{0}\{1:D2}.mp3' -f $t, $n)
    if ((Test-Path $file) -and -not $Force) { $skipped++; continue }
    $todo += [pscustomobject]@{ Time = $t; N = $n; Text = $list[$i]; File = $file; Voice = $voice }
  }
}

$chars = 0
$todo | ForEach-Object { $chars += $_.Text.Length }
Write-Host ("Фраз к озвучке: {0} ({1} символов). Уже есть и пропущено: {2}." -f $todo.Count, $chars, $skipped)

if ($DryRun) {
  $todo | ForEach-Object { Write-Host ('  {0}/{1:D2}.mp3  {2}' -f $_.Time, $_.N, $_.Text) }
  Write-Host 'Это была проверка (-DryRun): в ElevenLabs ничего не отправлено.'
  exit 0
}
if ($todo.Count -eq 0) { Write-Host 'Нечего озвучивать.'; exit 0 }
if (-not $apiKey) { Fail 'Нет ключа: впишите ELEVENLABS_API_KEY в файл .env (образец — .env.example).' }
$noVoice = $todo | Where-Object { -not $_.Voice } | Select-Object -First 1
if ($noVoice) { Fail "Не задан голос: впишите VOICE_ID в файл .env (или VOICE_ID_$($noVoice.Time.ToUpper()))." }

# --- Озвучка ---
$done = 0
foreach ($item in $todo) {
  New-Item -ItemType Directory -Force -Path (Split-Path $item.File) | Out-Null
  $body = @{
    text           = $item.Text
    model_id       = $model
    voice_settings = @{ stability = $stability; similarity_boost = 0.75; style = 0; use_speaker_boost = $true; speed = $speed }
  } | ConvertTo-Json -Depth 3
  $uri = "https://api.elevenlabs.io/v1/text-to-speech/$($item.Voice)?output_format=mp3_44100_128"
  Write-Host ('[{0}/{1}] {2}/{3:D2}.mp3  {4}' -f ($done + 1), $todo.Count, $item.Time, $item.N, $item.Text)
  try {
    Invoke-WebRequest -Uri $uri -Method Post -UseBasicParsing `
      -Headers @{ 'xi-api-key' = $apiKey; 'Accept' = 'audio/mpeg' } `
      -ContentType 'application/json; charset=utf-8' `
      -Body ([Text.Encoding]::UTF8.GetBytes($body)) -OutFile $item.File
    # Проверяем, что пришёл звук, а не страница с ошибкой (так ElevenLabs отвечает при блокировке по стране)
    $head = [IO.File]::ReadAllBytes($item.File) | Select-Object -First 3
    $isMp3 = ($head[0] -eq 0x49 -and $head[1] -eq 0x44 -and $head[2] -eq 0x33) -or ($head[0] -eq 0xFF -and ($head[1] -band 0xE0) -eq 0xE0)
    if (-not $isMp3) {
      $text = [IO.File]::ReadAllText($item.File, [Text.Encoding]::UTF8)
      Remove-Item $item.File
      if ($text -match 'Access restricted') { Fail 'ElevenLabs заблокировал доступ с этого подключения (ограничение по стране). Озвучка не выполнена.' }
      Fail ('ElevenLabs вернул не звук, а: ' + ($text -replace '<[^>]+>', ' ' -replace '\s+', ' ').Substring(0, [Math]::Min(300, $text.Length)))
    }
    $done++
  } catch {
    if (Test-Path $item.File) { Remove-Item $item.File }
    $msg = $_.Exception.Message
    $resp = $_.Exception.Response
    if ($resp) {
      try { $msg = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch {}
    }
    Write-Host "Ошибка ElevenLabs: $msg" -ForegroundColor Red
    Write-Host "Озвучено до ошибки: $done. Запустите скрипт снова — готовые файлы он пропустит."
    exit 1
  }
}
Write-Host "Готово: озвучено $done фраз." -ForegroundColor Green
