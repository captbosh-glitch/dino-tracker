#!/bin/bash
# Backup timer for the news collector. GitHub's own schedule rarely fires, so
# this Mac runs the same job every 3 hours while it's awake (and once on wake
# if it missed one).
#
#   bash tools/mac-timer.sh install     set it up (and run it once now)
#   bash tools/mac-timer.sh uninstall   remove it
#   bash tools/mac-timer.sh run         what the timer runs
#
# It keeps its own copy of the repo in ~/Library/Application Support, so it
# never touches this working copy (and macOS lets it run outside Desktop).
set -u
DIR="$HOME/Library/Application Support/DinoTrackerNews"
LABEL=com.patdavid.dinotracker-news
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-}" in
install)
  mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
  [ -d "$DIR/repo" ] || git clone -q https://github.com/captbosh-glitch/dino-tracker.git "$DIR/repo" || exit 1
  cp "$0" "$DIR/mac-timer.sh" && chmod +x "$DIR/mac-timer.sh"
  cat > "$PLIST" <<E
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/mac-timer.sh</string><string>run</string></array>
  <key>StartInterval</key><integer>10800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/log.txt</string>
  <key>StandardErrorPath</key><string>$DIR/log.txt</string>
</dict></plist>
E
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "Installed. Log: $DIR/log.txt"
  ;;
uninstall)
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  rm -f "$PLIST" && echo "Removed the timer. (Its repo copy is in $DIR.)"
  ;;
run)
  cd "$DIR/repo" || exit 1
  echo "=== $(date -u +'%Y-%m-%d %H:%M UTC')"
  git fetch -q origin && git reset -q --hard origin/main || exit 1
  /usr/bin/python3 tools/news.py || exit 1
  git add data/news.json data/news-articles.json
  if git diff --cached --quiet; then echo "No changes."; exit 0; fi
  git -c user.name=dinotracker-bot -c user.email=actions@users.noreply.github.com \
    commit -q -m "News update $(date -u +'%Y-%m-%d %H:%M UTC') (Mac)"
  for i in 1 2 3; do
    git push -q origin HEAD:main && { echo "Pushed."; exit 0; }
    git pull -q --rebase origin main
  done
  echo "Push failed."; exit 1
  ;;
*) echo "Usage: bash tools/mac-timer.sh install|uninstall|run"; exit 1 ;;
esac
