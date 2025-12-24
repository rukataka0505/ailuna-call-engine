# backup.ps1 - Simple GitHub push script

# 1. Check for changes
$status = git status --porcelain
if (-not $status) {
    Write-Host "No changes to backup." -ForegroundColor Yellow
    exit 0
}

# 2. Add all changes
Write-Host "Staging files..." -ForegroundColor Cyan
git add .

# 3. Commit with timestamp
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$message = "backup: $timestamp"
Write-Host "Committing: '$message'" -ForegroundColor Cyan
git commit -m "$message"

# 4. Push to remote
Write-Host "Pushing to origin..." -ForegroundColor Cyan
git push --force

if ($LASTEXITCODE -eq 0) {
    Write-Host "Backup completed!" -ForegroundColor Green
}
else {
    Write-Error "Push failed."
    exit 1
}
