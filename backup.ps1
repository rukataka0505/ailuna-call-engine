# backup.ps1

# 1. Check for changes
$status = git status --porcelain
if (-not $status) {
    Write-Host "No changes to backup." -ForegroundColor Yellow
    exit
}

# 2. Add all changes
Write-Host "Changes detected. Staging files..." -ForegroundColor Cyan
git add .

# 3. Commit with timestamp
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$message = "backup: auto-backup on $timestamp"
Write-Host "Committing with message: '$message'..." -ForegroundColor Cyan
git commit -m "$message"

# 4. Push to remote
Write-Host "Pushing to origin main..." -ForegroundColor Cyan
git push origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "Backup completed successfully!" -ForegroundColor Green
} else {
    Write-Host "Backup failed during push. Please check your network or git configuration." -ForegroundColor Red
}
