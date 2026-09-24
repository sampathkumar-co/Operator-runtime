Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$raw = [Console]::In.ReadToEnd()
try {
  $request = $raw | ConvertFrom-Json
} catch {
  [Console]::Out.Write("closed")
  exit 1
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Mecord Connect"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(680, 430)
$form.MinimumSize = New-Object System.Drawing.Size(680, 430)
$form.MaximumSize = New-Object System.Drawing.Size(680, 430)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = "ChatGPT needs permission"
$title.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 16)
$title.Location = New-Object System.Drawing.Point(24, 20)
$title.Size = New-Object System.Drawing.Size(610, 36)
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "Review the local action before Mecord continues."
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(90, 90, 90)
$subtitle.Location = New-Object System.Drawing.Point(26, 60)
$subtitle.Size = New-Object System.Drawing.Size(610, 26)
$form.Controls.Add($subtitle)

$details = New-Object System.Windows.Forms.TextBox
$details.Multiline = $true
$details.ReadOnly = $true
$details.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$details.BackColor = [System.Drawing.Color]::FromArgb(248, 248, 248)
$details.Location = New-Object System.Drawing.Point(28, 100)
$details.Size = New-Object System.Drawing.Size(610, 150)
$details.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
$target = if ($request.target) { [string]$request.target } else { "(no file or window target)" }
$details.Text = "Action: $($request.capability)`r`nRisk: $($request.risk)`r`nTarget: $target"
$form.Controls.Add($details)

$sessionNote = New-Object System.Windows.Forms.Label
$sessionNote.Text = "Allow Session applies only to this Mecord runtime, account/device authority, and authorized root/capability scope. Security boundaries remain enforced."
$sessionNote.ForeColor = [System.Drawing.Color]::FromArgb(80, 80, 80)
$sessionNote.Location = New-Object System.Drawing.Point(28, 266)
$sessionNote.Size = New-Object System.Drawing.Size(610, 52)
$form.Controls.Add($sessionNote)

$deny = New-Object System.Windows.Forms.Button
$deny.Text = "Deny"
$deny.Size = New-Object System.Drawing.Size(120, 42)
$deny.Location = New-Object System.Drawing.Point(248, 330)
$deny.DialogResult = [System.Windows.Forms.DialogResult]::No
$form.Controls.Add($deny)

$once = New-Object System.Windows.Forms.Button
$once.Text = "Approve Once"
$once.Size = New-Object System.Drawing.Size(125, 42)
$once.Location = New-Object System.Drawing.Point(378, 330)
$once.DialogResult = [System.Windows.Forms.DialogResult]::Yes
$form.Controls.Add($once)

$session = New-Object System.Windows.Forms.Button
$session.Text = "Allow Session"
$session.Size = New-Object System.Drawing.Size(130, 42)
$session.Location = New-Object System.Drawing.Point(508, 330)
$session.BackColor = [System.Drawing.Color]::FromArgb(0, 120, 212)
$session.ForeColor = [System.Drawing.Color]::White
$session.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$session.Add_Click({
  $form.Tag = "session"
  $form.Close()
})
$form.Controls.Add($session)

$form.AcceptButton = $once
$form.CancelButton = $deny

$result = $form.ShowDialog()
if ($form.Tag -eq "session") {
  [Console]::Out.Write("session")
} elseif ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
  [Console]::Out.Write("approve")
} elseif ($result -eq [System.Windows.Forms.DialogResult]::No) {
  [Console]::Out.Write("deny")
} else {
  [Console]::Out.Write("closed")
}
