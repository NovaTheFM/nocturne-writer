param(
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [Parameter(Mandatory = $true)][string]$SignalPath
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NocturneReadyWindow {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Nocturne Writer — исправления готовы'
$form.ClientSize = New-Object System.Drawing.Size(570, 280)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.Icon = [System.Drawing.SystemIcons]::Information
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 26, 32)
$form.ForeColor = [System.Drawing.Color]::FromArgb(236, 237, 242)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 11)
$title = New-Object System.Windows.Forms.Label
$title.Text = 'Можно смотреть и тестировать'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(24, 22)
$title.Size = New-Object System.Drawing.Size(525, 40)
$form.Controls.Add($title)
$description = New-Object System.Windows.Forms.Label
$description.Text = "Исправлены 8 пунктов из последнего разбора.`r`n`r`nСлева «до», справа «после». Записи и APNG в 60 FPS, пауза, замедление, шаг по кадрам и переключение исправлений. Приложение готово к проверке."
$description.Location = New-Object System.Drawing.Point(26, 75)
$description.Size = New-Object System.Drawing.Size(520, 115)
$form.Controls.Add($description)
function Add-ReadyButton($text, $x, $width, $action) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $text
    $button.Location = New-Object System.Drawing.Point($x, 215)
    $button.Size = New-Object System.Drawing.Size($width, 42)
    $button.FlatStyle = 'Flat'
    $button.BackColor = [System.Drawing.Color]::FromArgb(48, 42, 64)
    $button.Add_Click($action)
    $form.Controls.Add($button)
    return $button
}
$reportButton = Add-ReadyButton 'Открыть сравнение' 24 210 { Start-Process -FilePath $ReportPath }
$appButton = Add-ReadyButton 'Приложение' 246 165 { Start-Process 'http://localhost:5173' }
$closeButton = Add-ReadyButton 'Закрыть' 423 120 { $form.Close() }
$form.AcceptButton = $reportButton
$form.CancelButton = $closeButton
$form.Add_Shown({
    [void][NocturneReadyWindow]::ShowWindow($form.Handle, 5)
    [void][NocturneReadyWindow]::SetForegroundWindow($form.Handle)
    $form.Activate()
    $form.BringToFront()
    [System.Media.SystemSounds]::Exclamation.Play()
    if ([NocturneReadyWindow]::IsWindowVisible($form.Handle)) {
        [System.IO.File]::WriteAllText($SignalPath, "shown $([DateTime]::UtcNow.ToString('o')) pid=$PID", [System.Text.Encoding]::UTF8)
    }
})
try { [void]$form.ShowDialog() } finally { $form.Dispose() }
