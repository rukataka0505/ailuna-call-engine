# backup.ps1

# 0. Pre-checks
$branch = git branch --show-current
if ([string]::IsNullOrWhiteSpace($branch)) {
    Write-Error "Error: Could not determine current branch (detached HEAD?). Aborting backup."
    exit 1
}

$remote = git remote get-url origin
if ($LASTEXITCODE -ne 0) {
    Write-Error "Error: Remote 'origin' not found. Aborting backup."
    exit 1
}

Write-Host "Current Branch: $branch" -ForegroundColor Cyan
Write-Host "Remote URL:     $remote" -ForegroundColor DarkGray
Write-Host "----------------------------------------"

# 1. Check for changes
$status = git status --porcelain
if (-not $status) {
    Write-Host "No changes to backup." -ForegroundColor Yellow
    exit 0
}

# 2. Add all changes
Write-Host "Changes detected. Staging files..." -ForegroundColor Cyan
git add .

# 3. Commit with timestamp
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$message = "backup: auto-backup on $timestamp"
Write-Host "Committing with message: '$message'..." -ForegroundColor Cyan
git commit -m "$message"

# 4. Pull changes from main to avoid conflicts
Write-Host "Pulling latest changes from origin/main..." -ForegroundColor Cyan
git pull origin main --no-edit
if ($LASTEXITCODE -ne 0) {
    Write-Error "Merge conflict detected during pull. Please resolve conflicts manually and then run backup again."
    exit 1
}

# 5. Push to remote main
Write-Host "Pushing to origin main..." -ForegroundColor Cyan
git push origin HEAD:main

if ($LASTEXITCODE -eq 0) {
    $commitHash = git rev-parse --short HEAD
    Write-Host "----------------------------------------"
    Write-Host "Backup completed successfully!" -ForegroundColor Green
    Write-Host "Pushed to: origin/main" -ForegroundColor Green
    Write-Host "Commit:    $commitHash" -ForegroundColor Green
}
else {
    Write-Error "Backup failed during push. Please check your network or git configuration."
    exit 1
}
